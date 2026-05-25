/**
 * cloudquery 资产源 — 从 cloudquery PG 拉取云资产,按策略归类为 IP 清单
 *
 * 三种策略:
 *   db-scan  — 数据库扫描专用:实例(内网可达→内网 否则公网),LB 公网+内网全记录,RDS 不含
 *   all-ip   — 数据库扫描全量:实例公网+可达内网 + LB 公网/内网全记录,RDS 不含
 *   db-endpoints — 云数据库/RDS endpoint:域名 + 端口 + 协议,用于 db-endpoint-probe
 *   public   — 全公网:实例所有公网 IP + LB internet
 *   private  — 全内网:仅白名单内的实例/LB 内网 IP
 *
 * 规则要点:
 *   - 多网卡全扫(阿里云 network_interfaces 展开,AWS 走 ec2_network_interface 表)
 *   - EIP 裸号(status != InUse 或 instance_id 空)一律丢弃
 *   - 华为云 ECS 表无 IP,仅通过 huaweicloud_eip 反查已绑定机器
 */
import { Pool } from 'pg';
import { readFileSync, existsSync } from 'fs';
import type { AssetListEntry, ServiceProtocol } from '@sasp/shared';
import { appConfig } from '../config/app.js';

export type SyncStrategy = 'db-scan' | 'all-ip' | 'public' | 'private' | 'db-endpoints';

export interface SyncResult {
  strategy: SyncStrategy;
  entries: AssetListEntry[];   // 结构化条目,每条带机器归属
  breakdown: {
    total: number;
    uniqueIps: number;
    byCloud: Record<string, number>;
    bySource: Record<string, number>;
    byScope: Record<string, number>;
  };
  warnings: string[];
}

interface RawEntry {
  ip: string;
  cloud: string;
  source: string;  // instance-private-reachable / instance-public-fallback / lb / eip
  scope: 'private' | 'public';
  resourceId: string;
}

// ─── 白名单 CIDR 匹配(纯 JS 实现,避免依赖) ─────────────────────────

interface Cidr {
  base: number;  // 32-bit 网络号
  mask: number;
  text: string;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(s: string): Cidr | null {
  const m = s.trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!m) return null;
  const base = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (base === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : ((~((1 << (32 - prefix)) - 1)) >>> 0);
  return { base: (base & mask) >>> 0, mask, text: s };
}

export function loadCidrs(file: string): Cidr[] {
  if (!existsSync(file)) return [];
  const out: Cidr[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const c = parseCidr(line);
    if (c) out.push(c);
  }
  return out;
}

function inWhitelist(ip: string, cidrs: Cidr[]): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  for (const c of cidrs) if (((n & c.mask) >>> 0) === c.base) return true;
  return false;
}

function normIp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).split('/')[0].trim();
  if (!s) return null;
  return ipToInt(s) === null ? null : s;
}

// ─── 数据加载 ───────────────────────────────────────────────────────

function pool(): Pool {
  const cfg = appConfig.sources.cloudquery;
  if (cfg.url) return new Pool({ connectionString: cfg.url, max: 2 });
  if (!cfg.host || !cfg.user || !cfg.database) {
    throw new Error('cloudquery PG 未配置:请在 .env 设置 CLOUDQUERY_PG_URL 或 CLOUDQUERY_PG_HOST/USER/PASSWORD/DATABASE');
  }
  return new Pool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, max: 2 });
}

interface InstanceBag {
  cloud: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
  role: 'ecs' | 'eip';
  resourceId: string;
  name?: string;
  privateIps: string[];
  publicIps: string[];
}
interface LbBag {
  cloud: 'alicloud';
  role: 'lb';
  resourceId: string;
  name?: string;
  address: string;
  addressType: 'internet' | 'intranet';
}

interface DbEndpointBag {
  cloud: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
  product: 'rds' | 'redis' | 'mongodb' | 'postgres' | 'mysql' | 'other';
  resourceId: string;
  name?: string;
  host: string;
  port: number;
  protocol: ServiceProtocol;
  scope: 'private' | 'public';
  source: string;
}

/**
 * 一条 IP 所属机器/LB 的元数据。由 collectInstanceMeta() 构建,
 * 供 sync 写 Asset.instanceKey 时查询使用。
 */
