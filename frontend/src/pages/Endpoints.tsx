import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Pagination } from '../components/Pagination';
import { beijingFileTimestamp, formatBeijingTime } from '../utils/time';

// CSV 导出辅助
function toCsv(rows: Record<string, any>[], columns: string[]): string {
  const header = columns.join(',');
  const esc = (v: any) => {
    const s = v === undefined || v === null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = rows.map(r => columns.map(c => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const ALL_COLUMNS = [
  { key: 'ip', label: 'IP' },
  { key: 'port', label: '端口' },
  { key: 'protocol', label: '协议' },
  { key: 'product', label: '产品' },
  { key: 'scope', label: '公私网' },
  { key: 'instance', label: '机器' },
  { key: 'version', label: '版本' },
  { key: 'title', label: 'Title' },
  { key: 'fingerprints', label: '指纹' },
  { key: 'firstSeenAt', label: '首次发现' },
  { key: 'lastSeenAt', label: '最后发现' },
  { key: 'status', label: '状态' },
];

const IP_COLUMNS = [
  { key: 'ip', label: 'IP' },
  { key: 'scope', label: '公私网' },
  { key: 'instance', label: '机器' },
  { key: 'endpointCount', label: '端点数' },
  { key: 'serviceCount', label: '服务数' },
  { key: 'ports', label: '端口' },
  { key: 'protocols', label: '协议' },
  { key: 'products', label: '产品' },
  { key: 'webPathCount', label: 'Web路径数' },
  { key: 'firstSeenAt', label: '首次发现' },
  { key: 'lastSeenAt', label: '最后发现' },
  { key: 'status', label: '状态' },
];

const INSTANCE_COLUMNS = [
  { key: 'instance', label: '机器' },
  { key: 'cloud', label: '云厂商' },
  { key: 'role', label: '角色' },
  { key: 'instanceName', label: '机器名' },
  { key: 'publicIps', label: '公网IP' },
  { key: 'privateIps', label: '私网IP' },
  { key: 'allIps', label: '全部IP' },
  { key: 'endpointCount', label: '端点数' },
  { key: 'serviceCount', label: '服务数' },
  { key: 'ports', label: '端口' },
  { key: 'protocols', label: '协议' },
  { key: 'products', label: '产品' },
  { key: 'webPathCount', label: 'Web路径数' },
  { key: 'firstSeenAt', label: '首次发现' },
  { key: 'lastSeenAt', label: '最后发现' },
  { key: 'status', label: '状态' },
];

const DB_PRODUCT_OPTIONS = [
  'MySQL', 'MariaDB', 'PolarDB', 'ADB', 'StarRocks', 'TiDB', 'OceanBase', 'Doris',
  'PostgreSQL', 'Redis', 'MongoDB', 'Cassandra', 'Elasticsearch', 'OpenSearch', 'Solr',
  'ClickHouse', 'CouchDB', 'InfluxDB', 'Aerospike', 'HBase', 'HDFS', 'Hive',
  'Memcached', 'ZooKeeper', 'etcd', 'Neo4j', 'RabbitMQ', 'Kafka', 'RocketMQ', 'Pulsar',
  'MSSQL', 'Oracle', 'Consul', 'Nacos', 'Trino', 'Presto',
];

const DEFAULT_ENDPOINT_EXPORT_COLS = ['ip', 'port', 'scope', 'instance', 'protocol', 'product', 'version', 'title', 'fingerprints', 'firstSeenAt', 'lastSeenAt', 'status'];
const DEFAULT_IP_EXPORT_COLS = ['ip', 'scope', 'instance', 'endpointCount', 'serviceCount', 'ports', 'protocols', 'products', 'webPathCount', 'lastSeenAt', 'status'];
const DEFAULT_INSTANCE_EXPORT_COLS = ['instance', 'cloud', 'role', 'instanceName', 'publicIps', 'privateIps', 'endpointCount', 'serviceCount', 'ports', 'protocols', 'products', 'webPathCount', 'lastSeenAt', 'status'];

type Row = {
  id: string;
  ip: string;
  port: number;
  firstSeenAt: string;
  lastSeenAt: string;
  disappearedAt?: string;
  service?: {
    protocol?: string;
    product?: string;
    version?: string;
    title?: string;
    fingerprints?: { name: string; version?: string }[];
    webPaths?: {
      id: string;
      url: string;
      path: string;
      statusCode: number;
      title?: string;
      verified?: 'real' | 'suspected' | 'unknown';
      tags?: string[];
      lastSeenAt: string;
      disappearedAt?: string;
    }[];
  };
  instance?: {
    key: string;
    role?: 'ecs' | 'lb' | 'eip' | 'nat' | 'nic';
    cloud?: 'alicloud' | 'aws' | 'tencentcloud' | 'huaweicloud';
    name?: string;
  };
  scope?: 'public' | 'private';
};

const CLOUD_BADGE: Record<string, string> = {
  alicloud: 'aliyun', aws: 'AWS', tencentcloud: '腾讯', huaweicloud: '华为',
};

function WebPathSummary({ paths, showGone = false }: { paths?: NonNullable<Row['service']>['webPaths']; showGone?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const list = showGone ? (paths || []) : (paths || []).filter(p => !p.disappearedAt);
  if (list.length === 0) return <span style={{ color: 'var(--text-dim)' }}>-</span>;
  const visible = expanded ? list : list.slice(0, 3);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', maxWidth: '260px' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{list.length} 路径</div>
      {visible.map(p => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer"
          title={`${p.statusCode} ${p.url}${p.title ? ` · ${p.title}` : ''}`}
          style={{
            color: p.verified === 'real' ? 'var(--accent)' : 'var(--text-dim)',
            fontFamily: 'monospace', fontSize: '0.72rem',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
          {p.statusCode} {p.path}
        </a>
      ))}
      {list.length > 3 && (
        <button
          type="button"
          className="btn"
          onClick={() => setExpanded(v => !v)}
          style={{
            alignSelf: 'flex-start',
            padding: '0.05rem 0.35rem',
            fontSize: '0.7rem',
            lineHeight: 1.4,
          }}
        >
          {expanded ? '收起' : `+${list.length - 3} 展开`}
        </button>
      )}
    </div>
  );
}

function ByInstanceView({ rows, expanded, setExpanded, showGone = false }: {
  rows: Row[];
  expanded: Record<string, boolean>;
  setExpanded: (e: Record<string, boolean>) => void;
  showGone?: boolean;
}) {
  // 按 instanceKey 分组(无 instance 的按 IP 单独成组)
  const groups = new Map<string, { key: string; inst?: Row['instance']; ips: Set<string>; rows: Row[] }>();
  for (const r of rows) {
    const key = r.instance?.key || `_ip:${r.ip}`;
    let g = groups.get(key);
    if (!g) { g = { key, inst: r.instance, ips: new Set(), rows: [] }; groups.set(key, g); }
    g.ips.add(r.ip);
    g.rows.push(r);
  }
  const list = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {list.map(g => {
        const isUnknown = g.key.startsWith('_ip:');
        const inst = g.inst;
        const shortId = isUnknown ? '-' : g.key.split(':').slice(-1)[0]?.slice(0, 16);
        const isExp = !!expanded[g.key];
        const aliveCount = g.rows.filter(r => !r.disappearedAt).length;
        const svcCount = g.rows.filter(r => r.service).length;
        const goneCount = g.rows.filter(r => r.disappearedAt).length;
        return (
          <div key={g.key} style={{
            border: '1px solid var(--border)', borderRadius: '4px', marginBottom: '0.5rem',
            background: isExp ? 'rgba(79,195,247,0.04)' : 'var(--bg-card)',
          }}>
            <div style={{
              padding: '0.5rem 0.75rem', cursor: 'pointer', display: 'flex',
              alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap',
            }} onClick={() => setExpanded({ ...expanded, [g.key]: !isExp })}>
              <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.85rem' }} title={g.key}>
                {isExp ? '▾' : '▸'} {!isUnknown && inst?.cloud && (
                  <span style={{
                    display: 'inline-block', marginRight: '0.3rem', padding: '0 0.3rem',
                    background: 'rgba(79,195,247,0.15)', color: 'var(--accent)', borderRadius: '3px', fontSize: '0.7rem',
                  }}>{CLOUD_BADGE[inst.cloud] || inst.cloud}</span>
                )}
                {isUnknown ? g.key.slice(4) : `${inst?.role}·${shortId}`}
              </span>
              {inst?.name && <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{inst.name}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                {[...g.ips].slice(0, 3).join(', ')}{g.ips.size > 3 ? ` +${g.ips.size - 3}` : ''}
              </span>
              <span style={{ fontSize: '0.75rem' }}>
                <b>{aliveCount}</b> 端点
                {svcCount > 0 && <span style={{ color: 'var(--accent)' }}> · {svcCount} 服务</span>}
                {goneCount > 0 && <span style={{ color: 'var(--danger)' }}> · {goneCount} 消失</span>}
              </span>
            </div>
            {isExp && (
              <table style={{ margin: 0, borderTop: '1px solid var(--border)' }}>
                <thead><tr><th>IP</th><th>端口</th><th>网络</th><th>协议</th><th>产品</th><th>版本</th><th>Title</th><th>Web路径</th><th>指纹</th><th>状态</th></tr></thead>
                <tbody>
                  {g.rows.map(r => {
                    const s = r.service;
                    const fps = s?.fingerprints || [];
                    return (
                      <tr key={r.id} style={r.disappearedAt ? { opacity: 0.5 } : {}}>
                        <td style={{ fontFamily: 'monospace' }}>{r.ip}</td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.port}</td>
                        <td>{r.scope ? (r.scope === 'public' ? '公网' : '私网') : '-'}</td>
                        <td>{s?.protocol || '-'}</td>
                        <td>{s?.product || '-'}</td>
                        <td>{s?.version || '-'}</td>
                        <td style={{ fontSize: '0.8rem', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s?.title || '-'}</td>
                        <td><WebPathSummary paths={s?.webPaths} showGone={showGone} /></td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {fps.length === 0 ? '-' : fps.map(f => f.name + (f.version ? `@${f.version}` : '')).join(', ')}
                        </td>
                        <td>
                          {r.disappearedAt ? <span className="badge badge-low">消失</span>
                            : s ? <span className="badge badge-info">服务</span>
                            : <span className="badge badge-low" style={{ opacity: 0.7 }}>活端点</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Endpoints() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [facets, setFacets] = useState<{ protocols: string[]; products: string[]; counts: any }>({
    protocols: [], products: [], counts: { alive: 0, gone: 0, withService: 0, productCount: 0 },
  });
  const [filter, setFilter] = useState({ q: '', webPath: '', instance: '', protocol: '', product: '', scope: '', onlyService: false, onlyWebPath: false, showGone: false });
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCols, setExportCols] = useState<string[]>(DEFAULT_ENDPOINT_EXPORT_COLS);
  const [exportDimension, setExportDimension] = useState<'endpoint' | 'ip' | 'instance'>('endpoint');
  const [exportOnlyDb, setExportOnlyDb] = useState(false);
  const [exportScopes, setExportScopes] = useState<Array<'public' | 'private'>>(['public', 'private']);
  const [exportDbProducts, setExportDbProducts] = useState<string[]>(DB_PRODUCT_OPTIONS);
  const [viewMode, setViewMode] = useState<'flat' | 'byInstance'>('flat');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>({ field: '', dir: 'desc' });
  const loadingRef = useRef(false);
  const requestSeq = useRef(0);

  const buildParams = (extra: Record<string, any> = {}): Record<string, string | number> => {
    const p: Record<string, string | number> = { withService: 'true', ...extra };
    if (filter.q) p.q = filter.q;
    if (filter.webPath) p.webPath = filter.webPath;
    if (filter.instance) p.instance = filter.instance;
    if (filter.protocol) p.protocol = filter.protocol;
    if (filter.product) p.product = filter.product;
    if (filter.scope) p.scope = filter.scope;
    if (filter.onlyService) p.hasService = 'true';
    if (filter.onlyWebPath) p.hasWebPath = 'true';
    if (filter.showGone) p.showGone = 'true';
    if (sort.field) p.sort = `${sort.field}:${sort.dir}`;
    return p;
  };

  const load = () => {
    if (loadingRef.current) {
      requestSeq.current++;
      loadingRef.current = false;
    }
    loadingRef.current = true;
    const seq = ++requestSeq.current;
    return api.getEndpoints(buildParams({ page, pageSize })).then((r: any) => {
      if (seq !== requestSeq.current) return;
      setRows(r.data || []);
      setTotal(r.total || 0);
      setTotalPages(r.totalPages || 1);
      setLastRefreshedAt(new Date());
    }).finally(() => {
      if (seq === requestSeq.current) loadingRef.current = false;
    });
  };
  const loadFacets = () => api.getEndpointFacets(filter.showGone ? { showGone: 'true' } : undefined).then((r: any) => r.ok && setFacets(r.data));

  useEffect(() => { load(); }, [page, pageSize, filter, sort]);
  useEffect(() => { loadFacets(); }, [filter.showGone]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      load();
      loadFacets();
    }, 15000);
    return () => clearInterval(timer);
  }, [autoRefresh, page, pageSize, filter, sort]);

  const onFilterChange = (patch: Partial<typeof filter>) => {
    setFilter({ ...filter, ...patch });
    setPage(1);
  };

  const onSort = (field: string, preferredDir: 'asc' | 'desc' = 'asc') => {
    setSort(prev => {
      if (prev.field !== field) return { field, dir: preferredDir };
      return { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
    setPage(1);
  };

  const sortMark = (field: string) => sort.field === field ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const SortTh = ({ field, children, preferredDir = 'asc' }: { field: string; children: React.ReactNode; preferredDir?: 'asc' | 'desc' }) => (
    <th
      onClick={() => onSort(field, preferredDir)}
      title="点击排序，再点切换升/降序"
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {children}{sortMark(field)}
    </th>
  );

  const toExportRow = (r: Row): Record<string, any> => ({
    ip: r.ip,
    port: r.port,
    protocol: r.service?.protocol || '',
    product: r.service?.product || '',
    scope: r.scope || '',
    version: r.service?.version || '',
    title: r.service?.title || '',
    fingerprints: (r.service?.fingerprints || []).map(f => f.name + (f.version ? `@${f.version}` : '')).join('; '),
    instance: r.instance ? `${r.instance.cloud || ''} ${r.instance.role || ''} ${r.instance.name || ''} ${r.instance.key || ''}`.trim() : '',
    firstSeenAt: r.firstSeenAt || '',
    lastSeenAt: r.lastSeenAt || '',
    status: r.disappearedAt ? 'gone' : (r.service ? 'service' : 'alive'),
  });

  const currentExportColumns = exportDimension === 'instance' ? INSTANCE_COLUMNS : exportDimension === 'ip' ? IP_COLUMNS : ALL_COLUMNS;

  const normalizeProduct = (v?: string) => (v || '').toLowerCase().replace(/[\s_-]+/g, '');
  const selectedDbProducts = () => new Set(exportDbProducts.map(normalizeProduct));
  const isDbRow = (r: Row) => {
    const selected = selectedDbProducts();
    const values = [
      r.service?.product,
      r.service?.protocol,
      ...(r.service?.fingerprints || []).map(f => f.name),
    ].map(normalizeProduct).filter(Boolean);
    return values.some(v => selected.has(v));
  };

  const aggregateRows = (input: Row[], dimension: 'endpoint' | 'ip' | 'instance'): Record<string, any>[] => {
    if (dimension === 'endpoint') return input.map(toExportRow);

    const groups = new Map<string, Row[]>();
    for (const r of input) {
      const key = dimension === 'ip' ? r.ip : (r.instance?.key || `_ip:${r.ip}`);
      const arr = groups.get(key) || [];
      arr.push(r);
      groups.set(key, arr);
    }

    return [...groups.entries()].map(([key, rs]) => {
      const inst = rs.find(r => r.instance)?.instance;
      const scopes = [...new Set(rs.map(r => r.scope).filter(Boolean))];
      const publicIps = [...new Set(rs.filter(r => r.scope === 'public').map(r => r.ip))].sort();
      const privateIps = [...new Set(rs.filter(r => r.scope === 'private').map(r => r.ip))].sort();
      const allIps = [...new Set(rs.map(r => r.ip))].sort();
      const ports = [...new Set(rs.map(r => r.port))].sort((a, b) => a - b);
      const protocols = [...new Set(rs.map(r => r.service?.protocol).filter(Boolean))].sort();
      const products = [...new Set(rs.map(r => r.service?.product).filter(Boolean))].sort();
      const firstSeen = rs.map(r => r.firstSeenAt).filter(Boolean).sort()[0] || '';
      const lastSeen = rs.map(r => r.lastSeenAt).filter(Boolean).sort().slice(-1)[0] || '';
      const webPathCount = rs.reduce((n, r) => n + (r.service?.webPaths || []).filter(p => !p.disappearedAt).length, 0);
      const serviceCount = rs.filter(r => r.service).length;
      const aliveCount = rs.filter(r => !r.disappearedAt).length;
      const status = aliveCount === 0 ? 'gone' : serviceCount > 0 ? 'service' : 'alive';
      return {
        ip: dimension === 'ip' ? key : '',
        scope: scopes.map(s => s === 'public' ? '公网' : '私网').join('/'),
        instance: inst ? `${inst.cloud || ''} ${inst.role || ''} ${inst.name || ''} ${inst.key || ''}`.trim() : key.replace(/^_ip:/, ''),
        cloud: inst?.cloud || '',
        role: inst?.role || '',
        instanceName: inst?.name || '',
        publicIps: publicIps.join('; '),
        privateIps: privateIps.join('; '),
        allIps: allIps.join('; '),
        endpointCount: rs.length,
        serviceCount,
        ports: ports.join('; '),
        protocols: protocols.join('; '),
        products: products.join('; '),
        webPathCount,
        firstSeenAt: firstSeen,
        lastSeenAt: lastSeen,
        status,
      };
    }).sort((a, b) => String(a.instance || a.ip).localeCompare(String(b.instance || b.ip)));
  };

  const fetchAllExportRows = async (): Promise<Row[]> => {
    const first: any = await api.getEndpoints(buildParams({ page: 1, pageSize: 500 }));
    let all: Row[] = first.data || [];
    const pages = first.totalPages || 1;
    for (let p = 2; p <= pages; p++) {
      const res: any = await api.getEndpoints(buildParams({ page: p, pageSize: 500 }));
      all = all.concat(res.data || []);
    }
    return all;
  };

  // 导出:另起一次无分页请求拿全部
  const doExport = async (format: 'csv' | 'json') => {
    let all = await fetchAllExportRows();
    all = all.filter(r => !r.scope || exportScopes.includes(r.scope));
    if (exportOnlyDb) all = all.filter(isDbRow);
    const data = aggregateRows(all, exportDimension);
    const ts = beijingFileTimestamp();
    const desc = exportOnlyDb ? '-data-services' : filter.product ? `-${filter.product}` : filter.protocol ? `-${filter.protocol}` : filter.onlyService ? '-service' : '';
    const dim = exportDimension === 'instance' ? '-by-machine' : exportDimension === 'ip' ? '-by-ip' : '';
    if (format === 'csv') {
      const csv = toCsv(data, exportCols);
      download(`endpoints${desc}${dim}-${ts}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
    } else {
      const picked = data.map(row => {
        const o: any = {};
        for (const c of exportCols) o[c] = row[c];
        return o;
      });
      download(`endpoints${desc}${dim}-${ts}.json`, JSON.stringify(picked, null, 2), 'application/json');
    }
    setExportOpen(false);
  };

  const toggleCol = (key: string) => {
    setExportCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const setDimension = (dim: 'endpoint' | 'ip' | 'instance') => {
    setExportDimension(dim);
    setExportCols(dim === 'instance' ? DEFAULT_INSTANCE_EXPORT_COLS : dim === 'ip' ? DEFAULT_IP_EXPORT_COLS : DEFAULT_ENDPOINT_EXPORT_COLS);
  };

  const toggleScope = (scope: 'public' | 'private') => {
    setExportScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]);
  };

  const toggleDbProduct = (product: string) => {
    setExportDbProducts(prev => prev.includes(product) ? prev.filter(p => p !== product) : [...prev, product]);
  };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>活端点与服务</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        ip:port 的当前态。"端口发现"产出活端点,"指纹识别"给端点贴上协议/产品/指纹形成服务。
        勾选"仅显示已识别服务"可以只看有指纹的记录。端口扫描运行中会边发现边写入，页面默认每 15 秒自动刷新。
      </p>

      <div className="stats-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card"><div className="value">{facets.counts.alive}</div><div className="label">在线活端点</div></div>
        <div className="stat-card"><div className="value" style={{ color: 'var(--accent)' }}>{facets.counts.withService}</div><div className="label">已识别服务</div></div>
        <div className="stat-card"><div className="value">{facets.counts.productCount}</div><div className="label">识别产品</div></div>
        <div className="stat-card"><div className="value" style={{ color: 'var(--danger)' }}>{facets.counts.gone}</div><div className="label">已消失</div></div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <div className="form-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'center' }}>
            <input placeholder="搜索 IP / 端口 / 协议 / 产品 / title / 指纹" style={{ flex: '1 1 260px', minWidth: '240px' }}
              value={filter.q} onChange={e => onFilterChange({ q: e.target.value })} />
            <input placeholder="Web路径模糊搜索，如 actuator / heapdump / swagger / .git" style={{ flex: '1 1 320px', minWidth: '280px' }}
              value={filter.webPath} onChange={e => onFilterChange({ webPath: e.target.value })} />
            <input placeholder="机器 ID / 名称 / IP" style={{ flex: '1 1 220px', minWidth: '200px' }}
              value={filter.instance} onChange={e => onFilterChange({ instance: e.target.value })} />
          </div>
          <div className="form-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={filter.protocol} onChange={e => onFilterChange({ protocol: e.target.value })} style={{ minWidth: '120px' }}>
              <option value="">全部协议</option>
              {facets.protocols.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filter.product} onChange={e => onFilterChange({ product: e.target.value })} style={{ minWidth: '130px' }}>
              <option value="">全部产品</option>
              {facets.products.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filter.scope} onChange={e => onFilterChange({ scope: e.target.value })} style={{ minWidth: '110px' }}>
              <option value="">全部网络</option>
              <option value="public">公网</option>
              <option value="private">私网</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={filter.onlyService} onChange={e => onFilterChange({ onlyService: e.target.checked })} />
              仅已识别服务
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={filter.onlyWebPath} onChange={e => onFilterChange({ onlyWebPath: e.target.checked })} />
              仅有Web路径
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={filter.showGone} onChange={e => onFilterChange({ showGone: e.target.checked })} />
              显示已消失
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              自动刷新
            </label>
            <button className="btn" onClick={() => { load(); loadFacets(); }} style={{ whiteSpace: 'nowrap' }}>
              ↻ 刷新
            </button>
            <button className="btn btn-primary" onClick={() => setExportOpen(!exportOpen)} style={{ whiteSpace: 'nowrap' }}>
              ⬇ 导出 ({total})
            </button>
          </div>
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
          {autoRefresh ? '自动刷新: 开启(15s)' : '自动刷新: 关闭'}
          {lastRefreshedAt && ` · 最近刷新 ${lastRefreshedAt.toLocaleTimeString('zh-CN', { hour12: false })}`}
          {!filter.onlyService && ' · 端口发现阶段的新活端点会先显示为“活端点”，指纹模块完成后再更新为“服务”。'}
        </div>

        {exportOpen && (
          <div className="module-cfg" style={{ marginTop: '0.5rem' }}>
            <h4>导出设置</h4>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
              将导出当前筛选条件下的 <b>{total}</b> 条服务/端点记录(自动拉取全部分页)。可在这里生成数据库台账、公网/内网活端点台账，导出对象仍然是“活端点与服务”。
            </div>
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <label style={{ margin: 0 }}>导出维度</label>
              <select value={exportDimension} onChange={e => setDimension(e.target.value as any)}>
                <option value="endpoint">端点明细(ip:port)</option>
                <option value="ip">IP 维度</option>
                <option value="instance">机器维度(含公网/私网对应)</option>
              </select>
              <label style={{ margin: 0, cursor: 'pointer' }}>
                <input type="checkbox" checked={exportScopes.includes('public')} onChange={() => toggleScope('public')} /> 公网
              </label>
              <label style={{ margin: 0, cursor: 'pointer' }}>
                <input type="checkbox" checked={exportScopes.includes('private')} onChange={() => toggleScope('private')} /> 私网
              </label>
              <label style={{ margin: 0, cursor: 'pointer' }}>
                <input type="checkbox" checked={exportOnlyDb} onChange={e => setExportOnlyDb(e.target.checked)} /> 仅数据库/数据服务
              </label>
            </div>
            {exportOnlyDb && (
              <div style={{ marginBottom: '0.6rem' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.35rem' }}>
                  数据库/数据服务指纹(默认全选，可按需要取消):
                  <button className="btn" style={{ marginLeft: '0.5rem', padding: '0.1rem 0.35rem', fontSize: '0.7rem' }} onClick={() => setExportDbProducts(DB_PRODUCT_OPTIONS)}>全选</button>
                  <button className="btn" style={{ marginLeft: '0.3rem', padding: '0.1rem 0.35rem', fontSize: '0.7rem' }} onClick={() => setExportDbProducts([])}>清空</button>
                </div>
                <div className="row" style={{ gap: '0.45rem' }}>
                  {DB_PRODUCT_OPTIONS.map(p => (
                    <label key={p} style={{ margin: 0, cursor: 'pointer', fontSize: '0.78rem' }}>
                      <input type="checkbox" checked={exportDbProducts.includes(p)} onChange={() => toggleDbProduct(p)} />
                      {' '}{p}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.35rem' }}>
              选择要包含的列:
            </div>
            <div className="row">
              {currentExportColumns.map(c => (
                <label key={c.key} style={{ margin: 0, cursor: 'pointer' }}>
                  <input type="checkbox" checked={exportCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                  {' '}{c.label}
                </label>
              ))}
            </div>
            <div className="row" style={{ marginTop: '0.6rem' }}>
              <button className="btn btn-primary" onClick={() => doExport('csv')}>下载 CSV</button>
              <button className="btn" onClick={() => doExport('json')}>下载 JSON</button>
              <button className="btn" onClick={() => setExportOpen(false)}>取消</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.5rem' }}>
          <button className={`btn ${viewMode === 'flat' ? 'btn-primary' : ''}`}
            style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
            onClick={() => setViewMode('flat')}>展平视图</button>
          <button className={`btn ${viewMode === 'byInstance' ? 'btn-primary' : ''}`}
            style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
            onClick={() => setViewMode('byInstance')}>🖥 按机器</button>
          {viewMode === 'byInstance' && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', alignSelf: 'center' }}>
              ↑ 把当前页的端点按机器折叠;若要看全部机器请把每页调大(下方分页)
            </span>
          )}
        </div>

        {viewMode === 'flat' ? (
        <table style={{ marginTop: '0.5rem' }}>
          <thead><tr>
            <SortTh field="ip">IP</SortTh>
            <SortTh field="port">端口</SortTh>
            <SortTh field="scope">网络</SortTh>
            <SortTh field="instance">机器</SortTh>
            <SortTh field="protocol">协议</SortTh>
            <SortTh field="product">产品</SortTh>
            <SortTh field="version">版本</SortTh>
            <SortTh field="title">Title</SortTh>
            <SortTh field="webPathCount" preferredDir="desc">Web路径</SortTh>
            <th>指纹</th>
            <SortTh field="lastSeenAt" preferredDir="desc">首次/最后</SortTh>
            <SortTh field="status" preferredDir="desc">状态</SortTh>
          </tr></thead>
          <tbody>
            {(() => {
              // 同 instanceKey 交替底色,让视觉分组自然涌现
              let groupIdx = 0;
              let prevKey: string | undefined = undefined;
              return rows.map(r => {
                const s = r.service;
                const fps = s?.fingerprints || [];
                const inst = r.instance;
                const instShort = inst?.key?.split(':').slice(-1)[0]?.slice(0, 12);
                const curKey = inst?.key || `_${r.ip}`;
                if (curKey !== prevKey) { groupIdx++; prevKey = curKey; }
                const bg = inst && (groupIdx % 2 === 0) ? 'rgba(79,195,247,0.04)' : undefined;
                const style: React.CSSProperties = { ...(r.disappearedAt ? { opacity: 0.5 } : {}), ...(bg ? { background: bg } : {}) };
                return (
                <tr key={r.id} style={style}>
                  <td style={{ fontFamily: 'monospace' }}>{r.ip}</td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.port}</td>
                  <td>{r.scope ? <span className="badge badge-info">{r.scope === 'public' ? '公网' : '私网'}</span> : '-'}</td>
                  <td style={{ fontSize: '0.75rem' }}>
                    {inst ? (
                      <>
                        <div style={{ fontFamily: 'monospace' }} title={inst.key}>
                          {inst.cloud && <span style={{
                            display: 'inline-block', marginRight: '0.3rem', padding: '0 0.3rem',
                            background: 'rgba(79,195,247,0.15)', color: 'var(--accent)', borderRadius: '3px',
                            fontSize: '0.65rem',
                          }}>{CLOUD_BADGE[inst.cloud] || inst.cloud}</span>}
                          {inst.role}·{instShort}
                        </div>
                        {inst.name && <div style={{ color: 'var(--text-dim)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst.name}</div>}
                      </>
                    ) : <span style={{ color: 'var(--text-dim)' }}>-</span>}
                  </td>
                  <td>{s?.protocol || '-'}</td>
                  <td>{s?.product || '-'}</td>
                  <td>{s?.version || '-'}</td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s?.title || '-'}</td>
                  <td><WebPathSummary paths={s?.webPaths} showGone={filter.showGone} /></td>
                  <td style={{ fontSize: '0.8rem' }}>
                    {fps.length === 0 ? '-' : fps.map(f => f.name + (f.version ? `@${f.version}` : '')).join(', ')}
                  </td>
                  <td style={{ fontSize: '0.75rem' }}>
                    <div>{formatBeijingTime(r.firstSeenAt)}</div>
                    <div style={{ color: 'var(--text-dim)' }}>→ {formatBeijingTime(r.lastSeenAt)}</div>
                  </td>
                  <td>
                    {r.disappearedAt
                      ? <span className="badge badge-low">消失</span>
                      : s
                        ? <span className="badge badge-info">服务</span>
                        : <span className="badge badge-low" style={{ opacity: 0.7 }}>活端点</span>}
                  </td>
                </tr>
                );
              });
            })()}
          </tbody>
        </table>
        ) : (
          <ByInstanceView rows={rows} expanded={expanded} setExpanded={setExpanded} showGone={filter.showGone} />
        )}
        {total === 0 && <p style={{ padding: '1rem', color: 'var(--text-dim)' }}>无匹配记录</p>}
        <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages}
          onPageChange={setPage} onPageSizeChange={s => { setPageSize(s); setPage(1); }} />
      </div>
    </div>
  );
}
