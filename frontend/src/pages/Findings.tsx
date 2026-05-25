import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Pagination } from '../components/Pagination';
import { beijingFileTimestamp, formatBeijingDateTime, formatBeijingTime } from '../utils/time';

function csvEscape(v: any): string {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function credentialText(f: any): string {
  const c = f?.credentials || {};
  if (!c || Object.keys(c).length === 0) return '-';
  if (f?.type === 'unauth' || (c.passwordEmpty && !c.username)) return '未授权/空密码';

  const parts: string[] = [];
  if (c.username !== undefined) parts.push(`账号: ${c.username || '(empty)'}`);
  if (c.password !== undefined) parts.push(`密码: ${c.password || '(empty)'}`);
  else if (c.passwordMasked !== undefined) parts.push(`密码: ${c.passwordMasked || '(empty)'}`);
  if (c.passwordEmpty) parts.push('空密码');
  return parts.length ? parts.join('\n') : '-';
}

function credentialCsv(f: any): string {
  return credentialText(f).replace(/\r?\n/g, ' ');
}

function CredentialCell({ finding }: { finding: any }) {
  const text = credentialText(finding);
  return (
    <td style={{ fontSize: '0.75rem', whiteSpace: 'pre-line', fontFamily: text === '-' ? undefined : 'monospace' }}>
      {text}
    </td>
  );
}

const DATA_CATEGORY_LABELS: Record<string, string> = {
  database: '数据库/数据服务',
  nonDatabase: '非数据服务',
};

/** 简易 sparkline:把若干 RiskSnapshot.score 画成折线 */
function RiskTrend({ points }: { points?: any[] }) {
  if (!points) return <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>加载趋势中…</div>;
  if (points.length === 0) {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>无历史快照(scheduler 每日 00:05 自动抓,或点上方"立即抓快照")</div>;
  }
  const W = 320, H = 50, pad = 4;
  const scores = points.map(p => p.score);
  const max = Math.max(...scores, 1);
  const stepX = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
  const path = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = H - pad - ((p.score / max) * (H - pad * 2));
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const delta = last.score - first.score;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '0.75rem' }}>
      <svg width={W} height={H} style={{ background: 'rgba(79,195,247,0.05)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        <path d={path} stroke="var(--accent)" strokeWidth="1.5" fill="none" />
        {points.map((p, i) => (
          <circle key={i} cx={pad + i * stepX} cy={H - pad - ((p.score / max) * (H - pad * 2))} r="2" fill="var(--accent)">
            <title>{`${p.date} score=${p.score}`}</title>
          </circle>
        ))}
      </svg>
      <div>
        <div>近 {points.length} 天 · 当前 <b>{last.score}</b> · 起点 {first.score}</div>
        <div style={{ color: delta > 0 ? 'var(--danger)' : delta < 0 ? 'var(--success)' : 'var(--text-dim)' }}>
          {delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : '— 持平'}
        </div>
      </div>
    </div>
  );
}

