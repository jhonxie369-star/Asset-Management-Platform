import { v4 as uuid } from 'uuid';
import type { Task, Run, Result, Asset, LiveEndpoint, Service, AssetList, AssetListEntry } from '@sasp/shared';
import { entryToObject } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { EnrichmentPipeline } from '../pipeline/enrichment.js';
import type { IModule, ModuleContext } from './module-interface.js';

export class TaskEngine {
  private modules = new Map<string, IModule>();

  constructor(private store: Store, private pipeline: EnrichmentPipeline) {}

  registerModule(mod: IModule) {
    this.modules.set(mod.definition.id, mod);
    this.store.upsert('modules', mod.definition);
  }

  getModules(): IModule[] {
    return [...this.modules.values()];
  }

  async executeTask(task: Task): Promise<Run[]> {
    const runningTask = (this.store.getAll('tasks') as Task[]).find(t => t.status === 'running');
    if (runningTask) {
      throw new Error(`已有任务运行中: ${runningTask.name} (${runningTask.id.slice(0, 8)})，本次执行已阻止，避免资源抢占`);
    }

    const taskRunId = uuid();
    this.store.update('tasks', task.id, { status: 'running', lastRunAt: new Date().toISOString() });
    const runs: Run[] = [];

    // 串行链 scope
    let scopedEndpointIds: Set<string> | undefined = undefined;
    let scopedServiceIds: Set<string> | undefined = undefined;

    for (const moduleId of task.modules) {
      const mod = this.modules.get(moduleId);
      if (!mod) continue;

      const targets = this.resolveTargets(task, mod, scopedEndpointIds, scopedServiceIds);

      const run: Run = {
        id: uuid(),
        taskRunId,
        taskId: task.id,
        taskName: task.name,
        moduleId,
        status: 'running',
        targetSnapshot: mod.definition.targetType === 'endpoint'
          ? targets.endpoints.map(e => e.id)
          : mod.definition.targetType === 'service'
            ? targets.services.map(s => s.id)
            : targets.assets.map(a => a.id),
        configSnapshot: task.config,
        counters: { total: 0, success: 0, failed: 0 },
        startedAt: new Date().toISOString(),
      };
      this.store.insert('runs', run);

      const producedEndpointIds = new Set<string>();
      const producedServiceIds = new Set<string>();
      let lastProgressSavedAt = Date.now();

      try {
        // 命名空间 config:task.config[moduleId] 优先,回退到扁平 task.config
        const nsCfg = (task.config as any)?.[moduleId];
        const moduleConfig = (nsCfg && typeof nsCfg === 'object')
          ? { ...task.config, ...nsCfg }
          : task.config;

        const ctx: ModuleContext = {
          run,
          assets: targets.assets,
          endpoints: targets.endpoints,
          services: targets.services,
          config: moduleConfig,
          scopedEndpointIds,
          scopedServiceIds,
        };

        for await (const result of mod.execute(ctx)) {
          result.id = result.id || uuid();
          result.runId = run.id;
          result.moduleId = moduleId;
          result.createdAt = result.createdAt || new Date().toISOString();
          await this.pipeline.process(result);

          // 记录产出，给下游 scope 用
          if (result.resultType === 'endpoint_alive') {
            const d = result.data as any;
            const ep = this.store.query('liveEndpoints', (e: any) =>
              (e.host || e.ip) === (d.host || d.ip) && e.port === d.port
            )[0] as LiveEndpoint | undefined;
            if (ep) producedEndpointIds.add(ep.id);
          } else if (result.resultType === 'service_identified') {
            if (result.endpointId) {
              const svc = this.store.query('services', (s: any) => s.endpointId === result.endpointId)[0] as Service | undefined;
              if (svc) producedServiceIds.add(svc.id);
            }
          }

          run.counters.total++;
          run.counters.success++;
          const nowMs = Date.now();
          if (run.counters.total % 10 === 0 || nowMs - lastProgressSavedAt > 5000) {
            this.store.update('runs', run.id, run);
            lastProgressSavedAt = nowMs;
          }
        }

        run.status = 'completed';
        run.finishedAt = new Date().toISOString();
      } catch (err: any) {
        run.status = 'failed';
        run.error = err.message;
        run.finishedAt = new Date().toISOString();
        run.counters.failed++;
      }

      this.store.update('runs', run.id, run);
      runs.push(run);

      // port-discovery 跑完后做"消失 sweep":
      // 本次目标 asset 范围内的 endpoint,如果端口在本次扫描范围内但 lastSeenAt 早于 run.startedAt
      // → 标记 disappearedAt,后续不再被扫描模块拿去打,Findings 上也能区分历史/现存
      if (moduleId === 'port-discovery' && run.status === 'completed') {
        try {
          const swept = this.sweepDisappearedEndpoints(run, targets.assets, task.config);
          if (swept > 0) console.log(`[task-engine] sweep: ${swept} 个 endpoint 标为 disappeared`);
        } catch (err: any) {
          console.warn('[task-engine] sweep 失败:', err.message);
        }
      }
      if (moduleId === 'dirsearch' && run.status === 'completed') {
        try {
          const swept = this.sweepDisappearedWebPaths(run, targets.endpoints);
          if (swept > 0) console.log(`[task-engine] sweep: ${swept} 个 webPath 标为 disappeared`);
        } catch (err: any) {
          console.warn('[task-engine] webPath sweep 失败:', err.message);
        }
      }

      // 更新 scope 给下游
      if (producedEndpointIds.size > 0) scopedEndpointIds = producedEndpointIds;
      if (producedServiceIds.size > 0) scopedServiceIds = producedServiceIds;
    }

    this.store.update('tasks', task.id, { status: 'completed' });
    return runs;
  }

