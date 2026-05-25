import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { beijingFileTimestamp, formatBeijingTime } from '../utils/time';

type FingerprintRecord = {
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
  scope?: 'public' | 'private';
  instance?: { key: string; role?: string; cloud?: string; name?: string };
  taskName?: string;
};

type FingerprintGroup = {
  fingerprint: string;
  version?: string;
  count: number;
  endpointCount: number;
  ipCount: number;
  ports: number[];
  publicCount: number;
  privateCount: number;
  examples: FingerprintRecord[];
};

type ApiData = {
  date: string;
  mode: string;
  days: string[];
  dailySummaries?: Array<{
    date: string;
    fingerprintCount: number;
    endpointFingerprintCount: number;
    endpointCount: number;
    ipCount: number;
    publicCount: number;
    privateCount: number;
    topFingerprints: { fingerprint: string; count: number }[];
    topPorts: { port: number; count: number }[];
  }>;
  summary: {
    newFingerprints: number;
    newEndpointFingerprints: number;
    endpointCount: number;
    ipCount: number;
    publicCount: number;
    privateCount: number;
    topPorts: { port: number; count: number }[];
  };
  groups: FingerprintGroup[];
  records: FingerprintRecord[];
};

const CLOUD_BADGE: Record<string, string> = {
  alicloud: 'aliyun', aws: 'AWS', tencentcloud: '腾讯', huaweicloud: '华为',
};

function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

