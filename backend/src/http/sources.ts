import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { AssetList, Asset, AssetListEntry } from '@sasp/shared';
import { Store } from '../storage/store.js';
import {
  syncCloudquery, cloudqueryConfigured, SyncStrategy,
} from '../sources/cloudquery.js';

const STRATEGIES: SyncStrategy[] = ['db-scan', 'all-ip', 'db-endpoints', 'public', 'private'];

/**
 * 把结构化 entries 同步到 Asset 表:
 * - 已有 Asset:元数据有变更则更新
 * - 没有 Asset:新建(source=imported,tag=from:cloudquery)
 * 扫描管线后续发现这个 IP 时会复用已存在的 Asset
 */
function upsertAssetsFromEntries(
  store: Store,
  entries: AssetListEntry[],
): { updated: number; created: number } {
  const now = new Date().toISOString();
  let updated = 0, created = 0;
  return store.batch(() => {
    const assets = store.getAll('assets') as Asset[];
    const byKey = new Map<string, Asset>();
    for (const a of assets) {
      byKey.set(a.ip, a);
      if (a.address) byKey.set(a.address, a);
    }

    for (const e of entries) {
      const key = e.address || e.ip;
      const existing = byKey.get(key) || byKey.get(e.ip);
      if (existing) {
        const patch: Partial<Asset> = {
          assetKind: existing.assetKind || e.assetKind || (/^\d+\.\d+\.\d+\.\d+$/.test(e.ip) ? 'ip' : 'domain'),
          address: existing.address || e.address || e.ip,
          hostname: e.hostname || existing.hostname,
          endpointPort: e.endpointPort ?? existing.endpointPort,
          endpointProtocol: e.endpointProtocol ?? existing.endpointProtocol,
          cloudProduct: e.cloudProduct ?? existing.cloudProduct,
          instanceKey: e.instanceKey,
          instanceRole: e.instanceRole,
          cloud: e.cloud,
          instanceName: e.instanceName,
          lastSeenAt: now,
          updatedAt: now,
        };
        store.update('assets', existing.id, patch);
        updated++;
      } else {
        const zone = e.scope || (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.)/.test(e.ip) ? 'private' : 'public');
        const newAsset: Asset = {
          id: uuid(),
          ip: e.ip,
          assetKind: e.assetKind || (/^\d+\.\d+\.\d+\.\d+$/.test(e.ip) ? 'ip' : 'domain'),
          address: e.address || e.ip,
          hostname: e.hostname,
          endpointPort: e.endpointPort,
          endpointProtocol: e.endpointProtocol,
          cloudProduct: e.cloudProduct,
          zone,
          status: 'confirmed',
          tags: ['from:cloudquery'],
          source: 'imported',
          riskScore: 0,
          firstSeenAt: now,
          lastSeenAt: now,
          updatedAt: now,
          ...(e.instanceKey && {
            instanceKey: e.instanceKey,
            instanceRole: e.instanceRole,
            cloud: e.cloud,
            instanceName: e.instanceName,
          }),
        };
        store.insert('assets', newAsset);
        byKey.set(newAsset.ip, newAsset);
        if (newAsset.address) byKey.set(newAsset.address, newAsset);
        created++;
      }
    }
    return { updated, created };
  });
}

