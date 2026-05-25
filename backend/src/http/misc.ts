import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { Store } from '../storage/store.js';
import type { Finding, FindingType, Run, WebPath, Asset, RiskSnapshot, LiveEndpoint, Task, Service, Result } from '@sasp/shared';
import { parsePageParams, sortInPlace, paginate } from './paginate.js';

// 真正的"安全问题"类型(需要人工处置)
const SECURITY_FINDING_TYPES: FindingType[] = [
  'weak_password',
  'unauth',
  'anonymous_login',
  'default_credential',
  'plaintext_protocol',
  'auth_exposure',
  'sensitive_path',
];
// 资产变化"活动"类型(提示性,不代表安全问题)
const ACTIVITY_FINDING_TYPES: FindingType[] = ['new_endpoint', 'new_service', 'endpoint_gone'];

function isSecurityFinding(f: Finding): boolean {
  return SECURITY_FINDING_TYPES.includes(f.type);
}

const DATA_SERVICE_PRODUCTS = new Set([
  'mysql', 'mariadb', 'polardb', 'adb', 'starrocks', 'tidb', 'oceanbase', 'doris',
  'postgresql', 'postgres', 'redis', 'mongodb', 'cassandra', 'elasticsearch', 'opensearch', 'solr',
  'clickhouse', 'couchdb', 'influxdb', 'aerospike', 'hbase', 'hdfs', 'hive',
  'memcached', 'zookeeper', 'etcd', 'neo4j', 'rabbitmq', 'kafka', 'rocketmq', 'pulsar',
  'mssql', 'oracle', 'consul', 'nacos', 'trino', 'presto',
]);