export interface InstanceMeta {
  cloud: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
  role: 'ecs' | 'eip' | 'lb';
  resourceId: string;          // 云上 id,如 i-t4n... / lb-xxx
  name?: string;
  instanceKey: string;         // '<cloud>:<role>:<resourceId>'
}

async function loadAlicloudEcs(pg: Pool): Promise<InstanceBag[]> {
  const { rows } = await pg.query(`
    SELECT instance_id, name, private_ip_address, public_ip_address, eip_address, network_interfaces
    FROM alicloud_ecs_instance WHERE status='Running'
  `);
  return rows.map(r => {
    const priv: string[] = [], pub: string[] = [];
    for (const p of (r.private_ip_address || [])) { const ip = normIp(p); if (ip && !priv.includes(ip)) priv.push(ip); }
    for (const p of (r.public_ip_address || [])) { const ip = normIp(p); if (ip && !pub.includes(ip)) pub.push(ip); }
    if (r.eip_address && typeof r.eip_address === 'object') {
      const ip = normIp((r.eip_address as any).IpAddress);
      if (ip && !pub.includes(ip)) pub.push(ip);
    }
    for (const nic of (r.network_interfaces || [])) {
      const pset = nic?.PrivateIpSets?.PrivateIpSet || [];
      for (const p of pset) {
        const ip = normIp(p?.PrivateIpAddress);
        if (ip && !priv.includes(ip)) priv.push(ip);
        const pip = normIp(p?.AssociatedPublicIp?.PublicIpAddress);
        if (pip && !pub.includes(pip)) pub.push(pip);
      }
    }
    return { cloud: 'alicloud' as const, role: 'ecs' as const, resourceId: r.instance_id, name: r.name || undefined, privateIps: priv, publicIps: pub };
  });
}

async function loadAwsEc2(pg: Pool): Promise<InstanceBag[]> {
  const [inst, nics] = await Promise.all([
    pg.query(`SELECT instance_id, private_ip_address::text AS priv, public_ip_address::text AS pub
              FROM aws_ec2_instance WHERE instance_state='running'`),
    pg.query(`SELECT attached_instance_id, private_ip_address, association_public_ip
              FROM aws_ec2_network_interface
              WHERE attached_instance_id IS NOT NULL AND status='in-use'`),
  ]);
  const extra = new Map<string, { priv: string[]; pub: string[] }>();
  for (const n of nics.rows) {
    const bag = extra.get(n.attached_instance_id) || { priv: [], pub: [] };
    const p = normIp(n.private_ip_address); if (p && !bag.priv.includes(p)) bag.priv.push(p);
    const pp = normIp(n.association_public_ip); if (pp && !bag.pub.includes(pp)) bag.pub.push(pp);
    extra.set(n.attached_instance_id, bag);
  }
  return inst.rows.map(r => {
    const priv = r.priv ? [normIp(r.priv)!].filter(Boolean) : [];
    const pub = r.pub ? [normIp(r.pub)!].filter(Boolean) : [];
    const ex = extra.get(r.instance_id);
    if (ex) {
      for (const p of ex.priv) if (!priv.includes(p)) priv.push(p);
      for (const p of ex.pub) if (!pub.includes(p)) pub.push(p);
    }
    return { cloud: 'aws' as const, role: 'ecs' as const, resourceId: r.instance_id, privateIps: priv as string[], publicIps: pub as string[] };
  });
}

async function loadTencentCvm(pg: Pool): Promise<InstanceBag[]> {
  const { rows } = await pg.query(`
    SELECT instance_id, instance_name, private_ip_addresses, public_ip_addresses
    FROM tencentcloud_cvm_instance WHERE instance_state='RUNNING'
  `);
  return rows.map(r => {
    const priv: string[] = [], pub: string[] = [];
    for (const p of (r.private_ip_addresses || [])) { const ip = normIp(p); if (ip && !priv.includes(ip)) priv.push(ip); }
    for (const p of (r.public_ip_addresses || [])) { const ip = normIp(p); if (ip && !pub.includes(ip)) pub.push(ip); }
    return { cloud: 'tencentcloud' as const, role: 'ecs' as const, resourceId: r.instance_id, name: r.instance_name || undefined, privateIps: priv, publicIps: pub };
  });
}