export function sourceRoutes(store: Store): Router {
  const r = Router();

  r.get('/cloudquery/status', (_req, res) => {
    res.json({ ok: true, data: { configured: cloudqueryConfigured(), strategies: STRATEGIES } });
  });

  // 预览:只拉数据不落库
  r.post('/cloudquery/preview', async (req, res) => {
    const strategy = req.body.strategy as SyncStrategy;
    if (!STRATEGIES.includes(strategy)) return res.status(400).json({ ok: false, error: 'invalid strategy' });
    if (!cloudqueryConfigured()) return res.status(400).json({ ok: false, error: 'cloudquery PG 未配置' });
    try {
      const r1 = await syncCloudquery(strategy);
      res.json({ ok: true, data: r1 });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 同步并落地为 AssetList
  r.post('/cloudquery/sync', async (req, res) => {
    const strategy = req.body.strategy as SyncStrategy;
    const name: string = (req.body.name || '').trim();
    const description: string | undefined = req.body.description;
    const replaceListId: string | undefined = req.body.replaceListId;
    const autoSync = req.body.autoSync as AssetList['autoSync'] | undefined;
    if (!STRATEGIES.includes(strategy)) return res.status(400).json({ ok: false, error: 'invalid strategy' });
    if (!name && !replaceListId) return res.status(400).json({ ok: false, error: '缺少名称或目标 list id' });
    if (!cloudqueryConfigured()) return res.status(400).json({ ok: false, error: 'cloudquery PG 未配置' });

    try {
      const result = await syncCloudquery(strategy);
      if (result.entries.length === 0) {
        return res.status(400).json({ ok: false, error: '未产出任何资产,请检查配置与白名单', data: result });
      }
      const now = new Date().toISOString();
      const autoSyncPatch = autoSync ? { ...autoSync, strategy, lastSyncedAt: now, lastStatus: 'ok' as const, lastEntriesCount: result.entries.length } : undefined;
      let list: AssetList;
      if (replaceListId) {
        const existing = store.getById('assetLists', replaceListId) as AssetList | undefined;
        if (!existing) return res.status(404).json({ ok: false, error: 'list 不存在' });
        const patch: any = {
          name: name || existing.name,
          description: description ?? existing.description,
          entries: result.entries,
          updatedAt: now,
        };
        if (autoSync !== undefined) patch.autoSync = autoSyncPatch;
        store.update('assetLists', replaceListId, patch);
        list = store.getById('assetLists', replaceListId) as AssetList;
      } else {
        list = {
          id: uuid(), name,
          description: description || `CloudQuery 同步(${strategy}) · ${now.slice(0, 16)}`,
          entries: result.entries, builtin: false,
          createdAt: now, updatedAt: now,
          autoSync: autoSyncPatch,
        };
        store.insert('assetLists', list);
      }

      // entries 已经带 instanceKey 等机器元数据,直接 upsert 到 Asset 表
      try {
        const r = upsertAssetsFromEntries(store, result.entries);
        console.log(`[sync ${strategy}] asset upsert: updated=${r.updated} created=${r.created}`);
      } catch (err: any) {
        console.warn('[sync] upsertAssetsFromEntries failed:', err.message);
      }

      res.json({ ok: true, data: { list, breakdown: result.breakdown, warnings: result.warnings } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 批量:一次生成多个策略的 list
  r.post('/cloudquery/sync-batch', async (req, res) => {
    const strategies = (req.body.strategies || []) as SyncStrategy[];
    const prefix: string = (req.body.prefix || 'cloudquery-').trim();
    const baseAutoSync = req.body.autoSync as AssetList['autoSync'] | undefined;
    const invalid = strategies.filter(s => !STRATEGIES.includes(s));
    if (strategies.length === 0) return res.status(400).json({ ok: false, error: 'strategies 不能为空' });
    if (invalid.length) return res.status(400).json({ ok: false, error: `无效策略: ${invalid.join(',')}` });
    if (!cloudqueryConfigured()) return res.status(400).json({ ok: false, error: 'cloudquery PG 未配置' });

    const existingLists = store.getAll('assetLists') as AssetList[];
    const names = new Set(existingLists.map(l => l.name));
    const results: any[] = [];

    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      try {
        const result = await syncCloudquery(strategy);
        if (result.entries.length === 0) {
          results.push({ strategy, ok: false, error: '同步结果为空' });
          continue;
        }
        let name = `${prefix}${strategy}`;
        if (names.has(name)) name = `${name}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;
        names.add(name);

        const now = new Date().toISOString();
        // autoSync 错峰:每个策略多偏移 1 分钟
        let autoSync: AssetList['autoSync'] | undefined;
        if (baseAutoSync?.enabled) {
          const offset = i;  // 0, 1, 2 分钟
          autoSync = {
            ...baseAutoSync,
            strategy,
            intervalMinutes: baseAutoSync.intervalMinutes ? baseAutoSync.intervalMinutes + offset : undefined,
            cron: baseAutoSync.cron ? shiftCron(baseAutoSync.cron, offset) : undefined,
            lastSyncedAt: now,
            lastStatus: 'ok',
            lastEntriesCount: result.entries.length,
          };
        }
        const list: AssetList = {
          id: uuid(), name,
          description: `CloudQuery 同步(${strategy}) · ${now.slice(0, 16)}`,
          entries: result.entries, builtin: false,
          createdAt: now, updatedAt: now,
          autoSync,
        };
        store.insert('assetLists', list);
        const upRes = upsertAssetsFromEntries(store, result.entries);
        console.log(`[sync-batch ${strategy}] asset upsert: updated=${upRes.updated} created=${upRes.created}`);
        results.push({ strategy, ok: true, list, breakdown: result.breakdown, warnings: result.warnings });
      } catch (err: any) {
        results.push({ strategy, ok: false, error: err.message });
      }
    }
    res.json({ ok: true, data: results });
  });

  return r;
}

function shiftCron(hm: string, minutesOffset: number): string {
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hm;
  let minutes = Number(m[1]) * 60 + Number(m[2]) + minutesOffset;
  minutes = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