  /**
   * 把"本次该扫到但没活"的 endpoint 标 disappearedAt
   * 触发条件:本次 task 的目标资产 × 本次端口配置 这个范围内,且 lastSeenAt < run.startedAt
   */
  private sweepDisappearedEndpoints(run: Run, assets: Asset[], taskConfig: any): number {
    const startedAt = new Date(run.startedAt).getTime();
    const now = new Date().toISOString();
    // 端口范围:port-discovery 的 ports 在 taskConfig['port-discovery'].ports 或 taskConfig.ports
    const pdCfg = (taskConfig?.['port-discovery'] && typeof taskConfig['port-discovery'] === 'object')
      ? taskConfig['port-discovery'] : taskConfig;
    const ports: number[] = Array.isArray(pdCfg?.ports) ? pdCfg.ports : [];
    if (ports.length === 0 || assets.length === 0) return 0;
    const portSet = new Set(ports);
    const assetIds = new Set(assets.map(a => a.id));

    const eps = this.store.getAll('liveEndpoints') as LiveEndpoint[];
    let count = 0;
    for (const ep of eps) {
      if (!assetIds.has(ep.assetId)) continue;
      if (!portSet.has(ep.port)) continue;
      if (ep.disappearedAt) continue;  // 已标过
      const lastSeen = new Date(ep.lastSeenAt).getTime();
      if (lastSeen >= startedAt) continue;  // 本次扫到了
      this.store.update('liveEndpoints', ep.id, { alive: false, disappearedAt: now });
      count++;
    }
    return count;
  }

  private sweepDisappearedWebPaths(run: Run, endpoints: LiveEndpoint[]): number {
    const startedAt = new Date(run.startedAt).getTime();
    const now = new Date().toISOString();
    if (endpoints.length === 0) return 0;
    const endpointIds = new Set(endpoints.map(e => e.id));
    const services = (this.store.getAll('services') as Service[]).filter(s => endpointIds.has(s.endpointId));
    const serviceIds = new Set(services.map(s => s.id));
    if (serviceIds.size === 0) return 0;
    const paths = this.store.getAll('webPaths') as any[];
    let count = 0;
    for (const wp of paths) {
      if (!serviceIds.has(wp.serviceId)) continue;
      if (wp.disappearedAt) continue;
      const lastSeen = new Date(wp.lastSeenAt).getTime();
      if (lastSeen >= startedAt) continue;
      this.store.update('webPaths', wp.id, { disappearedAt: now } as any);
      count++;
    }
    return count;
  }