async function loadHuaweiEip(pg: Pool): Promise<InstanceBag[]> {
  // 华为 ECS 表无 IP 字段,只能借 EIP(status=ACTIVE + 已挂机器)反查
  // port_id 是机器网卡 id,同一 port_id 的 pub+priv 属于同一台 ECS,用它当 instance 归属
  const { rows } = await pg.query(`
    SELECT id, port_id, public_ip_address, private_ip_address
    FROM huaweicloud_eip
    WHERE status='ACTIVE' AND port_id IS NOT NULL AND port_id != ''
  `);
  return rows.map(r => {
    const pub = normIp(r.public_ip_address); const priv = normIp(r.private_ip_address);
    return {
      cloud: 'huaweicloud' as const, role: 'eip' as const,
      resourceId: r.port_id || r.id,  // 用 port_id 把多个 EIP 同机器绑一起
      privateIps: priv ? [priv] : [], publicIps: pub ? [pub] : [],
    };
  });
}

async function loadAlicloudSlb(pg: Pool): Promise<LbBag[]> {
  const { rows } = await pg.query(`
    SELECT load_balancer_id, load_balancer_name, address::text AS address, address_type
    FROM alicloud_slb_load_balancer WHERE load_balancer_status='active'
  `);
  return rows.map(r => ({
    cloud: 'alicloud' as const, role: 'lb' as const,
    resourceId: r.load_balancer_id, name: r.load_balancer_name || undefined,
    address: normIp(r.address) || '', addressType: r.address_type,
  })).filter(l => l.address && (l.addressType === 'internet' || l.addressType === 'intranet'));
}

// ─── 云数据库 endpoint 加载 ─────────────────────────────────────────

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function inferCloud(table: string): DbEndpointBag['cloud'] {
  if (table.startsWith('aws_')) return 'aws';
  if (table.startsWith('tencentcloud_')) return 'tencentcloud';
  if (table.startsWith('huaweicloud_')) return 'huaweicloud';
  return 'alicloud';
}

function inferProtocol(productText: string, port?: number): ServiceProtocol {
  const s = productText.toLowerCase();
  if (/redis|kvstore|elasticache/.test(s)) return 'redis';
  if (/mongo|documentdb|docdb/.test(s)) return 'mongodb';
  if (/postgres|pgsql|postgre/.test(s)) return 'postgres';
  if (/mysql|mariadb|polardb|adb|rds/.test(s)) return 'mysql';
  if (/elastic|opensearch/.test(s)) return 'elasticsearch';
  if (port === 6379 || port === 6380 || port === 16379) return 'redis';
  if (port === 27017 || port === 27018 || port === 27019) return 'mongodb';
  if (port === 5432 || port === 5433) return 'postgres';
  if (port === 9200 || port === 9201) return 'elasticsearch';
  if (port === 3306 || port === 3307 || port === 3308 || port === 33060) return 'mysql';
  return 'tcp';
}

function productForProtocol(protocol: ServiceProtocol, text: string): DbEndpointBag['product'] {
  const s = text.toLowerCase();
  if (/redis|kvstore|elasticache/.test(s) || protocol === 'redis') return 'redis';
  if (/mongo|documentdb|docdb/.test(s) || protocol === 'mongodb') return 'mongodb';
  if (/postgres|pgsql|postgre/.test(s) || protocol === 'postgres') return 'postgres';
  if (/mysql|mariadb|polardb|adb/.test(s) || protocol === 'mysql') return 'mysql';
  if (/rds/.test(s)) return 'rds';
  return 'other';
}

function defaultPort(protocol: ServiceProtocol): number | undefined {
  const map: Partial<Record<ServiceProtocol, number>> = {
    mysql: 3306, postgres: 5432, redis: 6379, mongodb: 27017, elasticsearch: 9200,
  };
  return map[protocol];
}

