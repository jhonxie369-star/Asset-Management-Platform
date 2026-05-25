import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatBeijingDateTime, formatBeijingTime } from '../utils/time';

// entries 可能是 string[] (旧/手动) 或 AssetListEntry[] (cq 同步)。统一取 ip
type Entry = string | {
  ip: string;
  assetKind?: 'ip' | 'domain' | 'db_endpoint';
  address?: string;
  endpointPort?: number;
  endpointProtocol?: string;
  cloudProduct?: string;
  hostname?: string;
  instanceKey?: string;
  instanceRole?: string;
  instanceName?: string;
  cloud?: string;
  scope?: 'public' | 'private';
  source?: 'manual' | 'cloudquery';
};
const entryIp = (e: Entry): string => typeof e === 'string' ? e : e.ip;
const entryObj = (e: Entry): Exclude<Entry, string> => typeof e === 'string' ? { ip: e, source: 'manual' } : e;
const entryLine = (e: Entry): string => {
  if (typeof e === 'string') return e;
  const host = e.address || e.ip;
  if (e.endpointPort) return `${host}:${e.endpointPort}${e.endpointProtocol ? `:${e.endpointProtocol}` : ''}`;
  return host;
};

const CLOUD_BADGE: Record<string, string> = {
  alicloud: 'aliyun', aws: 'AWS', tencentcloud: '腾讯', huaweicloud: '华为',
};

const STRATEGY_LABELS: Record<string, string> = {
  'db-scan': '数据库扫描专用(实例内网可达优先,否则公网;LB 公网+内网)',
  'db-endpoints': '云数据库/RDS endpoint(域名+端口+协议,用于弱口令巡检)',
  'public': '全公网(所有实例+LB 公网 IP)',
  'private': '全内网(仅白名单内的实例+LB 内网 IP)',
};