  private resolveTargets(
    task: Task,
    mod: IModule,
    scopedEndpointIds?: Set<string>,
    scopedServiceIds?: Set<string>,
  ): { assets: Asset[]; endpoints: LiveEndpoint[]; services: Service[] } {
    let assets: Asset[] = [];
    const sel = task.selector;
    const now = new Date().toISOString();

    // 先解析 assets
    if (sel.mode === 'by_list' && sel.assetListId) {
      const list = this.store.getById('assetLists', sel.assetListId) as AssetList | undefined;
      if (list) {
        assets = this.store.batch(() => {
          const resolved: Asset[] = [];
          const existingByKey = new Map<string, Asset>();
          for (const asset of this.store.getAll('assets') as Asset[]) {
            existingByKey.set(asset.ip, asset);
            if (asset.address) existingByKey.set(asset.address, asset);
          }
          for (const rawEntry of list.entries) {
            const entry: AssetListEntry = entryToObject(rawEntry);
            const ip = entry.ip?.trim();
            if (!ip) continue;
            const assetKind = entry.assetKind || (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? 'ip' : 'domain');
            const address = entry.address || ip;
            const existing = existingByKey.get(ip) || existingByKey.get(address);
            if (existing) {
              // List entry 是资产快照入口；保留风险/状态，同时补齐云元数据与 endpoint 字段。
              const patch: Partial<Asset> = {
                assetKind: existing.assetKind || assetKind,
                address: existing.address || address,
                hostname: entry.hostname || existing.hostname,
                endpointPort: entry.endpointPort ?? existing.endpointPort,
                endpointProtocol: entry.endpointProtocol ?? existing.endpointProtocol,
                cloudProduct: entry.cloudProduct ?? existing.cloudProduct,
                updatedAt: now,
                lastSeenAt: now,
              };
              if (entry.instanceKey && !existing.instanceKey) {
                patch.instanceKey = entry.instanceKey;
                patch.instanceRole = entry.instanceRole;
                patch.cloud = entry.cloud;
                patch.instanceName = entry.instanceName;
              }
              this.store.update('assets', existing.id, patch);
              resolved.push({ ...existing, ...patch });
            } else {
              const zone = entry.scope || (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.)/.test(ip) ? 'private' : 'public');
              const newAsset: Asset = {
                id: uuid(),
                ip,
                assetKind,
                address,
                hostname: entry.hostname,
                endpointPort: entry.endpointPort,
                endpointProtocol: entry.endpointProtocol,
                cloudProduct: entry.cloudProduct,
                zone,
                status: 'confirmed',
                tags: [`from-list:${list.name}`],
                source: 'imported',
                riskScore: 0,
                firstSeenAt: now,
                lastSeenAt: now,
                updatedAt: now,
                ...(entry.instanceKey && {
                  instanceKey: entry.instanceKey,
                  instanceRole: entry.instanceRole,
                  cloud: entry.cloud,
                  instanceName: entry.instanceName,
                }),
              };
              this.store.insert('assets', newAsset);
              existingByKey.set(newAsset.ip, newAsset);
              if (newAsset.address) existingByKey.set(newAsset.address, newAsset);
              resolved.push(newAsset);
            }
          }
          return resolved;
        });
      }
    } else {
      assets = this.store.getAll('assets') as Asset[];
      if (sel.mode === 'by_zone' && sel.zone) {
        assets = assets.filter(a => a.zone === sel.zone);
      } else if (sel.mode === 'by_ids' && sel.assetIds) {
        const ids = new Set(sel.assetIds);
        assets = assets.filter(a => ids.has(a.id));
      }
      assets = assets.filter(a => a.status === 'confirmed' || a.status === 'monitored');
    }

    const af = sel.assetFilter;
    if (af?.assetKinds?.length) {
      const kinds = new Set(af.assetKinds);
      assets = assets.filter(a => kinds.has(a.assetKind || 'ip'));
    }
    if (af?.tags?.length) {
      assets = assets.filter(a => af.tags!.every(tag => a.tags.includes(tag)));
    }
    if (af?.q) {
      const q = af.q.toLowerCase();
      assets = assets.filter(a =>
        [a.ip, a.address, a.hostname, a.business, a.owner, a.instanceName].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q))
      );
    }

    const assetIds = new Set(assets.map(a => a.id));

    // 解析 endpoints
    let endpoints: LiveEndpoint[] = [];
    if (mod.definition.targetType === 'endpoint') {
      if (scopedEndpointIds && scopedEndpointIds.size > 0) {
        endpoints = (this.store.getAll('liveEndpoints') as LiveEndpoint[]).filter(e => scopedEndpointIds.has(e.id));
      } else {
        endpoints = (this.store.getAll('liveEndpoints') as LiveEndpoint[]).filter(e => assetIds.has(e.assetId) && e.alive);
      }
    }

    // 解析 services
    let services: Service[] = [];
    if (mod.definition.targetType === 'service') {
      if (scopedServiceIds && scopedServiceIds.size > 0) {
        services = (this.store.getAll('services') as Service[]).filter(s => scopedServiceIds.has(s.id));
      } else {
        services = (this.store.getAll('services') as Service[]).filter(s => assetIds.has(s.assetId));
      }
      const sf = sel.serviceFilter;
      if (sf?.protocol) services = services.filter(s => sf.protocol!.includes(s.protocol));
      if (sf?.portRange) services = services.filter(s => s.port >= sf.portRange![0] && s.port <= sf.portRange![1]);
    }

    return { assets, endpoints, services };
  }
}