function normalizeHost(raw: unknown): { host?: string; port?: number } {
  if (raw === null || raw === undefined) return {};
  let s = String(raw).trim();
  if (!s || s.length > 300) return {};
  s = s.replace(/^['"]|['"]$/g, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/)[0] || s;

  let port: number | undefined;
  const hp = s.match(/^([a-zA-Z0-9_.-]+):(\d{1,5})$/);
  if (hp) {
    s = hp[1];
    const p = Number(hp[2]);
    if (p > 0 && p < 65536) port = p;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(s)) return {};
  if (!s.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return {};
  // 避免把普通 IP 元数据/区域 ID 当 endpoint；域名或合法 IP 才进入。
  if (!/[a-zA-Z]/.test(s) && ipToInt(s) === null) return {};
  return { host: s.toLowerCase(), port };
}

function collectEndpointStrings(value: unknown, out: unknown[], depth = 0) {
  if (value === null || value === undefined || depth > 4) return;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectEndpointStrings(v, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(endpoint|connection|string|address|domain|dns|host|url)/i.test(k)) collectEndpointStrings(v, out, depth + 1);
    }
  }
}

function valueAsNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return n > 0 && n < 65536 ? n : undefined;
}

function pickPort(row: Record<string, unknown>): number | undefined {
  for (const [k, v] of Object.entries(row)) {
    if (/(^|_)(port|endpoint_port|db_instance_port|connection_port)$/i.test(k)) {
      const n = valueAsNumber(v);
      if (n) return n;
    }
  }
  return undefined;
}