export default function AssetLists() {
  const [lists, setLists] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', description: '', entriesText: '' });

  const [syncOpen, setSyncOpen] = useState(false);
  const [cqStatus, setCqStatus] = useState<{ configured: boolean; strategies: string[] } | null>(null);
  const [syncForm, setSyncForm] = useState({
    mode: 'single' as 'single' | 'batch',
    strategy: 'db-scan', name: '', description: '', replaceListId: '',
    batchStrategies: ['db-scan', 'db-endpoints', 'public', 'private'] as string[],
    batchPrefix: 'cloudquery-',
    autoSyncEnabled: false,
    autoSyncMode: 'interval' as 'interval' | 'daily',
    autoSyncInterval: 360,
    autoSyncCron: '03:00',
  });
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any | null>(null);
  const [batchResult, setBatchResult] = useState<any[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);

  const load = () => api.getAssetLists().then((r: any) => setLists(r.data || []));
  useEffect(() => { load(); }, []);

  const openSync = () => {
    setSyncOpen(true);
    setSyncResult(null);
    setBatchResult(null);
    setPreview(null);
    setSyncForm({
      mode: 'single',
      strategy: 'db-scan', name: '', description: '', replaceListId: '',
      batchStrategies: ['db-scan', 'db-endpoints', 'public', 'private'], batchPrefix: 'cloudquery-',
      autoSyncEnabled: false, autoSyncMode: 'interval', autoSyncInterval: 360, autoSyncCron: '03:00',
    });
    api.getCloudquerySourceStatus().then((r: any) => r.ok && setCqStatus(r.data));
  };

  const doPreview = async () => {
    setPreview(null);
    setPreviewing(true);
    const res: any = await api.previewCloudquery(syncForm.strategy);
    setPreviewing(false);
    if (!res.ok) { alert(res.error); return; }
    setPreview(res.data);
  };

  const buildAutoSync = () => syncForm.autoSyncEnabled ? {
    enabled: true,
    strategy: syncForm.strategy,
    ...(syncForm.autoSyncMode === 'daily'
      ? { cron: syncForm.autoSyncCron }
      : { intervalMinutes: syncForm.autoSyncInterval }),
  } : null;

  const doSync = async () => {
    if (!syncForm.replaceListId && !syncForm.name.trim()) { alert('请填写名称,或选择覆盖目标'); return; }
    setSyncing(true);
    const res: any = await api.syncCloudquery({
      strategy: syncForm.strategy,
      name: syncForm.name.trim(),
      description: syncForm.description.trim() || undefined,
      replaceListId: syncForm.replaceListId || undefined,
      autoSync: buildAutoSync() || undefined,
    });
    setSyncing(false);
    if (!res.ok) { alert(res.error || '同步失败'); return; }
    setSyncResult(res.data);
    load();
  };

  const doSyncBatch = async () => {
    if (syncForm.batchStrategies.length === 0) { alert('至少选一个策略'); return; }
    setSyncing(true);
    const res: any = await api.syncCloudqueryBatch({
      strategies: syncForm.batchStrategies,
      prefix: syncForm.batchPrefix,
      autoSync: buildAutoSync() || undefined,
    });
    setSyncing(false);
    if (!res.ok) { alert(res.error || '批量同步失败'); return; }
    setBatchResult(res.data);
    load();
  };

  const toggleBatchStrategy = (s: string) => {
    const set = new Set(syncForm.batchStrategies);
    if (set.has(s)) set.delete(s); else set.add(s);
    setSyncForm({ ...syncForm, batchStrategies: [...set] });
  };

  const toggleAutoSync = async (list: any) => {
    const current = list.autoSync;
    if (current?.enabled) {
      if (!confirm(`关闭 "${list.name}" 的自动同步？`)) return;
      const res: any = await api.updateAssetList(list.id, {
        entries: list.entries,
        autoSync: { ...current, enabled: false },
      });
      if (!res.ok) alert(res.error);
      load();
    } else {
      alert('请通过"从 CloudQuery 同步"弹窗设置自动刷新策略');
    }
  };

  const startCreate = () => { setEditing({ builtin: false, isNew: true }); setForm({ name: '', description: '', entriesText: '' }); };
  const startEdit = (list: any) => {
    setEditing(list);
    setForm({
      name: list.name,
      description: list.description || '',
      entriesText: (list.entries as Entry[]).map(entryLine).join('\n'),
    });
  };

  const save = async () => {
    if (!form.name.trim()) { alert('请填写名称'); return; }
    const payload = { name: form.name, description: form.description, entriesText: form.entriesText };
    if (editing?.isNew) {
      const res: any = await api.createAssetList(payload);
      if (!res.ok) { alert(res.error); return; }
    } else {
      const res: any = await api.updateAssetList(editing.id, payload);
      if (!res.ok) { alert(res.error); return; }
    }
    setEditing(null);
    load();
  };

  const del = async (id: string) => {
    if (!confirm('确认删除？')) return;
    const res: any = await api.deleteAssetList(id);
    if (!res.ok) alert(res.error);
    load();
  };

  const downloadAssetList = async (list: any, format: 'csv' | 'json') => {
    const res = await fetch(api.exportAssetListUrl(list.id, format), { credentials: 'include' });
    if (!res.ok) { alert('导出失败'); return; }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const filename = match ? decodeURIComponent(match[1]) : `${list.name}.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const previewCount = form.entriesText ? (() => {
    const set = new Set<string>();
    for (const line of form.entriesText.split(/[\s,;\n]+/)) {
      const s = line.trim();
      if (!s) continue;
      const cidr = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
      if (cidr) {
        const prefix = parseInt(cidr[2]);
        if (prefix >= 8 && prefix <= 32) {
          const c = 2 ** (32 - prefix);
          if (c <= 65536) { set.add(`CIDR:${s}:${c}`); continue; }
        }
      }
      set.add(s);
    }
    return set.size;
  })() : 0;

  return (
    <div>
      <h2 style={{ marginBottom: '1rem' }}>资产列表管理</h2>

      {editing ? (
        <div className="card">
          <h3>{editing.isNew ? '新建资产列表' : `编辑 ${editing.name}`}</h3>
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <input placeholder="名称，例如 public-web" style={{ flex: 1 }}
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-row">
            <input placeholder="说明" style={{ flex: 1 }}
              value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
              资产条目（IP / 域名 / 云数据库 endpoint:port:protocol / CIDR / IP 范围，换行或逗号分隔，约 {previewCount} 条）
            </div>
            <textarea
              value={form.entriesText}
              onChange={e => setForm({ ...form, entriesText: e.target.value })}
              style={{ width: '100%', minHeight: '300px', fontFamily: 'monospace', fontSize: '0.85rem',
                padding: '0.5rem', background: 'var(--bg)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: '4px' }}
              placeholder={`192.0.2.10\n192.0.2.11\n198.51.100.0/24\n203.0.113.10-203.0.113.20\nexample.com\ndb.example.invalid:3306:mysql\nredis.example.invalid:6379:redis`}
            />
          </div>
          {!editing.isNew && editing.entries && editing.entries.some((e: any) => typeof e === 'object' && e.instanceKey) && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
                按机器分组(只读,基于同步时的快照)
              </div>
              <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '4px' }}>
                <table style={{ margin: 0 }}>
                  <thead><tr><th>机器</th><th>云</th><th>公网 IP</th><th>内网 IP</th></tr></thead>
                  <tbody>
                    {(() => {
                      // 聚合:按 instanceKey 分组
                      const groups = new Map<string, { cloud?: string; role?: string; name?: string; pub: string[]; priv: string[] }>();
                      const manual: string[] = [];
                      for (const e of (editing.entries as Entry[])) {
                        const o = entryObj(e);
                        if (!o.instanceKey) { manual.push(o.ip); continue; }
                        let g = groups.get(o.instanceKey);
                        if (!g) { g = { cloud: o.cloud, role: o.instanceRole, name: o.instanceName, pub: [], priv: [] }; groups.set(o.instanceKey, g); }
                        if (o.scope === 'public') g.pub.push(o.ip); else if (o.scope === 'private') g.priv.push(o.ip);
                        else (o.ip.startsWith('10.') || o.ip.startsWith('192.168.') || o.ip.startsWith('172.') ? g.priv : g.pub).push(o.ip);
                      }
                      const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
                      return (
                        <>
                          {rows.map(([key, g]) => {
                            const shortId = key.split(':').slice(-1)[0]?.slice(0, 16);
                            return (
                              <tr key={key}>
                                <td style={{ fontSize: '0.75rem', fontFamily: 'monospace' }} title={key}>
                                  {g.role && <span style={{ color: 'var(--text-dim)' }}>{g.role}·</span>}{shortId}
                                  {g.name && <div style={{ color: 'var(--text-dim)' }}>{g.name}</div>}
                                </td>
                                <td style={{ fontSize: '0.7rem' }}>
                                  {g.cloud && <span style={{
                                    padding: '0 0.3rem', background: 'rgba(79,195,247,0.15)', color: 'var(--accent)', borderRadius: '3px',
                                  }}>{CLOUD_BADGE[g.cloud] || g.cloud}</span>}
                                </td>
                                <td style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{g.pub.join(', ') || '-'}</td>
                                <td style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{g.priv.join(', ') || '-'}</td>
                              </tr>
                            );
                          })}
                          {manual.length > 0 && (
                            <tr><td colSpan={4} style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                              未关联机器的 IP: {manual.slice(0, 10).join(', ')}{manual.length > 10 ? ` +${manual.length - 10}` : ''}
                            </td></tr>
                          )}
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <button className="btn btn-primary" onClick={save}>保存</button>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      ) : syncOpen ? (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>☁ 从 CloudQuery 同步</h3>
            <button className="btn" onClick={() => setSyncOpen(false)}>关闭</button>
          </div>
          {cqStatus && !cqStatus.configured && (
            <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              ⚠ CloudQuery PG 未配置,请在 .env 设置 <code>CLOUDQUERY_PG_URL</code> 或拆字段,然后重启服务。
            </p>
          )}

          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <button className={`btn ${syncForm.mode === 'single' ? 'btn-primary' : ''}`}
              onClick={() => { setSyncForm({ ...syncForm, mode: 'single' }); setBatchResult(null); setSyncResult(null); }}>
              单策略(自定义名称)
            </button>
            <button className={`btn ${syncForm.mode === 'batch' ? 'btn-primary' : ''}`}
              onClick={() => { setSyncForm({ ...syncForm, mode: 'batch' }); setBatchResult(null); setSyncResult(null); }}>
              批量(一次生成多张)
            </button>
          </div>

          {syncForm.mode === 'single' ? (
            <>
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>策略</div>
                {(cqStatus?.strategies || ['db-scan', 'db-endpoints', 'public', 'private']).map(s => (
                  <label key={s} style={{ display: 'block', marginBottom: '0.3rem', cursor: 'pointer' }}>
                    <input type="radio" name="strategy" checked={syncForm.strategy === s}
                      onChange={() => { setSyncForm({ ...syncForm, strategy: s }); setPreview(null); }} />
                    {' '}<b>{s}</b> <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>— {STRATEGY_LABELS[s] || s}</span>
                  </label>
                ))}
              </div>
              <div className="form-row" style={{ marginTop: '0.5rem' }}>
                <button className="btn" onClick={doPreview} disabled={previewing || !cqStatus?.configured}>
                  {previewing ? '预览中...' : '🔍 预览统计(不落库)'}
                </button>
              </div>
              {preview && (
                <div className="module-cfg" style={{ marginTop: '0.5rem' }}>
                  <div><b>唯一资产: {preview.breakdown.uniqueIps}</b>(原始 {preview.breakdown.total} 条,去重后)</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                    按 cloud: {Object.entries(preview.breakdown.byCloud).map(([k, v]) => `${k}=${v}`).join(' · ')}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    按 source: {Object.entries(preview.breakdown.bySource).map(([k, v]) => `${k}=${v}`).join(' · ')}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    按 scope: {Object.entries(preview.breakdown.byScope).map(([k, v]) => `${k}=${v}`).join(' · ')}
                  </div>
                  {preview.warnings?.length > 0 && (
                    <div style={{ color: 'var(--warning)', fontSize: '0.8rem', marginTop: '0.3rem' }}>
                      警告: {preview.warnings.join('; ')}
                    </div>
                  )}
                </div>
              )}

              <hr style={{ borderColor: 'var(--border)', margin: '1rem 0' }} />
              <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>保存为资产列表</div>
              <div className="form-row">
                <select value={syncForm.replaceListId}
                  onChange={e => setSyncForm({ ...syncForm, replaceListId: e.target.value })}
                  style={{ flex: 1 }}>
                  <option value="">新建(在下方填名称)</option>
                  {lists.map(l => <option key={l.id} value={l.id}>覆盖: {l.name} ({l.entries?.length || 0})</option>)}
                </select>
              </div>
              {!syncForm.replaceListId && (
                <>
                  <div className="form-row">
                    <input placeholder="新列表名称,例如 synced-db-scan" style={{ flex: 1 }}
                      value={syncForm.name} onChange={e => setSyncForm({ ...syncForm, name: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <input placeholder="说明(可选)" style={{ flex: 1 }}
                      value={syncForm.description} onChange={e => setSyncForm({ ...syncForm, description: e.target.value })} />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
                  选要生成的策略(勾几个就建几张 list)
                </div>
                {(cqStatus?.strategies || ['db-scan', 'db-endpoints', 'public', 'private']).map(s => (
                  <label key={s} style={{ display: 'block', marginBottom: '0.3rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={syncForm.batchStrategies.includes(s)}
                      onChange={() => toggleBatchStrategy(s)} />
                    {' '}<b>{s}</b> <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>— {STRATEGY_LABELS[s] || s}</span>
                  </label>
                ))}
              </div>
              <div className="form-row" style={{ marginTop: '0.5rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.2rem' }}>
                    名字前缀(自动拼接策略名,如 {syncForm.batchPrefix}db-scan)
                  </div>
                  <input placeholder="cloudquery-" style={{ width: '100%' }}
                    value={syncForm.batchPrefix}
                    onChange={e => setSyncForm({ ...syncForm, batchPrefix: e.target.value })} />
                </div>
              </div>
            </>
          )}

          <div className="module-cfg" style={{ marginTop: '0.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', marginBottom: '0.4rem' }}>
              <input type="checkbox" checked={syncForm.autoSyncEnabled}
                onChange={e => setSyncForm({ ...syncForm, autoSyncEnabled: e.target.checked })} />
              <b>⏰ 定时自动刷新</b>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                {syncForm.mode === 'batch' ? '批量模式下多张 list 会自动错峰(各偏移 1 分钟)' : '失败保留旧数据'}
              </span>
            </label>
            {syncForm.autoSyncEnabled && (
              <div className="form-row" style={{ marginTop: '0.3rem' }}>
                <select value={syncForm.autoSyncMode}
                  onChange={e => setSyncForm({ ...syncForm, autoSyncMode: e.target.value as any })}
                  style={{ width: '120px' }}>
                  <option value="interval">每 N 分钟</option>
                  <option value="daily">每日定时</option>
                </select>
                {syncForm.autoSyncMode === 'interval' ? (
                  <>
                    <input type="number" min={5} style={{ width: '100px' }}
                      value={syncForm.autoSyncInterval}
                      onChange={e => setSyncForm({ ...syncForm, autoSyncInterval: +e.target.value })} />
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>分钟(建议≥60)</span>
                  </>
                ) : (
                  <input type="time" style={{ width: '120px' }}
                    value={syncForm.autoSyncCron}
                    onChange={e => setSyncForm({ ...syncForm, autoSyncCron: e.target.value })} />
                )}
              </div>
            )}
          </div>

          <div className="form-row" style={{ marginTop: '0.5rem' }}>
            {syncForm.mode === 'single' ? (
              <button className="btn btn-primary" onClick={doSync} disabled={syncing || !cqStatus?.configured}>
                {syncing ? '同步中...' : syncForm.replaceListId ? '⚠ 覆盖并保存' : '+ 同步并创建'}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={doSyncBatch}
                disabled={syncing || !cqStatus?.configured || syncForm.batchStrategies.length === 0}>
                {syncing ? '批量同步中...' : `+ 一次生成 ${syncForm.batchStrategies.length} 张`}
              </button>
            )}
          </div>

          {syncResult && (
            <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(46,204,113,0.1)',
              borderRadius: '4px', color: 'var(--success)', fontSize: '0.85rem' }}>
              ✓ 已保存为 <b>{syncResult.list.name}</b>({syncResult.list.entries.length} 条 IP)
            </div>
          )}
          {batchResult && (
            <div style={{ marginTop: '0.5rem' }}>
              {batchResult.map((r, i) => (
                <div key={i} style={{
                  padding: '0.4rem 0.6rem', marginBottom: '0.3rem', borderRadius: '4px',
                  background: r.ok ? 'rgba(46,204,113,0.1)' : 'rgba(231,76,60,0.1)',
                  color: r.ok ? 'var(--success)' : 'var(--danger)', fontSize: '0.85rem',
                }}>
                  {r.ok ? '✓' : '✗'} <b>{r.strategy}</b> {r.ok
                    ? `→ ${r.list.name} (${r.list.entries.length} IP)`
                    : `失败: ${r.error}`}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>共 {lists.length} 个列表</span>
            <div>
              <button className="btn" onClick={openSync} style={{ marginRight: '0.3rem' }}>☁ 从 CloudQuery 同步</button>
              <button className="btn btn-primary" onClick={startCreate}>+ 新建列表</button>
            </div>
          </div>
          <table style={{ marginTop: '0.75rem' }}>
            <thead><tr><th>名称</th><th>说明</th><th>IP / 机器</th><th>构成</th><th>自动同步</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {lists.map(l => {
                const a = l.autoSync;
                const syncInfo = a?.enabled
                  ? (a.cron ? `每日 ${a.cron}` : `每 ${a.intervalMinutes} 分钟`)
                  : null;
                const entries: Entry[] = l.entries || [];
                // 统计机器数(按 instanceKey 去重)、scope 分布、cloud 分布
                const instKeys = new Set<string>();
                const byScope: Record<string, number> = {};
                const byCloud: Record<string, number> = {};
                let manualCount = 0;
                for (const e of entries) {
                  const o = entryObj(e);
                  if (o.instanceKey) instKeys.add(o.instanceKey);
                  else manualCount++;
                  if (o.scope) byScope[o.scope] = (byScope[o.scope] || 0) + 1;
                  if (o.cloud) byCloud[o.cloud] = (byCloud[o.cloud] || 0) + 1;
                }
                return (
                  <tr key={l.id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                      {l.name} {a?.enabled && <span title={`${a.strategy} · ${syncInfo}`}>⏰</span>}
                    </td>
                    <td style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>{l.description || '-'}</td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {(() => {
                        const endpointCount = entries.filter(e => entryObj(e).assetKind === 'db_endpoint' || !!entryObj(e).endpointPort).length;
                        const domainCount = entries.filter(e => entryObj(e).assetKind === 'domain' && !entryObj(e).endpointPort).length;
                        return (
                          <>
                            <div><b>{entries.length}</b> 条资产</div>
                            {(endpointCount > 0 || domainCount > 0) && (
                              <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                                {endpointCount > 0 ? `${endpointCount} endpoint` : ''}
                                {endpointCount > 0 && domainCount > 0 ? ' · ' : ''}
                                {domainCount > 0 ? `${domainCount} 域名` : ''}
                              </div>
                            )}
                          </>
                        );
                      })()}
                      {instKeys.size > 0 && (
                        <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                          {instKeys.size} 台机器{manualCount > 0 ? ` + ${manualCount} 裸 IP` : ''}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {Object.keys(byCloud).length > 0 && (
                        <div>{Object.entries(byCloud).map(([k, v]) => (
                          <span key={k} style={{
                            display: 'inline-block', marginRight: '0.3rem', padding: '0 0.3rem',
                            background: 'rgba(79,195,247,0.15)', color: 'var(--accent)', borderRadius: '3px', fontSize: '0.7rem',
                          }}>{CLOUD_BADGE[k] || k} {v}</span>
                        ))}</div>
                      )}
                      {Object.keys(byScope).length > 0 && (
                        <div style={{ color: 'var(--text-dim)' }}>
                          {byScope.public ? `公网 ${byScope.public}` : ''}
                          {byScope.public && byScope.private ? ' · ' : ''}
                          {byScope.private ? `内网 ${byScope.private}` : ''}
                        </div>
                      )}
                      {Object.keys(byCloud).length === 0 && Object.keys(byScope).length === 0 && '-'}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {a?.enabled ? (
                        <>
                          <div><span style={{ color: 'var(--accent)' }}>{a.strategy}</span> · {syncInfo}</div>
                          <div style={{ color: a.lastStatus === 'failed' ? 'var(--danger)' : 'var(--text-dim)' }}>
                            {a.lastSyncedAt
                              ? `${a.lastStatus === 'ok' ? '✓' : '✗'} ${formatBeijingTime(a.lastSyncedAt)}${a.lastEntriesCount ? ` (${a.lastEntriesCount})` : ''}`
                              : '未执行'}
                          </div>
                          {a.lastError && <div style={{ color: 'var(--danger)', fontSize: '0.7rem' }}>{a.lastError}</div>}
                        </>
                      ) : '-'}
                    </td>
                    <td>{formatBeijingDateTime(l.updatedAt)}</td>
                    <td>
                      <button className="btn" onClick={() => startEdit(l)}>编辑</button>
                      <button className="btn" style={{ marginLeft: '0.3rem' }} onClick={() => downloadAssetList(l, 'csv')}>
                        导出CSV
                      </button>
                      {a?.enabled && (
                        <button className="btn" style={{ marginLeft: '0.3rem' }} onClick={() => toggleAutoSync(l)}>
                          关闭自动
                        </button>
                      )}
                      <button className="btn btn-danger" style={{ marginLeft: '0.3rem' }} onClick={() => del(l.id)}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lists.length === 0 && <p style={{ padding: '1rem', color: 'var(--text-dim)' }}>暂无资产列表，点击"新建列表"或"从 CloudQuery 同步"开始</p>}
        </div>
      )}
    </div>
  );
}