export default function Findings() {
  const [tab, setTab] = useState<'findings' | 'instances' | 'reports'>('findings');
  const [findings, setFindings] = useState<any[]>([]);
  const [fTotal, setFTotal] = useState(0);
  const [fTotalPages, setFTotalPages] = useState(1);
  const [fPage, setFPage] = useState(1);
  const [fPageSize, setFPageSize] = useState(50);
  const [fFilter, setFFilter] = useState({
    status: '',
    severity: '',
    q: '',
    scope: '',
    dataCategory: '',
    lifecycle: 'current' as 'current' | 'historical' | 'all',
  });
  const [stats, setStats] = useState<{ total: number; bySeverity: Record<string, number>; byStatus: Record<string, number> }>({
    total: 0, bySeverity: {}, byStatus: {},
  });

  const [instances, setInstances] = useState<any[]>([]);
  const [iTotal, setITotal] = useState(0);
  const [iTotalPages, setITotalPages] = useState(1);
  const [iPage, setIPage] = useState(1);
  const [iPageSize, setIPageSize] = useState(20);
  const [iExpanded, setIExpanded] = useState<string | null>(null);
  const [trends, setTrends] = useState<Record<string, any[]>>({});
  const loadTrend = async (key: string) => {
    if (trends[key] !== undefined) return;
    const res: any = await api.getInstanceTrend(key, 30);
    if (res.ok) setTrends(prev => ({ ...prev, [key]: res.data || [] }));
  };
  const onToggleExp = (key: string) => {
    if (iExpanded === key) {
      setIExpanded(null);
    } else {
      setIExpanded(key);
      loadTrend(key);
    }
  };

  const [runs, setRuns] = useState<any[]>([]);
  const [rTotal, setRTotal] = useState(0);
  const [rTotalPages, setRTotalPages] = useState(1);
  const [rPage, setRPage] = useState(1);
  const [rPageSize, setRPageSize] = useState(50);

  const [selectedReport, setSelectedReport] = useState<any | null>(null);

  const buildFindingParams = (extra: Record<string, string | number> = {}) => {
    const p: Record<string, string | number> = { page: fPage, pageSize: fPageSize };
    if (fFilter.status) p.status = fFilter.status;
    if (fFilter.severity) p.severity = fFilter.severity;
    if (fFilter.q) p.q = fFilter.q;
    if (fFilter.scope) p.scope = fFilter.scope;
    if (fFilter.dataCategory) p.dataCategory = fFilter.dataCategory;
    if (fFilter.lifecycle && fFilter.lifecycle !== 'all') p.lifecycle = fFilter.lifecycle;
    return { ...p, ...extra };
  };

  const findingExportRow = (f: any) => ({
    lifecycle: f.lifecycle || '',
    scope: f.scope === 'public' ? '公网' : f.scope === 'private' ? '私网' : '',
    dataCategory: DATA_CATEGORY_LABELS[f.dataCategory] || '',
    severity: f.severity || '',
    type: f.type || '',
    title: f.title || '',
    credential: credentialCsv(f),
    username: f.credentials?.username || '',
    password: f.credentials?.password ?? '',
    passwordMasked: f.credentials?.passwordMasked || '',
    passwordEmpty: f.credentials?.passwordEmpty ? 'yes' : '',
    status: f.status || '',
    ip: f.endpoint?.host || f.endpoint?.ip || '',
    port: f.endpoint?.port || '',
    protocol: f.service?.protocol || '',
    product: f.service?.product || '',
    instance: [f.instance?.cloud, f.instance?.role, f.instance?.name, f.instance?.key].filter(Boolean).join(' '),
    firstSeenAt: f.firstSeenAt || '',
    lastSeenAt: f.lastSeenAt || '',
    assetId: f.assetId || '',
    endpointId: f.endpointId || '',
    description: (f.description || '').replace(/\r?\n/g, ' '),
  });

  const loadFindings = () => {
    const p = buildFindingParams();
    api.getSecurityFindings(p).then((r: any) => {
      setFindings(r.data || []);
      setFTotal(r.total || 0);
      setFTotalPages(r.totalPages || 1);
    });
  };
  const loadStats = () => {
    const p = buildFindingParams({ page: 1, pageSize: 1 });
    delete (p as any).page;
    delete (p as any).pageSize;
    const qs = new URLSearchParams({ ...(p as any), kind: 'security' }).toString();
    fetch(`/api/findings/stats?${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then((r: any) => r.ok && setStats(r.data));
  };

  const loadInstances = () => {
    api.getFindingsByInstance({ page: iPage, pageSize: iPageSize }).then((r: any) => {
      setInstances(r.data || []);
      setITotal(r.total || 0);
      setITotalPages(r.totalPages || 1);
    });
  };

  const loadRuns = () => {
    api.getTaskRuns({ page: rPage, pageSize: rPageSize }).then((r: any) => {
      setRuns(r.data || []);
      setRTotal(r.total || 0);
      setRTotalPages(r.totalPages || 1);
    });
  };

  useEffect(() => { loadFindings(); }, [fPage, fPageSize, fFilter]);
  useEffect(() => { loadStats(); }, [fFilter]);
  useEffect(() => { if (tab === 'instances') loadInstances(); }, [tab, iPage, iPageSize]);
  useEffect(() => { if (tab === 'reports') loadRuns(); }, [tab, rPage, rPageSize]);

  const openReport = async (runId: string) => {
    const res: any = await api.getTaskRunReport(runId);
    if (res.ok) setSelectedReport(res.data);
  };

  const downloadReportExport = async (type: string, format: 'csv' | 'json' = 'csv') => {
    if (!selectedReport?.taskRun?.id) return;
    const res = await fetch(`/api/runs/task-runs/${encodeURIComponent(selectedReport.taskRun.id)}/export?type=${encodeURIComponent(type)}&format=${format}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      alert('导出失败');
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const fallback = `${selectedReport.taskRun.taskName || 'report'}-${type}.${format}`;
    const filename = match ? decodeURIComponent(match[1]) : fallback;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const updateStatus = async (id: string, status: string) => {
    await api.updateFindingStatus(id, status);
    loadFindings();
    loadStats();
    if (tab === 'instances') loadInstances();
  };

  const onFFilter = (patch: Partial<typeof fFilter>) => { setFFilter({ ...fFilter, ...patch }); setFPage(1); };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>问题发现</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        当前纳入弱口令、未授权/匿名登录和敏感路径等确认命中的安全问题；弱口令会直接展示命中的账号和密码。
      </p>

      <div className="stats-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card"><div className="value" style={{ color: 'var(--danger)' }}>{stats.bySeverity.critical || 0}</div><div className="label">critical</div></div>
        <div className="stat-card"><div className="value" style={{ color: '#e65100' }}>{stats.bySeverity.high || 0}</div><div className="label">high</div></div>
        <div className="stat-card"><div className="value" style={{ color: 'var(--warning)' }}>{stats.bySeverity.medium || 0}</div><div className="label">medium</div></div>
        <div className="stat-card"><div className="value" style={{ color: '#29b6f6' }}>{stats.bySeverity.low || 0}</div><div className="label">low</div></div>
      </div>

      <div className="form-row" style={{ marginBottom: '1rem' }}>
        <button className={`btn ${tab === 'findings' ? 'btn-primary' : ''}`} onClick={() => { setTab('findings'); setSelectedReport(null); }}>
          🔍 按问题(当前态)
        </button>
        <button className={`btn ${tab === 'instances' ? 'btn-primary' : ''}`} onClick={() => { setTab('instances'); setSelectedReport(null); }}>
          🖥 按机器(高危榜)
        </button>
        <button className={`btn ${tab === 'reports' ? 'btn-primary' : ''}`} onClick={() => setTab('reports')}>
          📋 按扫描报告(历史)
        </button>
      </div>

      {tab === 'findings' && (
        <div className="card">
          <div className="form-row" style={{ marginBottom: '0.5rem' }}>
            <input placeholder="搜索标题/类型" style={{ flex: 1 }}
              value={fFilter.q} onChange={e => onFFilter({ q: e.target.value })} />
            <select value={fFilter.lifecycle} onChange={e => onFFilter({ lifecycle: e.target.value as any })}>
              <option value="current">现存(默认)</option>
              <option value="historical">历史(资产已消失/已处理)</option>
              <option value="all">全部</option>
            </select>
            <select value={fFilter.scope} onChange={e => onFFilter({ scope: e.target.value })}>
              <option value="">全部网络</option>
              <option value="public">公网</option>
              <option value="private">私网</option>
            </select>
            <select value={fFilter.dataCategory} onChange={e => onFFilter({ dataCategory: e.target.value })}>
              <option value="">全部类型</option>
              <option value="database">数据库/数据服务</option>
              <option value="nonDatabase">非数据服务</option>
            </select>
            <select value={fFilter.severity} onChange={e => onFFilter({ severity: e.target.value })}>
              <option value="">全部严重度</option>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="info">info</option>
            </select>
            <select value={fFilter.status} onChange={e => onFFilter({ status: e.target.value })}>
              <option value="">全部状态</option>
              <option value="open">open</option>
              <option value="confirmed">confirmed</option>
              <option value="ignored">ignored</option>
              <option value="resolved">resolved</option>
            </select>
            <button className="btn" disabled={fTotal === 0}
              onClick={async () => {
                const p = buildFindingParams({ page: 1, pageSize: 10000 });
                const res: any = await api.getSecurityFindings(p);
                if (!res.ok) { alert(res.error || '导出失败'); return; }
                const cols = ['lifecycle', 'scope', 'dataCategory', 'severity', 'type', 'title', 'credential', 'username', 'password', 'passwordMasked', 'passwordEmpty', 'status', 'ip', 'port', 'protocol', 'product', 'instance', 'firstSeenAt', 'lastSeenAt', 'assetId', 'endpointId', 'description'];
                const rows = (res.data || []).map(findingExportRow);
                const csv = [cols.map(csvEscape).join(','), ...rows.map((r: any) => cols.map(c => csvEscape(r[c])).join(','))].join('\n');
                const ts = beijingFileTimestamp();
                downloadFile(`findings-${fFilter.lifecycle}-${ts}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
              }}>⬇ CSV</button>
            <button className="btn" disabled={fTotal === 0}
              onClick={async () => {
                const p = buildFindingParams({ page: 1, pageSize: 10000 });
                const res: any = await api.getSecurityFindings(p);
                if (!res.ok) { alert(res.error || '导出失败'); return; }
                const data = (res.data || []).map(findingExportRow);
                const ts = beijingFileTimestamp();
                downloadFile(`findings-${fFilter.lifecycle}-${ts}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
              }}>⬇ JSON</button>
          </div>
          <table>
            <thead><tr><th>状态</th><th>网络</th><th>分类</th><th>严重度</th><th>类型</th><th>标题</th><th>凭据/证据</th><th>工单状态</th><th>首次</th><th>最近</th><th>操作</th></tr></thead>
            <tbody>
              {findings.map((f: any) => (
                <tr key={f.id} style={f.status === 'resolved' || f.status === 'ignored' ? { opacity: 0.5 } : {}}>
                  <td>
                    {f.lifecycle === 'historical'
                      ? <span className="badge badge-low" style={{ opacity: 0.7 }} title="资产已消失或问题已处理">历史</span>
                      : <span className="badge badge-info">现存</span>}
                  </td>
                  <td>{f.scope === 'public' ? <span className="badge badge-high">公网</span> : f.scope === 'private' ? <span className="badge badge-info">私网</span> : '-'}</td>
                  <td style={{ fontSize: '0.75rem' }}>{DATA_CATEGORY_LABELS[f.dataCategory] || '-'}</td>
                  <td><span className={`badge badge-${f.severity}`}>{f.severity}</span></td>
                  <td>{f.type}</td>
                  <td>{f.title}</td>
                  <CredentialCell finding={f} />
                  <td>{f.status}</td>
                  <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(f.firstSeenAt)}</td>
                  <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(f.lastSeenAt)}</td>
                  <td>
                    {f.status === 'open' && (
                      <>
                        <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => updateStatus(f.id, 'confirmed')}>确认</button>
                        <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => updateStatus(f.id, 'ignored')}>忽略</button>
                      </>
                    )}
                    {(f.status === 'open' || f.status === 'confirmed') && (
                      <button className="btn btn-primary" onClick={() => updateStatus(f.id, 'resolved')}>已处理</button>
                    )}
                    {(f.status === 'ignored' || f.status === 'resolved') && (
                      <button className="btn" onClick={() => updateStatus(f.id, 'open')}>重新打开</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fTotal === 0 && (
            <p style={{ padding: '1rem', color: 'var(--text-dim)', textAlign: 'center' }}>
              没有当前筛选条件下的安全问题。
            </p>
          )}
          <Pagination page={fPage} pageSize={fPageSize} total={fTotal} totalPages={fTotalPages}
            onPageChange={setFPage} onPageSizeChange={s => { setFPageSize(s); setFPage(1); }} />
        </div>
      )}

      {tab === 'instances' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
              只显示当前有 <b>open/confirmed</b> 安全问题的机器,按风险分排序(critical=10 / high=5 / medium=2 / low=1)
            </div>
            <button className="btn" disabled={iTotal === 0}
              onClick={async () => {
                // 拉全量(忽略分页)
                const res: any = await api.getFindingsByInstance({ pageSize: 10000 });
                if (!res.ok) { alert(res.error || '导出失败'); return; }
                const cols = ['风险分', '机器key', '云', 'role', '机器名', 'IP列表', 'critical', 'high', 'medium', 'low', '问题数', '问题列表'];
                const rows = (res.data || []).map((b: any) => [
                  b.score, b.instanceKey, b.cloud || '', b.role || '', b.name || '',
                  (b.ips || []).join('; '),
                  b.bySeverity.critical || 0, b.bySeverity.high || 0,
                  b.bySeverity.medium || 0, b.bySeverity.low || 0,
                  b.findings.length,
                  (b.findings || []).map((f: any) => `[${f.severity}] ${f.type}: ${f.title} (${credentialCsv(f)})`).join(' | '),
                ]);
                const csv = [cols.map(csvEscape).join(','), ...rows.map((r: any[]) => r.map(csvEscape).join(','))].join('\n');
                const ts = beijingFileTimestamp();
                downloadFile(`findings-by-instance-${ts}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
              }}>
              ⬇ 导出 CSV
            </button>
            <button className="btn" style={{ marginLeft: '0.3rem' }}
              onClick={async () => {
                const res: any = await api.takeRiskSnapshot();
                if (res.ok) {
                  alert(`✓ 已抓快照: ${res.data.taken} 台机器 (${res.data.date})`);
                  setTrends({});  // 清缓存,展开时重新拉
                } else alert(res.error || '失败');
              }}>📸 立即抓快照</button>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: '60px' }}>风险分</th>
                <th>机器</th>
                <th>IP</th>
                <th>严重度分布</th>
                <th>问题数</th>
                <th style={{ width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((b: any) => {
                const key = b.instanceKey;
                const isExp = iExpanded === key;
                const isUnknown = String(key).startsWith('unknown:');
                const shortId = isUnknown ? '-' : String(key).split(':').slice(-1)[0]?.slice(0, 16);
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td style={{ fontWeight: 700, color: b.score >= 10 ? 'var(--danger)' : b.score >= 5 ? '#e65100' : 'var(--warning)' }}>
                        {b.score}
                      </td>
                      <td style={{ fontSize: '0.8rem', fontFamily: 'monospace' }} title={key}>
                        {b.cloud && <span style={{
                          display: 'inline-block', marginRight: '0.3rem', padding: '0 0.3rem',
                          background: 'rgba(79,195,247,0.15)', color: 'var(--accent)', borderRadius: '3px',
                          fontSize: '0.65rem',
                        }}>{b.cloud}</span>}
                        {b.role && <span style={{ color: 'var(--text-dim)' }}>{b.role}·</span>}
                        {shortId}
                        {b.name && <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{b.name}</div>}
                      </td>
                      <td style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                        {b.ips.slice(0, 3).join(', ')}{b.ips.length > 3 ? ` +${b.ips.length - 3}` : ''}
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>
                        {['critical', 'high', 'medium', 'low'].map(s => b.bySeverity[s] > 0 && (
                          <span key={s} className={`badge badge-${s}`} style={{ marginRight: '0.3rem' }}>
                            {s} {b.bySeverity[s]}
                          </span>
                        ))}
                      </td>
                      <td>
                        {b.findings.length}
                        {b.historicalCount > 0 && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                            ({b.historicalCount} 历史)
                          </div>
                        )}
                      </td>
                      <td>
                        <button className="btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem' }}
                          onClick={() => onToggleExp(key)}>
                          {isExp ? '▴' : '▾'}
                        </button>
                      </td>
                    </tr>
                    {isExp && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--bg)', padding: '0.5rem' }}>
                          <RiskTrend points={trends[key]} />
                          <table style={{ margin: 0 }}>
                            <thead><tr><th>状态</th><th>严重度</th><th>类型</th><th>标题</th><th>凭据/证据</th><th>工单状态</th><th>最近</th><th>操作</th></tr></thead>
                            <tbody>
                              {b.findings.map((f: any) => (
                                <tr key={f.id} style={f.status === 'resolved' || f.status === 'ignored' ? { opacity: 0.5 } : {}}>
                                  <td>
                                    {f.lifecycle === 'historical'
                                      ? <span className="badge badge-low" style={{ opacity: 0.7 }}>历史</span>
                                      : <span className="badge badge-info">现存</span>}
                                  </td>
                                  <td><span className={`badge badge-${f.severity}`}>{f.severity}</span></td>
                                  <td style={{ fontSize: '0.75rem' }}>{f.type}</td>
                                  <td style={{ fontSize: '0.85rem' }}>{f.title}</td>
                                  <CredentialCell finding={f} />
                                  <td style={{ fontSize: '0.75rem' }}>{f.status}</td>
                                  <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(f.lastSeenAt)}</td>
                                  <td>
                                    {f.status === 'open' && (
                                      <>
                                        <button className="btn" style={{ marginRight: '0.3rem', fontSize: '0.7rem' }} onClick={() => updateStatus(f.id, 'confirmed')}>确认</button>
                                        <button className="btn" style={{ marginRight: '0.3rem', fontSize: '0.7rem' }} onClick={() => updateStatus(f.id, 'ignored')}>忽略</button>
                                      </>
                                    )}
                                    {(f.status === 'open' || f.status === 'confirmed') && (
                                      <button className="btn btn-primary" style={{ fontSize: '0.7rem' }} onClick={() => updateStatus(f.id, 'resolved')}>已处理</button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {iTotal === 0 && (
            <p style={{ padding: '1rem', color: 'var(--text-dim)', textAlign: 'center' }}>
              当前没有待处置安全问题的机器
            </p>
          )}
          <Pagination page={iPage} pageSize={iPageSize} total={iTotal} totalPages={iTotalPages}
            onPageChange={setIPage} onPageSizeChange={s => { setIPageSize(s); setIPage(1); }} />
        </div>
      )}

      {tab === 'reports' && !selectedReport && (
        <div className="card">
          <table>
            <thead><tr><th>任务</th><th>模块链路</th><th>开始时间</th><th>状态</th><th>记录数</th><th>总耗时</th><th></th></tr></thead>
            <tbody>
              {runs.map((r: any) => {
                const duration = typeof r.durationMs === 'number'
                  ? `${(r.durationMs / 1000).toFixed(1)}s`
                  : '-';
                return (
                  <tr key={r.id}>
                    <td>
                      <div>{r.taskName}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', fontFamily: 'monospace' }}>{r.taskId?.slice(0, 8)}</div>
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>{(r.modules || []).join(' → ')}</td>
                    <td>{formatBeijingTime(r.startedAt)}</td>
                    <td><span style={{ color: r.status === 'completed' ? 'var(--success)' : 'var(--danger)' }}>{r.status}</span></td>
                    <td>{r.totalResults || 0}</td>
                    <td>{duration}</td>
                    <td><button className="btn" onClick={() => openReport(r.id)}>查看报告</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rTotal === 0 && <p style={{ padding: '1rem', color: 'var(--text-dim)' }}>暂无扫描记录</p>}
          <Pagination page={rPage} pageSize={rPageSize} total={rTotal} totalPages={rTotalPages}
            onPageChange={setRPage} onPageSizeChange={s => { setRPageSize(s); setRPage(1); }} />
        </div>
      )}

      {tab === 'reports' && selectedReport && (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>📋 扫描报告</h3>
              <button className="btn" onClick={() => setSelectedReport(null)}>← 返回列表</button>
            </div>
            <div className="form-row" style={{ marginTop: '0.5rem' }}>
              <button className="btn btn-primary" onClick={() => downloadReportExport('services')}>⬇ 服务 CSV</button>
              <button className="btn" onClick={() => downloadReportExport('endpoints')}>活端点 CSV</button>
              <button className="btn" onClick={() => downloadReportExport('weak-findings')}>弱口令/未授权 CSV</button>
              <button className="btn" onClick={() => downloadReportExport('auth-logs')}>认证尝试日志 CSV</button>
              <button className="btn" onClick={() => downloadReportExport('web-paths')}>Web路径 CSV</button>
              <button className="btn" onClick={() => downloadReportExport('full', 'json')}>完整 JSON</button>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginTop: '0.35rem' }}>
              下载按本次任务执行维度导出。数据库巡检看“服务/弱口令/认证日志”，公网巡检看“服务/Web路径/完整 JSON”。
            </div>
            <table style={{ marginTop: '0.5rem' }}>
              <tbody>
                <tr><td style={{ color: 'var(--text-dim)', width: '150px' }}>任务</td><td>{selectedReport.taskRun.taskName}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>模块链路</td><td>{(selectedReport.taskRun.modules || []).join(' → ')}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>状态</td><td>{selectedReport.taskRun.status}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>开始</td><td>{formatBeijingDateTime(selectedReport.taskRun.startedAt)}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>结束</td><td>{formatBeijingDateTime(selectedReport.taskRun.finishedAt)}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>结果总数</td><td>{selectedReport.summary.totalResults}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>结果类型分布</td><td>{Object.entries(selectedReport.summary.byType).map(([k, v]) => <span key={k} style={{ marginRight: '1rem' }}>{k}: <b>{v as any}</b></span>)}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>模块执行明细</h3>
            <table style={{ marginTop: '0.5rem' }}>
              <thead><tr><th>模块</th><th>状态</th><th>记录数</th><th>有效结果/命中</th><th>耗时</th><th>开始</th></tr></thead>
              <tbody>
                {selectedReport.runs.map((r: any) => {
                  const types = r.resultTypes || {};
                  const effective =
                    r.moduleId === 'db-endpoint-probe'
                      ? `${types.endpoint_alive || 0} 活端点 / ${types.log || 0} 未连通`
                      : r.moduleId === 'port-discovery'
                      ? `${types.endpoint_alive || 0} 活端点`
                      : r.moduleId === 'fingerprint'
                        ? `${types.service_identified || 0} 服务`
                        : r.moduleId === 'dirsearch'
                          ? `${types.web_path || 0} Web路径`
                          : r.moduleId === 'weak-password'
                            ? `${r.weakPasswordFindings || 0} 弱口令 / ${types.log || 0} 目标`
                            : Object.entries(types).map(([k, v]) => `${k}:${v as any}`).join(', ') || '-';
                  return (
                    <tr key={r.id}>
                      <td>{r.moduleId}</td>
                      <td><span style={{ color: r.status === 'completed' ? 'var(--success)' : r.status === 'failed' ? 'var(--danger)' : 'var(--warning)' }}>{r.status}</span></td>
                      <td>{r.total || 0}</td>
                      <td style={{ fontSize: '0.8rem' }}>{effective}</td>
                      <td>{typeof r.durationMs === 'number' ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}</td>
                      <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(r.startedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedReport.findings.length > 0 && (
            <div className="card">
              <h3>🚨 本次扫描相关问题 ({selectedReport.findings.length})</h3>
              <table style={{ marginTop: '0.5rem' }}>
                <thead><tr><th>严重度</th><th>类型</th><th>标题</th><th>凭据/证据</th></tr></thead>
                <tbody>
                  {selectedReport.findings.map((f: any) => (
                    <tr key={f.id}>
                      <td><span className={`badge badge-${f.severity}`}>{f.severity}</span></td>
                      <td>{f.type}</td>
                      <td>{f.title}</td>
                      <CredentialCell finding={f} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <h3>📎 原始结果 (前 200 条)</h3>
            <table style={{ marginTop: '0.5rem' }}>
              <thead><tr><th>类型</th><th>资产</th><th>数据</th><th>时间</th></tr></thead>
              <tbody>
                {selectedReport.results.map((r: any) => (
                  <tr key={r.id}>
                    <td><span className="badge badge-info">{r.resultType}</span></td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{r.data?.host || r.data?.ip}{r.data?.port ? `:${r.data.port}` : ''}</td>
                    <td style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-dim)' }}>
                      {JSON.stringify(r.data).slice(0, 100)}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>{formatBeijingTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