function pickText(row: Record<string, unknown>, patterns: RegExp[]): string | undefined {
  for (const [k, v] of Object.entries(row)) {
    if (!patterns.some(p => p.test(k))) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return undefined;
}

function inferScope(host: string, row: Record<string, unknown>): 'private' | 'public' {
  const text = `${host} ${Object.values(row).filter(v => typeof v === 'string').join(' ')}`.toLowerCase();
  if (/(intranet|internal|private|privatelink|vpc|inner)/.test(text)) return 'private';
  return 'public';
}

async function loadDbEndpoints(pg: Pool, warnings: string[]): Promise<DbEndpointBag[]> {
  const candidates = await pg.query(`
    SELECT table_schema, table_name, array_agg(column_name ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND (
        table_name ILIKE '%rds%' OR table_name ILIKE '%redis%' OR table_name ILIKE '%kvstore%'
        OR table_name ILIKE '%mongo%' OR table_name ILIKE '%documentdb%' OR table_name ILIKE '%docdb%'
        OR table_name ILIKE '%postgres%' OR table_name ILIKE '%mysql%' OR table_name ILIKE '%elasticache%'
        OR table_name ILIKE '%opensearch%' OR table_name ILIKE '%elasticsearch%'
      )
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
  `);

  const endpoints: DbEndpointBag[] = [];
  for (const t of candidates.rows) {
    const schema = String(t.table_schema);
    const table = String(t.table_name);
    const columns: string[] = Array.isArray(t.columns)
      ? t.columns
      : String(t.columns || '').replace(/^{|}$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')).filter(Boolean);
    const hasEndpointish = columns.some(c => /(endpoint|connection|string|address|domain|dns|host|url|port)/i.test(c));
    if (!hasEndpointish) continue;
    if (/(backup|snapshot|log|parameter|security|zone|tag|event|metric|account|database|privilege)/i.test(table)) continue;

    let rows: Record<string, unknown>[] = [];
    try {
      const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 200000`;
      rows = (await pg.query(sql)).rows;
    } catch (err: any) {
      warnings.push(`${table}: ${err.message}`);
      continue;
    }

    for (const row of rows) {
      const endpointValues: unknown[] = [];
      for (const [k, v] of Object.entries(row)) {
        if (/(endpoint|connection|string|address|domain|dns|host|url)/i.test(k)) collectEndpointStrings(v, endpointValues);
      }
      const baseText = `${table} ${pickText(row, [/engine/i, /type/i, /product/i, /category/i]) || ''}`;
      const rowPort = pickPort(row);
      const resourceId = pickText(row, [/_id$/i, /^id$/i, /instance.*id/i, /resource.*id/i]) || `${table}:${endpoints.length}`;
      const name = pickText(row, [/name/i, /description/i, /desc/i]);

      for (const raw of endpointValues) {
        const { host, port: parsedPort } = normalizeHost(raw);
        if (!host) continue;
        const protocol = inferProtocol(baseText, parsedPort || rowPort);
        const port = parsedPort || rowPort || defaultPort(protocol);
        if (!port) continue;
        endpoints.push({
          cloud: inferCloud(table),
          product: productForProtocol(protocol, baseText),
          resourceId,
          name,
          host,
          port,
          protocol,
          scope: inferScope(host, row),
          source: table,
        });
      }
    }
  }

  const seen = new Set<string>();
  return endpoints.filter(e => {
    const key = `${e.host}:${e.port}:${e.protocol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── 主函数 ─────────────────────────────────────────────────────────

/**
 * 统一拉取所有云资源(一次连接,一次并行查询),返回 instances + lbs
 * syncCloudquery / collectInstanceMeta 共享此结果
 */
async function loadAll(warnings: string[]): Promise<{ instances: InstanceBag[]; lbs: LbBag[] }> {
  const pg = pool();
  try {
    const [a, b, c, d, e] = await Promise.all([
      loadAlicloudEcs(pg).catch(err => { warnings.push(`alicloud_ecs: ${err.message}`); return [] as InstanceBag[]; }),
      loadAwsEc2(pg).catch(err => { warnings.push(`aws_ec2: ${err.message}`); return [] as InstanceBag[]; }),
      loadTencentCvm(pg).catch(err => { warnings.push(`tencentcloud_cvm: ${err.message}`); return [] as InstanceBag[]; }),
      loadHuaweiEip(pg).catch(err => { warnings.push(`huaweicloud_eip: ${err.message}`); return [] as InstanceBag[]; }),
      loadAlicloudSlb(pg).catch(err => { warnings.push(`alicloud_slb: ${err.message}`); return [] as LbBag[]; }),
    ]);
    return { instances: [...a, ...b, ...c, ...d], lbs: e };
  } finally {
    await pg.end();
  }
}

/**
 * 对外导出:构建 IP → InstanceMeta 的映射,供 Asset 表 upsert 使用。
 * 同一次 sync 调用此函数,零额外数据库查询(复用 loadAll 的数据)。
 */
export async function collectInstanceMeta(): Promise<{ map: Map<string, InstanceMeta>; warnings: string[] }> {
  const warnings: string[] = [];
  const { instances, lbs } = await loadAll(warnings);
  const map = buildInstanceMetaMap(instances, lbs);
  return { map, warnings };
}

function buildInstanceMetaMap(instances: InstanceBag[], lbs: LbBag[]): Map<string, InstanceMeta> {
  const map = new Map<string, InstanceMeta>();
  // 先写 instance,再写 lb(lb 与 instance 的 IP 理论上不重叠;若重叠优先 instance 先赢,lb 后覆盖也可接受)
  for (const inst of instances) {
    const meta: InstanceMeta = {
      cloud: inst.cloud, role: inst.role, resourceId: inst.resourceId,
      name: inst.name, instanceKey: `${inst.cloud}:${inst.role}:${inst.resourceId}`,
    };
    for (const ip of inst.privateIps) if (!map.has(ip)) map.set(ip, meta);
    for (const ip of inst.publicIps) if (!map.has(ip)) map.set(ip, meta);
  }
  for (const lb of lbs) {
    const meta: InstanceMeta = {
      cloud: lb.cloud, role: lb.role, resourceId: lb.resourceId,
      name: lb.name, instanceKey: `${lb.cloud}:${lb.role}:${lb.resourceId}`,
    };
    if (!map.has(lb.address)) map.set(lb.address, meta);
  }
  return map;
}

export async function syncCloudquery(strategy: SyncStrategy): Promise<SyncResult> {
  const warnings: string[] = [];
  if (strategy === 'db-endpoints') {
    const pg = pool();
    try {
      const endpoints = await loadDbEndpoints(pg, warnings);
      const entries: AssetListEntry[] = endpoints.map(e => ({
        ip: e.host,
        address: e.host,
        hostname: e.host,
        assetKind: 'db_endpoint',
        endpointPort: e.port,
        endpointProtocol: e.protocol,
        cloudProduct: e.product,
        scope: e.scope,
        source: 'cloudquery',
        instanceKey: `${e.cloud}:db:${e.resourceId}`,
        instanceRole: 'db',
        cloud: e.cloud,
        instanceName: e.name,
      }));
      const byCloud: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byScope: Record<string, number> = {};
      for (const e of endpoints) {
        byCloud[e.cloud] = (byCloud[e.cloud] || 0) + 1;
        bySource[e.source] = (bySource[e.source] || 0) + 1;
        byScope[e.scope] = (byScope[e.scope] || 0) + 1;
      }
      return {
        strategy,
        entries,
        breakdown: { total: endpoints.length, uniqueIps: entries.length, byCloud, bySource, byScope },
        warnings,
      };
    } finally {
      await pg.end();
    }
  }

  const cidrsFile = appConfig.sources.cloudquery.reachableCidrsFile;
  const cidrs = loadCidrs(cidrsFile);
  if (cidrs.length === 0) warnings.push(`未读到白名单 CIDR(${cidrsFile}),内网可达判定将全部失败`);

  const { instances, lbs } = await loadAll(warnings);
  // 一次性构建 ip→机器元数据映射,避免多次线性查找
  const metaMap = buildInstanceMetaMap(instances, lbs);

  const raw: RawEntry[] = [];
  for (const inst of instances) {
    const reach = inst.privateIps.filter(ip => inWhitelist(ip, cidrs));
    const pub = inst.publicIps;
    if (strategy === 'all-ip') {
      for (const ip of reach) raw.push({ ip, cloud: inst.cloud, source: 'instance-private-reachable', scope: 'private', resourceId: inst.resourceId });
      for (const ip of pub) raw.push({ ip, cloud: inst.cloud, source: 'instance-public', scope: 'public', resourceId: inst.resourceId });
    } else if (strategy === 'db-scan') {
      if (reach.length > 0) {
        for (const ip of reach) raw.push({ ip, cloud: inst.cloud, source: 'instance-private-reachable', scope: 'private', resourceId: inst.resourceId });
      } else if (pub.length > 0) {
        for (const ip of pub) raw.push({ ip, cloud: inst.cloud, source: 'instance-public-fallback', scope: 'public', resourceId: inst.resourceId });
      }
    } else if (strategy === 'public') {
      for (const ip of pub) raw.push({ ip, cloud: inst.cloud, source: 'instance', scope: 'public', resourceId: inst.resourceId });
    } else {  // private
      for (const ip of reach) raw.push({ ip, cloud: inst.cloud, source: 'instance', scope: 'private', resourceId: inst.resourceId });
    }
  }
  for (const lb of lbs) {
    const isPub = lb.addressType === 'internet';
    if (strategy === 'db-scan' || strategy === 'all-ip') {
      // LB 公网、内网都记录;内网如果不在白名单也保留(用户要求)
      raw.push({ ip: lb.address, cloud: lb.cloud, source: 'lb', scope: isPub ? 'public' : 'private', resourceId: lb.resourceId });
    } else if (strategy === 'public' && isPub) {
      raw.push({ ip: lb.address, cloud: lb.cloud, source: 'lb', scope: 'public', resourceId: lb.resourceId });
    } else if (strategy === 'private' && !isPub && inWhitelist(lb.address, cidrs)) {
      raw.push({ ip: lb.address, cloud: lb.cloud, source: 'lb', scope: 'private', resourceId: lb.resourceId });
    }
  }

  // 按 ip 去重 + 转结构化条目(从 metaMap 拿机器元数据)
  const seen = new Set<string>();
  const entries: AssetListEntry[] = [];
  for (const r of raw) {
    if (seen.has(r.ip)) continue;
    seen.add(r.ip);
    const m = metaMap.get(r.ip);
    entries.push({
      ip: r.ip,
      scope: r.scope,
      source: 'cloudquery',
      ...(m && {
        instanceKey: m.instanceKey,
        instanceRole: m.role,
        cloud: m.cloud,
        instanceName: m.name,
      }),
    });
  }

  const byCloud: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const r of raw) {
    byCloud[r.cloud] = (byCloud[r.cloud] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byScope[r.scope] = (byScope[r.scope] || 0) + 1;
  }

  return {
    strategy,
    entries,
    breakdown: { total: raw.length, uniqueIps: entries.length, byCloud, bySource, byScope },
    warnings,
  };
}

export function cloudqueryConfigured(): boolean {
  const c = appConfig.sources.cloudquery;
  return !!(c.url || (c.host && c.user && c.database));
}