export default function FingerprintStats() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'current' | 'new' | 'all' | 'history'>('current');
  const [date, setDate] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const params = useMemo(() => {
    const p: Record<string, string> = { mode };
    if (mode === 'new' && date) p.date = date;
    if (q.trim()) p.q = q.trim();
    if (scope) p.scope = scope;
    return p;
  }, [mode, date, q, scope]);

  const load = async () => {
    setLoading(true);
    try {
      const res: any = await api.getFingerprintDaily(params);
      if (res.ok) {
        setData(res.data);
        if (!date && res.data?.date) setDate(res.data.date);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [params]);

  const exportCsv = () => {
    if (!data) return;
    const headers = ['date', 'firstSeenAt', 'fingerprint', 'version', 'ip', 'host', 'port', 'scope', 'protocol', 'product', 'confidence', 'source', 'instance', 'taskName'];
    const rows = data.records.map(r => [
      r.date,
      formatBeijingTime(r.firstSeenAt),
      r.fingerprint,
      r.version || '',
      r.ip,
      r.host || '',
      r.port,
      r.scope || '',
      r.protocol || '',
      r.product || '',
      r.confidence || '',
      r.source || '',
      r.instance ? `${r.instance.cloud || ''} ${r.instance.role || ''} ${r.instance.name || ''} ${r.instance.key || ''}`.trim() : '',
      r.taskName || '',
    ]);
    const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
    download(`fingerprints-${mode}-${data.date}-${beijingFileTimestamp()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
  };

  const exportDailyCsv = () => {
    if (!data?.dailySummaries?.length) return;
    const headers = ['date', 'fingerprintCount', 'endpointFingerprintCount', 'endpointCount', 'ipCount', 'publicCount', 'privateCount', 'topFingerprints', 'topPorts'];
    const rows = data.dailySummaries.map(d => [
      d.date,
      d.fingerprintCount,
      d.endpointFingerprintCount,
      d.endpointCount,
      d.ipCount,
      d.publicCount,
      d.privateCount,
      d.topFingerprints.map(x => `${x.fingerprint}:${x.count}`).join('; '),
      d.topPorts.map(x => `${x.port}:${x.count}`).join('; '),
    ]);
    const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
    download(`fingerprints-daily-new-${beijingFileTimestamp()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
  };

  const modeTitle: Record<typeof mode, string> = {
    current: '现存指纹',
    new: '每日新增指纹',
    all: '全部指纹',
    history: '历史指纹',
  };
  const modeDesc: Record<typeof mode, string> = {
    current: '当前仍在线的服务指纹快照。',
    new: '按北京时间统计当天首次出现的 endpoint 指纹。',
    all: '历史上曾经识别到的全部 endpoint 指纹。',
    history: '已经消失或不再在线的历史 endpoint 指纹。',
  };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>指纹统计</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        支持看现存指纹、每日新增、全部历史和已消失历史指纹。可展开查看对应 IP、端口、机器和任务来源。
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="form-row">
          <button className={`btn ${mode === 'current' ? 'btn-primary' : ''}`} onClick={() => setMode('current')}>现存指纹</button>
          <button className={`btn ${mode === 'new' ? 'btn-primary' : ''}`} onClick={() => setMode('new')}>每日新增</button>
          <button className={`btn ${mode === 'all' ? 'btn-primary' : ''}`} onClick={() => setMode('all')}>全部指纹</button>
          <button className={`btn ${mode === 'history' ? 'btn-primary' : ''}`} onClick={() => setMode('history')}>历史指纹</button>
          {mode === 'new' && (
            <select value={date} onChange={e => setDate(e.target.value)}>
              {(data?.days || (date ? [date] : [])).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <input placeholder="搜索 指纹 / IP / 端口 / 机器 / 任务" style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)} />
          <select value={scope} onChange={e => setScope(e.target.value)}>
            <option value="">全部网络</option>
            <option value="public">公网</option>
            <option value="private">私网</option>
          </select>
          <button className="btn" onClick={load} disabled={loading}>↻ 刷新</button>
          <button className="btn btn-primary" onClick={exportCsv} disabled={!data || data.records.length === 0}>下载明细 CSV</button>
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card"><div className="value">{data?.summary.newFingerprints || 0}</div><div className="label">指纹类型</div></div>
        <div className="stat-card"><div className="value" style={{ color: 'var(--accent)' }}>{data?.summary.endpointCount || 0}</div><div className="label">涉及端点</div></div>
        <div className="stat-card"><div className="value">{data?.summary.ipCount || 0}</div><div className="label">涉及 IP</div></div>
        <div className="stat-card"><div className="value" style={{ color: 'var(--warning)' }}>{data?.summary.publicCount || 0}</div><div className="label">公网指纹记录</div></div>
      </div>

      {data?.summary.topPorts?.length ? (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>{modeTitle[mode]}端口分布</h3>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {data.summary.topPorts.map(p => (
              <span key={p.port} className="badge badge-info" style={{ fontFamily: 'monospace' }}>{p.port} × {p.count}</span>
            ))}
          </div>
        </div>
      ) : null}

      {mode === 'new' && data?.dailySummaries?.length ? (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <div>
              <h3 style={{ margin: 0 }}>每日新增概览</h3>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', marginTop: '0.25rem' }}>
                每行是北京时间当天首次出现的 endpoint 指纹；点“看明细”会切到该日期，下方展示具体 IP、端口、机器和任务。
              </div>
            </div>
            <button className="btn" onClick={exportDailyCsv}>下载每日概览 CSV</button>
          </div>
          <table style={{ marginTop: '0.75rem' }}>
            <thead>
              <tr><th>日期</th><th>新增指纹</th><th>端点指纹</th><th>IP/端点</th><th>公网/私网</th><th>Top 指纹</th><th>Top 端口</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.dailySummaries.map(d => (
                <tr key={d.date} style={d.date === data.date ? { background: 'rgba(79,195,247,0.06)' } : undefined}>
                  <td style={{ fontFamily: 'monospace', fontWeight: d.date === data.date ? 700 : 400 }}>{d.date}</td>
                  <td>{d.fingerprintCount}</td>
                  <td>{d.endpointFingerprintCount}</td>
                  <td>{d.ipCount} IP / {d.endpointCount} 端点</td>
                  <td><span className="badge badge-info">公网 {d.publicCount}</span> <span className="badge badge-low">私网 {d.privateCount}</span></td>
                  <td style={{ fontSize: '0.75rem' }}>
                    {d.topFingerprints.map(x => <span key={x.fingerprint} className="badge badge-info" style={{ marginRight: '0.25rem', marginBottom: '0.2rem' }}>{x.fingerprint} × {x.count}</span>)}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{d.topPorts.map(x => `${x.port}×${x.count}`).join(', ')}</td>
                  <td><button className="btn" onClick={() => setDate(d.date)}>{d.date === data.date ? '当前明细' : '看明细'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{modeTitle[mode]}</h3>
        <p style={{ marginTop: '-0.4rem', color: 'var(--text-dim)', fontSize: '0.78rem' }}>{modeDesc[mode]}</p>
        {loading && <p style={{ color: 'var(--text-dim)' }}>加载中...</p>}
        {!loading && (!data || data.groups.length === 0) && <p style={{ color: 'var(--text-dim)' }}>没有匹配的指纹记录</p>}
        {data && data.groups.length > 0 && (
          <table>
            <thead>
              <tr><th>指纹</th><th>端点</th><th>IP</th><th>端口</th><th>公网/私网</th><th>样例</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.groups.map(g => {
                const key = `${g.fingerprint}|${g.version || ''}`;
                const isOpen = !!expanded[key];
                const details = data.records.filter(r => r.fingerprint === g.fingerprint && (r.version || '') === (g.version || ''));
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 700 }}>{g.fingerprint}</div>
                        {g.version && <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{g.version}</div>}
                      </td>
                      <td>{g.endpointCount}</td>
                      <td>{g.ipCount}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{g.ports.slice(0, 8).join(', ')}{g.ports.length > 8 ? ` +${g.ports.length - 8}` : ''}</td>
                      <td><span className="badge badge-info">公网 {g.publicCount}</span> <span className="badge badge-low">私网 {g.privateCount}</span></td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {g.examples.slice(0, 3).map(e => `${e.ip}:${e.port}`).join(', ')}{g.examples.length > 3 ? ' ...' : ''}
                      </td>
                      <td><button className="btn" onClick={() => setExpanded({ ...expanded, [key]: !isOpen })}>{isOpen ? '收起' : '查看 IP/端口'}</button></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--bg)', padding: '0.75rem' }}>
                          <table style={{ margin: 0 }}>
                            <thead><tr><th>IP</th><th>端口</th><th>网络</th><th>协议/产品</th><th>机器</th><th>首次发现</th><th>任务</th></tr></thead>
                            <tbody>
                              {details.map(r => (
                                <tr key={r.key}>
                                  <td style={{ fontFamily: 'monospace' }}>{r.ip}</td>
                                  <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.port}</td>
                                  <td>{r.scope ? (r.scope === 'public' ? '公网' : '私网') : '-'}</td>
                                  <td>{r.protocol || '-'}{r.product ? ` / ${r.product}` : ''}</td>
                                  <td style={{ fontSize: '0.75rem' }}>
                                    {r.instance ? (
                                      <>
                                        <div style={{ fontFamily: 'monospace' }} title={r.instance.key}>
                                          {r.instance.cloud && <span className="badge badge-info" style={{ marginRight: '0.3rem' }}>{CLOUD_BADGE[r.instance.cloud] || r.instance.cloud}</span>}
                                          {r.instance.role || '-'}·{r.instance.key.split(':').slice(-1)[0]?.slice(0, 14)}
                                        </div>
                                        {r.instance.name && <div style={{ color: 'var(--text-dim)' }}>{r.instance.name}</div>}
                                      </>
                                    ) : '-'}
                                  </td>
                                  <td>{formatBeijingTime(r.firstSeenAt)}</td>
                                  <td style={{ fontSize: '0.75rem' }}>{r.taskName || '-'}</td>
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
        )}
      </div>
    </div>
  );
}