function normalizeProduct(value?: string): string {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function buildFindingContextResolver(store: Store) {
  const assets = store.getAll('assets') as Asset[];
  const endpoints = store.getAll('liveEndpoints') as LiveEndpoint[];
  const services = store.getAll('services') as Service[];
  const assetById = new Map<string, Asset>(assets.map(a => [a.id, a]));
  const endpointById = new Map<string, LiveEndpoint>(endpoints.map(e => [e.id, e]));
  const serviceById = new Map<string, Service>(services.map(s => [s.id, s]));
  const serviceByEndpoint = new Map<string, Service>();
  for (const s of services) {
    const prev = serviceByEndpoint.get(s.endpointId);
    if (!prev || String(s.lastSeenAt || '') > String(prev.lastSeenAt || '')) serviceByEndpoint.set(s.endpointId, s);
  }

  return (f: Finding) => {
    const asset = assetById.get(f.assetId);
    const endpoint = f.endpointId ? endpointById.get(f.endpointId) : undefined;
    const service = f.serviceId ? serviceById.get(f.serviceId) : endpoint?.id ? serviceByEndpoint.get(endpoint.id) : undefined;
    const values = [
      service?.product,
      service?.protocol,
      ...(service?.fingerprints || []).map(fp => fp.name),
      f.title,
      f.type,
      f.dedupeKey,
    ].map(normalizeProduct).filter(Boolean);
    const dataService = values.some(v => DATA_SERVICE_PRODUCTS.has(v) || [...DATA_SERVICE_PRODUCTS].some(p => v.includes(p)));
    return { asset, endpoint, service, scope: asset?.zone, dataCategory: dataService ? 'database' : 'nonDatabase' };
  };
}

/** 风险分:严重度越高得分越高,仅对 open/confirmed 计算 */
const SEVERITY_SCORE: Record<string, number> = {
  critical: 10, high: 5, medium: 2, low: 1, info: 0,
};
function findingScore(f: Finding): number {
  if (f.status !== 'open' && f.status !== 'confirmed') return 0;
  return SEVERITY_SCORE[f.severity] ?? 0;
}

/**
 * 判断 finding 是 current(现存)还是 historical(历史)
 * 规则:
 *   - finding.status 是 resolved/ignored → historical
 *   - 关联的 endpoint 已 disappearedAt 或不存在 → historical
 *   - 否则 → current
 */
type Lifecycle = 'current' | 'historical';
function buildLifecycleResolver(store: Store): (f: Finding) => Lifecycle {
  const eps = store.getAll('liveEndpoints') as LiveEndpoint[];
  const epById = new Map<string, LiveEndpoint>();
  for (const e of eps) epById.set(e.id, e);
  return (f: Finding): Lifecycle => {
    if (f.status === 'resolved' || f.status === 'ignored') return 'historical';
    if (f.endpointId) {
      const ep = epById.get(f.endpointId);
      if (!ep || ep.disappearedAt) return 'historical';
    }
    return 'current';
  };
}

function buildCredentialsResolver(store: Store, scope?: Finding[]): (f: Finding) => any {
  const byDedupe = new Map<string, any>();
  const missingKeys = scope
    ? new Set(scope.filter(f => !(f as any).credentials).map(f => f.dedupeKey).filter(Boolean))
    : undefined;
  if (missingKeys && missingKeys.size === 0) {
    return (f: Finding) => (f as any).credentials;
  }
  const results = store.getAll('results') as Result[];
  for (const r of results) {
    if (r.resultType !== 'finding') continue;
    const d: any = r.data || {};
    if (!d.dedupeKey || !d.credentials) continue;
    if (missingKeys && !missingKeys.has(d.dedupeKey)) continue;
    byDedupe.set(d.dedupeKey, d.credentials);
  }
  return (f: Finding) => (f as any).credentials || byDedupe.get(f.dedupeKey);
}

function withFindingExtras(
  f: Finding,
  resolveLifecycle: (f: Finding) => Lifecycle,
  resolveCredentials: (f: Finding) => any,
  resolveContext?: (f: Finding) => any,
) {
  const credentials = resolveCredentials(f);
  const ctx = resolveContext?.(f);
  return {
    ...f,
    lifecycle: resolveLifecycle(f),
    ...(credentials ? { credentials } : {}),
    ...(ctx ? {
      scope: ctx.scope,
      dataCategory: ctx.dataCategory,
      endpoint: ctx.endpoint ? { ip: ctx.endpoint.ip, host: ctx.endpoint.host, port: ctx.endpoint.port } : undefined,
      service: ctx.service ? { protocol: ctx.service.protocol, product: ctx.service.product, title: ctx.service.title } : undefined,
      instance: ctx.asset ? {
        key: ctx.asset.instanceKey,
        cloud: ctx.asset.cloud,
        role: ctx.asset.instanceRole,
        name: ctx.asset.instanceName,
      } : undefined,
    } : {}),
  };
}

function applyFindingRequestFilters(findings: Finding[], req: any, resolveLifecycle: (f: Finding) => Lifecycle, resolveContext: (f: Finding) => any): Finding[] {
  let out = findings;
  if (req.query.status) out = out.filter(f => f.status === req.query.status);
  if (req.query.severity) out = out.filter(f => f.severity === req.query.severity);
  const q = ((req.query.q as string) || '').trim().toLowerCase();
  if (q) out = out.filter(f => `${f.title} ${f.type} ${f.description || ''} ${f.evidence || ''}`.toLowerCase().includes(q));

  const lifecycle = (req.query.lifecycle as string) || 'all';
  if (lifecycle === 'current' || lifecycle === 'historical') {
    out = out.filter(f => resolveLifecycle(f) === lifecycle);
  }
  const scope = String(req.query.scope || '');
  if (scope === 'public' || scope === 'private') out = out.filter(f => resolveContext(f).scope === scope);
  const dataCategory = String(req.query.dataCategory || '');
  if (dataCategory === 'database' || dataCategory === 'nonDatabase') {
    out = out.filter(f => resolveContext(f).dataCategory === dataCategory);
  }
  return out;
}

export function findingRoutes(store: Store): Router {
  const r = Router();
  r.get('/', (req, res) => {
    let findings = store.getAll('findings') as Finding[];
    // kind=security/activity/all,默认 all 保持兼容
    const kind = (req.query.kind as string) || 'all';
    if (kind === 'security') findings = findings.filter(isSecurityFinding);
    else if (kind === 'activity') findings = findings.filter(f => ACTIVITY_FINDING_TYPES.includes(f.type));
    const resolveLifecycle = buildLifecycleResolver(store);
    const resolveContext = buildFindingContextResolver(store);
    findings = applyFindingRequestFilters(findings, req, resolveLifecycle, resolveContext);

    const params = parsePageParams(req.query, { defaultSort: 'lastSeenAt:desc' });
    sortInPlace(findings as any[], params.sortField, params.sortDir);
    const paged = paginate(findings, params);
    // 给每条 finding 挂 lifecycle 字段,前端不用再 join
    const resolveCredentials = buildCredentialsResolver(store, paged.data);
    const data = paged.data.map(f => withFindingExtras(f, resolveLifecycle, resolveCredentials, resolveContext));
    res.json({ ok: true, ...paged, data });
  });
  r.put('/:id/status', (req, res) => {
    store.update('findings', req.params.id, { status: req.body.status, resolvedAt: req.body.status === 'resolved' ? new Date().toISOString() : undefined });
    res.json({ ok: true });
  });
  r.get('/stats', (req, res) => {
    let findings = store.getAll('findings') as Finding[];
    const kind = (req.query.kind as string) || 'all';
    if (kind === 'security') findings = findings.filter(isSecurityFinding);
    else if (kind === 'activity') findings = findings.filter(f => ACTIVITY_FINDING_TYPES.includes(f.type));
    const resolveLifecycle = buildLifecycleResolver(store);
    const resolveContext = buildFindingContextResolver(store);
    findings = applyFindingRequestFilters(findings, req, resolveLifecycle, resolveContext);
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byLifecycle: Record<string, number> = { current: 0, historical: 0 };
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byStatus[f.status] = (byStatus[f.status] || 0) + 1;
      byLifecycle[resolveLifecycle(f)]++;
    }
    res.json({ ok: true, data: { total: findings.length, bySeverity, byStatus, byLifecycle } });
  });
  // 按机器聚合:只看 security findings,在 open/confirmed 状态的
  // 每台机器聚合 findings,按风险分排序
  r.get('/by-instance', (req, res) => {
    let findings = (store.getAll('findings') as Finding[]).filter(isSecurityFinding);
    const assets = store.getAll('assets') as Asset[];
    const assetById = new Map<string, Asset>();
    for (const a of assets) assetById.set(a.id, a);
    const resolveLifecycle = buildLifecycleResolver(store);
    const resolveContext = buildFindingContextResolver(store);
    findings = applyFindingRequestFilters(findings, req, resolveLifecycle, resolveContext);
    const resolveCredentials = buildCredentialsResolver(store, findings);

    interface Bucket {
      instanceKey: string;
      cloud?: string;
      role?: string;
      name?: string;
      ips: string[];
      findings: any[];          // 含 lifecycle 字段
      score: number;            // 仅累计 current 的分
      bySeverity: Record<string, number>;  // 仅 current
      historicalCount: number;
    }
    const buckets = new Map<string, Bucket>();

    for (const f of findings) {
      const a = assetById.get(f.assetId);
      const key = a?.instanceKey || `unknown:${a?.ip || f.assetId}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          instanceKey: key,
          cloud: a?.cloud,
          role: a?.instanceRole,
          name: a?.instanceName,
          ips: [],
          findings: [],
          score: 0,
          bySeverity: {},
          historicalCount: 0,
        };
        buckets.set(key, b);
      }
      if (a?.ip && !b.ips.includes(a.ip)) b.ips.push(a.ip);
      const lifecycle = resolveLifecycle(f);
      b.findings.push(withFindingExtras(f, resolveLifecycle, resolveCredentials, resolveContext));
      if (lifecycle === 'current') {
        b.score += findingScore(f);
        b.bySeverity[f.severity] = (b.bySeverity[f.severity] || 0) + 1;
      } else {
        b.historicalCount++;
      }
    }

    // 默认只显示 score>0 的(有现存问题的);showResolved=true 时显示全部包含纯历史
    const showResolved = req.query.showResolved === 'true';
    let list = [...buckets.values()];
    if (!showResolved) list = list.filter(b => b.score > 0);

    list.sort((x, y) => y.score - x.score || y.findings.length - x.findings.length);

    const params = parsePageParams(req.query, { defaultSort: '' });
    const paged = paginate(list, params);
    res.json({ ok: true, ...paged });
  });
  // 单机器风险趋势:返回近 N 天的 RiskSnapshot
  r.get('/instance/:key/trend', (req, res) => {
    const key = req.params.key;
    const days = Math.min(180, Math.max(1, parseInt(req.query.days as string) || 30));
    const cutoff = Date.now() - days * 86400_000;
    const snaps = (store.getAll('riskSnapshots') as RiskSnapshot[])
      .filter(s => s.instanceKey === key && new Date(s.takenAt).getTime() >= cutoff)
      .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    res.json({ ok: true, data: snaps });
  });
  // 手动触发一次快照(用于 demo 与即刻调试)
  r.post('/snapshot', (_req, res) => {
    const r1 = takeRiskSnapshot(store);
    res.json({ ok: true, data: r1 });
  });
  return r;
}

/**
 * 抓一份当前所有机器的风险快照,写入 riskSnapshots 表。
 * 同一天同一机器去重(只留当天最后一次)。
 */
export function takeRiskSnapshot(store: Store): { taken: number; date: string } {
  const all = store.getAll('findings') as Finding[];
  const resolveLifecycle = buildLifecycleResolver(store);
  const findings = all.filter(f =>
    SECURITY_FINDING_TYPES.includes(f.type) &&
    (f.status === 'open' || f.status === 'confirmed') &&
    resolveLifecycle(f) === 'current'
  );
  const assets = store.getAll('assets') as Asset[];
  const assetById = new Map<string, Asset>();
  for (const a of assets) assetById.set(a.id, a);

  // 聚合
  const buckets = new Map<string, { cloud?: string; name?: string; score: number; bySev: Record<string, number>; count: number }>();
  for (const f of findings) {
    const a = assetById.get(f.assetId);
    if (!a?.instanceKey) continue;  // 没机器归属的不进趋势
    let b = buckets.get(a.instanceKey);
    if (!b) { b = { cloud: a.cloud, name: a.instanceName, score: 0, bySev: {}, count: 0 }; buckets.set(a.instanceKey, b); }
    b.score += SEVERITY_SCORE[f.severity] ?? 0;
    b.bySev[f.severity] = (b.bySev[f.severity] || 0) + 1;
    b.count++;
  }

  const now = new Date();
  const takenAt = now.toISOString();
  const date = takenAt.slice(0, 10);
  // 删今天已有的同 instanceKey 快照,保证一日一条
  const existing = store.getAll('riskSnapshots') as RiskSnapshot[];
  const toRemove = existing.filter(s => s.date === date && buckets.has(s.instanceKey));
  for (const r of toRemove) store.delete('riskSnapshots', r.id);

  for (const [key, b] of buckets) {
    const snap: RiskSnapshot = {
      id: uuid(), takenAt, date,
      instanceKey: key,
      cloud: b.cloud, instanceName: b.name,
      score: b.score, bySeverity: b.bySev, findingCount: b.count,
    };
    store.insert('riskSnapshots', snap);
  }
  return { taken: buckets.size, date };
}

interface TaskRunSummary {
  id: string;
  taskRunId?: string;
  taskId: string;
  taskName: string;
  status: string;
  modules: string[];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  totalResults: number;
  moduleRuns: Array<{
    id: string;
    moduleId: string;
    status: string;
    total: number;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    error?: string;
  }>;
}

function summarizeTaskRun(runs: Run[], tasksById: Map<string, Task>): TaskRunSummary {
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = sorted[0];
  const startedAt = sorted.reduce((min, r) => r.startedAt < min ? r.startedAt : min, first.startedAt);
  const finishedRuns = sorted.filter(r => r.finishedAt);
  const finishedAt = finishedRuns.length === sorted.length
    ? finishedRuns.reduce((max, r) => (r.finishedAt! > max ? r.finishedAt! : max), finishedRuns[0].finishedAt!)
    : undefined;
  const status = sorted.some(r => r.status === 'running') ? 'running'
    : sorted.some(r => r.status === 'failed') ? 'failed'
      : sorted.some(r => r.status === 'cancelled') ? 'cancelled'
        : 'completed';
  const task = tasksById.get(first.taskId);
  const taskName = first.taskName || task?.name || `已删除任务 ${first.taskId.slice(0, 8)}`;
  const durationMs = finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : undefined;
  const plannedModules = task?.modules?.length ? task.modules : sorted.map(r => r.moduleId);
  const actualByModule = new Map(sorted.map(r => [r.moduleId, r]));

  return {
    id: first.taskRunId || `legacy:${first.taskId}:${first.id}`,
    taskRunId: first.taskRunId,
    taskId: first.taskId,
    taskName,
    status,
    modules: plannedModules,
    startedAt,
    finishedAt,
    durationMs,
    totalResults: sorted.reduce((sum, r) => sum + (r.counters?.total || 0), 0),
    moduleRuns: plannedModules.map(moduleId => {
      const r = actualByModule.get(moduleId);
      if (!r) {
        return {
          id: `pending:${first.taskRunId || first.id}:${moduleId}`,
          moduleId,
          status: 'pending',
          total: 0,
        };
      }
      return {
      id: r.id,
      moduleId: r.moduleId,
      status: r.status,
      total: r.counters?.total || 0,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : undefined,
      error: r.error,
      };
    }),
  };
}

function groupTaskRuns(store: Store): TaskRunSummary[] {
  const runs = (store.getAll('runs') as Run[]).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const tasksById = new Map((store.getAll('tasks') as Task[]).map(t => [t.id, t]));
  const groups: Run[][] = [];
  const byTaskRunId = new Map<string, Run[]>();
  const legacyByTaskId = new Map<string, Run[]>();

  for (const run of runs) {
    if (run.taskRunId) {
      const arr = byTaskRunId.get(run.taskRunId) || [];
      arr.push(run);
      byTaskRunId.set(run.taskRunId, arr);
      continue;
    }

    // 兼容历史数据：同一 taskId 下，前一个模块结束后 15 分钟内启动的 Run 归为同一次任务执行。
    const current = legacyByTaskId.get(run.taskId);
    const last = current?.[current.length - 1];
    const lastEnd = last?.finishedAt || last?.startedAt;
    const gapMs = lastEnd ? new Date(run.startedAt).getTime() - new Date(lastEnd).getTime() : Number.POSITIVE_INFINITY;
    if (!current || gapMs > 15 * 60_000 || gapMs < -60_000) {
      const next = [run];
      groups.push(next);
      legacyByTaskId.set(run.taskId, next);
    } else {
      current.push(run);
    }
  }

  groups.push(...byTaskRunId.values());
  return groups
    .filter(group => group.length > 0)
    .map(group => summarizeTaskRun(group, tasksById))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function getTaskRunBundle(store: Store, id: string) {
  const taskRun = groupTaskRuns(store).find(r => r.id === id || r.taskRunId === id);
  if (!taskRun) return undefined;
  const runIds = new Set(taskRun.moduleRuns.map(r => r.id));
  const results = (store.getAll('results') as Result[]).filter(r => runIds.has(r.runId));
  return { taskRun, runIds, results };
}

function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
}

function safeFilename(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'report';
}

function download(res: any, filename: string, content: string, mime: string) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(content);
}

function beijingDate(value?: string): string {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeFingerprintRecords(result: Result): Array<{
  name: string;
  version?: string;
  confidence?: number;
  source?: string;
  product?: string;
  protocol?: string;
}> {
  const d = (result.data || {}) as any;
  const fps = Array.isArray(d.fingerprints) ? d.fingerprints : [];
  if (fps.length > 0) {
    return fps
      .map((f: any) => ({
        name: String(f?.name || '').trim(),
        version: f?.version ? String(f.version) : undefined,
        confidence: typeof f?.confidence === 'number' ? f.confidence : undefined,
        source: f?.source ? String(f.source) : undefined,
        product: d.product ? String(d.product) : undefined,
        protocol: d.protocol ? String(d.protocol) : undefined,
      }))
      .filter((f: { name: string }) => f.name);
  }
  if (d.product) {
    return [{
      name: String(d.product),
      version: d.version ? String(d.version) : undefined,
      product: String(d.product),
      protocol: d.protocol ? String(d.protocol) : undefined,
      source: 'service-product',
    }];
  }
  return [];
}

export function fingerprintStatRoutes(store: Store): Router {
  const r = Router();

  r.get('/daily', (req, res) => {
    const moduleId = String(req.query.moduleId || 'fingerprint');
    const q = String(req.query.q || '').trim().toLowerCase();
    const scope = String(req.query.scope || '');
    const requestedDate = String(req.query.date || '');
    const mode = ['all', 'current', 'history', 'new'].includes(String(req.query.mode || ''))
      ? String(req.query.mode)
      : 'new';

    const endpointsById = new Map((store.getAll('liveEndpoints') as LiveEndpoint[]).map(e => [e.id, e]));
    const assetsById = new Map((store.getAll('assets') as Asset[]).map(a => [a.id, a]));
    const runsById = new Map((store.getAll('runs') as Run[]).map(run => [run.id, run]));
    const results = (store.getAll('results') as Result[])
      .filter(result => result.resultType === 'service_identified')
      .filter(result => moduleId === 'all' || result.moduleId === moduleId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    type FirstSeenRecord = {
      key: string;
      date: string;
      firstSeenAt: string;
      fingerprint: string;
      version?: string;
      product?: string;
      protocol?: string;
      confidence?: number;
      source?: string;
      ip: string;
      host?: string;
      port: number;
      endpointId?: string;
      assetId?: string;
      scope?: string;
      instance?: { key: string; role?: string; cloud?: string; name?: string };
      taskName?: string;
      runId: string;
      moduleId: string;
    };

    const firstByKey = new Map<string, FirstSeenRecord>();
    for (const result of results) {
      const fpRecords = normalizeFingerprintRecords(result);
      if (fpRecords.length === 0) continue;
      const endpoint = result.endpointId ? endpointsById.get(result.endpointId) : undefined;
      const asset = (endpoint?.assetId ? assetsById.get(endpoint.assetId) : undefined)
        || (result.assetId ? assetsById.get(result.assetId) : undefined);
      const ip = endpoint?.ip || (result.data as any)?.ip || asset?.ip || '';
      const port = endpoint?.port || (result.data as any)?.port || 0;
      if (!ip || !port) continue;
      const day = beijingDate(result.createdAt);
      const run = runsById.get(result.runId);
      for (const fp of fpRecords) {
        const key = `${result.endpointId || `${ip}:${port}`}|${fp.name}|${fp.version || ''}`;
        if (firstByKey.has(key)) continue;
        firstByKey.set(key, {
          key,
          date: day,
          firstSeenAt: result.createdAt,
          fingerprint: fp.name,
          version: fp.version,
          product: fp.product,
          protocol: fp.protocol,
          confidence: fp.confidence,
          source: fp.source,
          ip,
          host: endpoint?.host,
          port,
          endpointId: result.endpointId,
          assetId: endpoint?.assetId || result.assetId,
          scope: asset?.zone,
          instance: asset?.instanceKey ? {
            key: asset.instanceKey,
            role: asset.instanceRole,
            cloud: asset.cloud,
            name: asset.instanceName,
          } : undefined,
          taskName: run?.taskName,
          runId: result.runId,
          moduleId: result.moduleId,
        });
      }
    }

    const allRecords = [...firstByKey.values()];
    const days = [...new Set(allRecords.map(r => r.date).filter(Boolean))].sort().reverse();
    const date = requestedDate || days[0] || beijingDate();
    const currentRecords: FirstSeenRecord[] = [];
    for (const service of store.getAll('services') as Service[]) {
      const endpoint = endpointsById.get(service.endpointId);
      if (!endpoint || !endpoint.alive || endpoint.disappearedAt) continue;
      if (String(service.lastSeenAt || '') < String(endpoint.lastSeenAt || '')) continue;
      const asset = assetsById.get(endpoint.assetId);
      const fps: Array<{ name: string; version?: string; confidence?: number; source?: string; product?: string; protocol?: string }> = service.fingerprints?.length
        ? service.fingerprints.map(f => ({
          name: f.name,
          version: f.version,
          confidence: f.confidence,
          source: f.source,
          product: service.product,
          protocol: service.protocol,
        }))
        : (service.product ? [{
          name: service.product,
          version: service.version,
          product: service.product,
          protocol: service.protocol,
          source: 'service-product',
        }] : []);
      for (const fp of fps) {
        if (!fp.name) continue;
        currentRecords.push({
          key: `${service.endpointId}|${fp.name}|${fp.version || ''}`,
          date: beijingDate(service.firstSeenAt),
          firstSeenAt: service.firstSeenAt,
          fingerprint: fp.name,
          version: fp.version,
          product: fp.product,
          protocol: fp.protocol,
          confidence: fp.confidence,
          source: fp.source,
          ip: service.ip,
          host: service.host,
          port: service.port,
          endpointId: service.endpointId,
          assetId: service.assetId,
          scope: asset?.zone,
          instance: asset?.instanceKey ? {
            key: asset.instanceKey,
            role: asset.instanceRole,
            cloud: asset.cloud,
            name: asset.instanceName,
          } : undefined,
          taskName: undefined,
          runId: '',
          moduleId: 'fingerprint',
        });
      }
    }

    const applyCommonRecordFilters = (input: FirstSeenRecord[]) => {
      let out = input;
      if (scope === 'public' || scope === 'private') out = out.filter(r => r.scope === scope);
      if (q) {
        out = out.filter(r => [
          r.fingerprint, r.version, r.product, r.protocol, r.ip, r.host, r.port,
          r.instance?.key, r.instance?.name, r.taskName,
        ].filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
      }
      return out;
    };

    const filteredNewRecords = applyCommonRecordFilters(allRecords);
    const dailySummaries = [...new Set(filteredNewRecords.map(r => r.date).filter(Boolean))]
      .sort()
      .reverse()
      .map(day => {
        const dayRecords = filteredNewRecords.filter(r => r.date === day);
        const byFingerprint = new Map<string, number>();
        const ports = new Map<number, number>();
        for (const r of dayRecords) {
          const fp = `${r.fingerprint}${r.version ? '@' + r.version : ''}`;
          byFingerprint.set(fp, (byFingerprint.get(fp) || 0) + 1);
          ports.set(r.port, (ports.get(r.port) || 0) + 1);
        }
        return {
          date: day,
          fingerprintCount: new Set(dayRecords.map(r => `${r.fingerprint}|${r.version || ''}`)).size,
          endpointFingerprintCount: dayRecords.length,
          endpointCount: new Set(dayRecords.map(r => r.endpointId || `${r.ip}:${r.port}`)).size,
          ipCount: new Set(dayRecords.map(r => r.ip)).size,
          publicCount: dayRecords.filter(r => r.scope === 'public').length,
          privateCount: dayRecords.filter(r => r.scope === 'private').length,
          topFingerprints: [...byFingerprint.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 6)
            .map(([fingerprint, count]) => ({ fingerprint, count })),
          topPorts: [...ports.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, 6)
            .map(([port, count]) => ({ port, count })),
        };
      });

    let records = mode === 'current'
      ? currentRecords
      : mode === 'history'
        ? allRecords.filter(r => {
          const endpoint = r.endpointId ? endpointsById.get(r.endpointId) : undefined;
          return !endpoint || !endpoint.alive || !!endpoint.disappearedAt;
        })
        : mode === 'all'
          ? allRecords
          : allRecords.filter(r => r.date === date);
    records = applyCommonRecordFilters(records);

    const groupMap = new Map<string, {
      fingerprint: string;
      version?: string;
      count: number;
      endpointCount: number;
      ipCount: number;
      ports: number[];
      publicCount: number;
      privateCount: number;
      examples: FirstSeenRecord[];
    }>();
    for (const record of records) {
      const key = `${record.fingerprint}|${record.version || ''}`;
      let group = groupMap.get(key);
      if (!group) {
        group = {
          fingerprint: record.fingerprint,
          version: record.version,
          count: 0,
          endpointCount: 0,
          ipCount: 0,
          ports: [],
          publicCount: 0,
          privateCount: 0,
          examples: [],
        };
        groupMap.set(key, group);
      }
      group.count++;
      if (record.scope === 'public') group.publicCount++;
      if (record.scope === 'private') group.privateCount++;
      if (!group.ports.includes(record.port)) group.ports.push(record.port);
      if (group.examples.length < 5) group.examples.push(record);
    }
    const groups = [...groupMap.values()].map(group => ({
      ...group,
      endpointCount: new Set(records
        .filter(r => r.fingerprint === group.fingerprint && (r.version || '') === (group.version || ''))
        .map(r => r.endpointId || `${r.ip}:${r.port}`)).size,
      ipCount: new Set(records
        .filter(r => r.fingerprint === group.fingerprint && (r.version || '') === (group.version || ''))
        .map(r => r.ip)).size,
      ports: group.ports.sort((a, b) => a - b),
    })).sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));

    const ports = new Map<number, number>();
    for (const record of records) ports.set(record.port, (ports.get(record.port) || 0) + 1);

    res.json({
      ok: true,
      data: {
        date,
        mode,
        days,
        summary: {
          newFingerprints: groups.length,
          newEndpointFingerprints: records.length,
          endpointCount: new Set(records.map(r => r.endpointId || `${r.ip}:${r.port}`)).size,
          ipCount: new Set(records.map(r => r.ip)).size,
          publicCount: records.filter(r => r.scope === 'public').length,
          privateCount: records.filter(r => r.scope === 'private').length,
          topPorts: [...ports.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([port, count]) => ({ port, count })),
        },
        groups,
        dailySummaries,
        records: records.sort((a, b) =>
          a.fingerprint.localeCompare(b.fingerprint) || a.ip.localeCompare(b.ip) || a.port - b.port,
        ),
      },
    });
  });

  return r;
}

function buildExportData(store: Store, taskRun: TaskRunSummary, results: Result[]) {
  const endpointIds = new Set<string>();
  const serviceIds = new Set<string>();
  for (const result of results) {
    if (result.endpointId) endpointIds.add(result.endpointId);
    if (result.serviceId) serviceIds.add(result.serviceId);
  }

  const endpoints = (store.getAll('liveEndpoints') as LiveEndpoint[]).filter(e => endpointIds.has(e.id));
  for (const ep of endpoints) endpointIds.add(ep.id);

  const services = (store.getAll('services') as Service[]).filter(s => {
    const selected = serviceIds.has(s.id) || endpointIds.has(s.endpointId);
    if (selected) serviceIds.add(s.id);
    return selected;
  });

  const assetsById = new Map((store.getAll('assets') as Asset[]).map(a => [a.id, a]));
  const endpointsById = new Map(endpoints.map(e => [e.id, e]));
  const servicesById = new Map(services.map(s => [s.id, s]));
  const webPaths = (store.getAll('webPaths') as WebPath[]).filter(p => serviceIds.has(p.serviceId));
  const authLogs = results.filter(r => r.moduleId === 'weak-password' && r.resultType === 'log');
  const rawFindings = results.filter(r => r.resultType === 'finding');
  const findings = (store.getAll('findings') as Finding[]).filter(f => {
    if (!isSecurityFinding(f)) return false;
    if (f.firstSeenAt >= taskRun.startedAt && (!taskRun.finishedAt || f.firstSeenAt <= taskRun.finishedAt)) return true;
    if (f.lastSeenAt >= taskRun.startedAt && (!taskRun.finishedAt || f.lastSeenAt <= taskRun.finishedAt)) return true;
    return false;
  });
  const resolveLifecycle = buildLifecycleResolver(store);
  const resolveCredentials = buildCredentialsResolver(store, findings);
  const enrichedFindings = findings.map(f => withFindingExtras(f, resolveLifecycle, resolveCredentials));

  return { assetsById, endpointsById, servicesById, endpoints, services, webPaths, authLogs, rawFindings, findings: enrichedFindings };
}

export function runRoutes(store: Store): Router {
  const r = Router();
  r.get('/task-runs', (req, res) => {
    let taskRuns = groupTaskRuns(store);
    if (req.query.taskId) taskRuns = taskRuns.filter(r => r.taskId === req.query.taskId);
    const params = parsePageParams(req.query, { defaultSort: 'startedAt:desc' });
    sortInPlace(taskRuns as any[], params.sortField, params.sortDir);
    const paged = paginate(taskRuns, params);
    res.json({ ok: true, ...paged });
  });

  r.get('/task-runs/:id/report', (req, res) => {
    const bundle = getTaskRunBundle(store, req.params.id);
    if (!bundle) return res.status(404).json({ ok: false, error: 'Task run not found' });
    const { taskRun, results } = bundle;

    const byType: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    const byRunType = new Map<string, Record<string, number>>();
    const weakFindingsByRun = new Map<string, number>();
    for (const result of results) {
      byType[result.resultType] = (byType[result.resultType] || 0) + 1;
      byModule[result.moduleId] = (byModule[result.moduleId] || 0) + 1;
      const runTypes = byRunType.get(result.runId) || {};
      runTypes[result.resultType] = (runTypes[result.resultType] || 0) + 1;
      byRunType.set(result.runId, runTypes);
      if (result.resultType === 'finding' && isSecurityFinding(result.data as any)) {
        weakFindingsByRun.set(result.runId, (weakFindingsByRun.get(result.runId) || 0) + 1);
      }
    }

    const findings = (store.getAll('findings') as Finding[]).filter(f => {
      if (!isSecurityFinding(f)) return false;
      if (f.firstSeenAt >= taskRun.startedAt && (!taskRun.finishedAt || f.firstSeenAt <= taskRun.finishedAt)) return true;
      if (f.lastSeenAt >= taskRun.startedAt && (!taskRun.finishedAt || f.lastSeenAt <= taskRun.finishedAt)) return true;
      return false;
    });
    const resolveLifecycle = buildLifecycleResolver(store);
    const resolveCredentials = buildCredentialsResolver(store, findings);
    const enrichedFindings = findings.map(f => withFindingExtras(f, resolveLifecycle, resolveCredentials));

    res.json({
      ok: true,
      data: {
        taskRun,
        runs: taskRun.moduleRuns.map(run => ({
          ...run,
          resultTypes: byRunType.get(run.id) || {},
          weakPasswordFindings: weakFindingsByRun.get(run.id) || 0,
        })),
        summary: { totalResults: results.length, byType, byModule, findingCount: enrichedFindings.length },
        results: results.slice(0, 200),
        logs: results.filter(r => r.resultType === 'log').slice(-300),
        findings: enrichedFindings,
      },
    });
  });

  r.get('/task-runs/:id/export', (req, res) => {
    const bundle = getTaskRunBundle(store, req.params.id);
    if (!bundle) return res.status(404).json({ ok: false, error: 'Task run not found' });
    const { taskRun, results } = bundle;
    const type = String(req.query.type || 'full');
    const format = String(req.query.format || (type === 'full' ? 'json' : 'csv'));
    const data = buildExportData(store, taskRun, results);
    const suffix = `${safeFilename(taskRun.taskName)}-${taskRun.startedAt.slice(0, 10)}-${taskRun.id.slice(0, 8)}`;

    if (format === 'json' || type === 'full') {
      return download(res, `${suffix}-${type}.json`, JSON.stringify({
        taskRun,
        results,
        endpoints: data.endpoints,
        services: data.services,
        webPaths: data.webPaths,
        findings: data.findings,
        rawFindings: data.rawFindings,
        authLogs: data.authLogs,
      }, null, 2), 'application/json; charset=utf-8');
    }

    if (type === 'endpoints') {
      const rows = data.endpoints.map(e => {
        const a = data.assetsById.get(e.assetId);
        return [e.host || e.ip, e.ip, e.port, a?.zone || '', a?.instanceKey || '', e.alive ? 'alive' : 'gone', e.firstSeenAt, e.lastSeenAt, e.disappearedAt || '', e.banner || ''];
      });
      return download(res, `${suffix}-endpoints.csv`, '\ufeff' + toCsv(
        ['host', 'ip', 'port', 'scope', 'instanceKey', 'status', 'firstSeenAt', 'lastSeenAt', 'disappearedAt', 'banner'],
        rows,
      ), 'text/csv; charset=utf-8');
    }

    if (type === 'services') {
      const rows = data.services.map(s => {
        const e = data.endpointsById.get(s.endpointId);
        const a = data.assetsById.get(s.assetId);
        return [
          s.host || s.ip, s.ip, s.port, a?.zone || '', s.protocol, s.product || '', s.version || '', s.title || '',
          (s.fingerprints || []).map(f => `${f.name}${f.version ? '@' + f.version : ''}`).join('; '),
          a?.instanceKey || '', e?.disappearedAt ? 'gone' : 'current', s.firstSeenAt, s.lastSeenAt,
        ];
      });
      return download(res, `${suffix}-services.csv`, '\ufeff' + toCsv(
        ['host', 'ip', 'port', 'scope', 'protocol', 'product', 'version', 'title', 'fingerprints', 'instanceKey', 'status', 'firstSeenAt', 'lastSeenAt'],
        rows,
      ), 'text/csv; charset=utf-8');
    }

    if (type === 'web-paths') {
      const rows = data.webPaths.map(p => {
        const s = data.servicesById.get(p.serviceId);
        return [s?.host || s?.ip || '', s?.port || '', p.url, p.path, p.statusCode, p.verified || '', p.title || '', p.contentType || '', p.contentLength || '', p.location || '', p.lastSeenAt, p.disappearedAt || ''];
      });
      return download(res, `${suffix}-web-paths.csv`, '\ufeff' + toCsv(
        ['host', 'port', 'url', 'path', 'statusCode', 'verified', 'title', 'contentType', 'contentLength', 'location', 'lastSeenAt', 'disappearedAt'],
        rows,
      ), 'text/csv; charset=utf-8');
    }

    if (type === 'weak-findings') {
      const findingRows = data.rawFindings
        .filter(r => ['weak_password', 'unauth', 'anonymous_login'].includes(String((r.data as any)?.type || '')))
        .map(r => {
          const d: any = r.data || {};
          const e = r.endpointId ? data.endpointsById.get(r.endpointId) : undefined;
          return [d.type || '', d.severity || '', d.tester || '', e?.host || e?.ip || '', e?.port || '', d.title || '', d.credentials?.username || '', d.credentials?.password ?? '', d.credentials?.passwordMasked || '', d.evidence || '', r.createdAt];
        });
      return download(res, `${suffix}-weak-findings.csv`, '\ufeff' + toCsv(
        ['type', 'severity', 'tester', 'host', 'port', 'title', 'username', 'password', 'passwordMasked', 'evidence', 'createdAt'],
        findingRows,
      ), 'text/csv; charset=utf-8');
    }

    if (type === 'auth-logs') {
      const rows = data.authLogs.map(r => {
        const d: any = r.data || {};
        return [d.target || '', d.tester || '', d.tried || 0, d.hit ? 'yes' : 'no', d.matchedBy || '', d.selectionReason || '', JSON.stringify(d.failures || {}), JSON.stringify(d.failureSamples || {}), r.createdAt];
      });
      return download(res, `${suffix}-auth-logs.csv`, '\ufeff' + toCsv(
        ['target', 'tester', 'tried', 'hit', 'matchedBy', 'selectionReason', 'failures', 'failureSamples', 'createdAt'],
        rows,
      ), 'text/csv; charset=utf-8');
    }

    res.status(400).json({ ok: false, error: `Unsupported export type: ${type}` });
  });

  r.get('/', (req, res) => {
    let runs = store.getAll('runs') as Run[];
    if (req.query.taskId) runs = runs.filter(r => r.taskId === req.query.taskId);
    const params = parsePageParams(req.query, { defaultSort: 'startedAt:desc' });
    sortInPlace(runs as any[], params.sortField, params.sortDir);
    const paged = paginate(runs, params);
    res.json({ ok: true, ...paged });
  });

  // 单次 Run 的报告摘要
  r.get('/:id/report', (req, res) => {
    const run = store.getById('runs', req.params.id) as Run | undefined;
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const results = store.query('results', (r: any) => r.runId === req.params.id) as any[];
    const byType: Record<string, number> = {};
    for (const r of results) byType[r.resultType] = (byType[r.resultType] || 0) + 1;
    // 找出这次 Run 期间新增/更新的 Finding
    const findings = store.query('findings', (f: any) => {
      if (f.firstSeenAt >= run.startedAt) return true;
      if (run.finishedAt && f.lastSeenAt >= run.startedAt && f.lastSeenAt <= run.finishedAt) return true;
      return false;
    }) as any[];
    const resolveLifecycle = buildLifecycleResolver(store);
    const resolveCredentials = buildCredentialsResolver(store, findings);
    const enrichedFindings = findings.map(f => withFindingExtras(f, resolveLifecycle, resolveCredentials));
    res.json({
      ok: true,
      data: {
        run,
        summary: { totalResults: results.length, byType, findingCount: enrichedFindings.length },
        results: results.slice(0, 200),
        findings: enrichedFindings,
      },
    });
  });

  return r;
}

export function webPathRoutes(store: Store): Router {
  const r = Router();
  r.get('/', (req, res) => {
    let paths = store.getAll('webPaths') as WebPath[];
    if (req.query.serviceId) paths = paths.filter(p => p.serviceId === req.query.serviceId);
    if (req.query.verified) paths = paths.filter(p => (p.verified || 'unknown') === req.query.verified);
    if (req.query.showGone !== 'true') paths = paths.filter((p: any) => !p.disappearedAt);
    res.json({ ok: true, data: paths, total: paths.length });
  });
  return r;
}

export function dashboardRoutes(store: Store): Router {
  const r = Router();
  r.get('/', (req, res) => {
    const assets = store.getAll('assets') as any[];
    const endpoints = store.getAll('liveEndpoints') as any[];
    const services = store.getAll('services') as any[];
    const allFindings = store.getAll('findings') as Finding[];
    const securityFindings = allFindings.filter(isSecurityFinding);
    const activityFindings = allFindings.filter(f => ACTIVITY_FINDING_TYPES.includes(f.type));
    const runs = store.getAll('runs') as Run[];
    const modules = store.getAll('modules') as any[];
    res.json({
      ok: true,
      data: {
        assetCount: assets.length,
        endpointCount: endpoints.filter(e => e.alive && !e.disappearedAt).length,
        serviceCount: services.length,
        // 真正的安全问题计数
        findingCount: securityFindings.length,
        openFindingCount: securityFindings.filter(f => f.status === 'open').length,
        // 活动记录计数(独立展示)
        activityCount: activityFindings.length,
        moduleCount: modules.length,
        recentRuns: runs.slice(-10).reverse(),
        // topRisks 只取真正的安全问题
        topRisks: securityFindings.filter(f => f.status === 'open').sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity)).slice(0, 10),
        // 最近活动
        recentActivity: activityFindings.slice(-10).reverse(),
        assetsByZone: { public: assets.filter(a => a.zone === 'public').length, private: assets.filter(a => a.zone === 'private').length },
      },
    });
  });
  return r;
}

function severityOrder(s: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s] ?? 5;
}
