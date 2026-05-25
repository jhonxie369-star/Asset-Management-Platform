import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

const categories = ['database', 'middleware', 'webserver', 'cms', 'framework', 'devops', 'monitoring', 'other'];
const matcherTypes = ['banner', 'header', 'body', 'title', 'favicon', 'cert'];

function splitList(value: string): string[] {
  return value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

function toForm(rule?: any) {
  return {
    id: rule?.id || '',
    source: rule?.source || 'user',
    name: rule?.name || '',
    product: rule?.product || '',
    category: rule?.category || 'other',
    enabled: rule?.enabled ?? true,
    matchMode: rule?.matchMode || 'any',
    priority: rule?.priority ?? 3,
    severity: rule?.severity || '',
    tags: (rule?.tags || []).join(', '),
    matchersText: JSON.stringify(rule?.matchers || [{ type: 'body', pattern: 'ExampleProduct' }], null, 2),
  };
}

function fromForm(form: any) {
  return {
    name: form.name,
    product: form.product,
    category: form.category,
    enabled: form.enabled,
    matchMode: form.matchMode,
    priority: Number(form.priority),
    severity: form.severity || undefined,
    tags: splitList(form.tags),
    matchers: JSON.parse(form.matchersText || '[]'),
  };
}

function matcherSummary(matchers: any[] = []) {
  return matchers.map(m => {
    const field = m.field ? `:${m.field}` : '';
    const version = m.versionGroup ? ` → v${m.versionGroup}` : '';
    return `${m.type}${field} /${m.pattern}/${m.flags || 'i'}${version}`;
  }).join('\n');
}

export default function FingerprintRules() {
  const [rules, setRules] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const [filters, setFilters] = useState({ q: '', category: '', source: '', enabled: '', matcherType: '' });

  const load = async () => {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''));
    const res: any = await api.getFingerprintRules(params);
    if (res.ok) {
      setRules(res.data || []);
      setStats(res.stats);
    } else {
      setMessage(res.error || '加载失败');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const rule of rules) {
      const key = rule.category || 'other';
      const arr = m.get(key) || [];
      arr.push(rule);
      m.set(key, arr);
    }
    return [...m.entries()];
  }, [rules]);

  const save = async () => {
    if (!editing?.name || !editing?.product) {
      setMessage('name/product 必填');
      return;
    }
    try {
      const payload = editing.source === 'builtin'
        ? { enabled: editing.enabled, tags: splitList(editing.tags) }
        : fromForm(editing);
      const res: any = editing.id
        ? await api.updateFingerprintRule(editing.id, payload)
        : await api.createFingerprintRule(payload);
      if (res.ok) {
        setEditing(null);
        setMessage('规则已保存；后续 fingerprint 任务会直接使用最新规则，无需重启');
        load();
      } else {
        setMessage(res.error || '保存失败');
      }
    } catch (err: any) {
      setMessage(`规则 JSON 无效：${err.message}`);
    }
  };

  const toggle = async (rule: any) => {
    const res: any = await api.updateFingerprintRule(rule.id, { enabled: !rule.enabled });
    setMessage(res.ok ? `${rule.name} 已${rule.enabled ? '禁用' : '启用'}` : (res.error || '操作失败'));
    load();
  };

  const remove = async (rule: any) => {
    if (!confirm(`确认删除自定义指纹规则：${rule.name}？`)) return;
    const res: any = await api.deleteFingerprintRule(rule.id);
    setMessage(res.ok ? '规则已删除' : (res.error || '删除失败'));
    load();
  };

  const duplicate = (rule: any) => {
    const form = toForm({ ...rule, id: '', source: 'user', name: `${rule.name} Copy` });
    setEditing(form);
  };

  const resetBuiltin = async () => {
    if (!confirm('确认重新同步内置指纹库？会更新内置规则内容，但保留启用/禁用状态。')) return;
    const res: any = await api.resetBuiltinFingerprintRules();
    setMessage(res.ok ? `内置规则已同步：${res.data.restored} 条` : (res.error || '同步失败'));
    load();
  };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>指纹库</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        管理 fingerprint 模块使用的规则库。指纹任务每次执行都会从数据库读取启用规则，所以启用/禁用和新增自定义规则不需要重启服务。
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="搜索名称 / 产品 / 标签 / matcher" style={{ flex: '1 1 260px' }}
            value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} />
          <select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}>
            <option value="">全部分类</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.source} onChange={e => setFilters({ ...filters, source: e.target.value })}>
            <option value="">全部来源</option>
            <option value="builtin">内置</option>
            <option value="user">自定义</option>
          </select>
          <select value={filters.enabled} onChange={e => setFilters({ ...filters, enabled: e.target.value })}>
            <option value="">全部状态</option>
            <option value="true">启用</option>
            <option value="false">禁用</option>
          </select>
          <select value={filters.matcherType} onChange={e => setFilters({ ...filters, matcherType: e.target.value })}>
            <option value="">全部 matcher</option>
            {matcherTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn btn-primary" onClick={load}>{loading ? '加载中…' : '筛选'}</button>
          <button className="btn" onClick={() => { setFilters({ q: '', category: '', source: '', enabled: '', matcherType: '' }); setTimeout(load, 0); }}>重置</button>
        </div>
        <div className="form-row" style={{ flexWrap: 'wrap', marginTop: '0.6rem' }}>
          <button className="btn btn-primary" onClick={() => setEditing(toForm())}>新增自定义规则</button>
          <button className="btn" onClick={resetBuiltin}>同步内置规则</button>
          {stats && (
            <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              共 {stats.total} 条，启用 {stats.enabled}，禁用 {stats.disabled}
            </span>
          )}
          {message && <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{message}</span>}
        </div>
      </div>

      {editing && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>{editing.id ? `编辑 ${editing.name}` : '新增自定义指纹规则'}</h3>
          {editing.source === 'builtin' && (
            <p style={{ color: 'var(--warning)', fontSize: '0.8rem' }}>
              内置规则只允许启用/禁用和标签微调；如果要改匹配内容，请复制为自定义规则。
            </p>
          )}
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <input placeholder="规则名称" disabled={editing.source === 'builtin'} style={{ flex: '1 1 220px' }}
              value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            <input placeholder="产品名" disabled={editing.source === 'builtin'} style={{ flex: '1 1 180px' }}
              value={editing.product} onChange={e => setEditing({ ...editing, product: e.target.value })} />
            <select disabled={editing.source === 'builtin'} value={editing.category}
              onChange={e => setEditing({ ...editing, category: e.target.value })}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
              <input type="checkbox" checked={editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} />
              启用
            </label>
          </div>
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <select disabled={editing.source === 'builtin'} value={editing.matchMode}
              onChange={e => setEditing({ ...editing, matchMode: e.target.value })}>
              <option value="any">any 任一命中</option>
              <option value="all">all 全部命中</option>
            </select>
            <input disabled={editing.source === 'builtin'} type="number" min={0} max={10} style={{ width: '120px' }}
              value={editing.priority} onChange={e => setEditing({ ...editing, priority: Number(e.target.value) })} />
            <input disabled={editing.source === 'builtin'} placeholder="风险等级(可选)" style={{ width: '160px' }}
              value={editing.severity} onChange={e => setEditing({ ...editing, severity: e.target.value })} />
            <input placeholder="标签，逗号分隔" style={{ flex: '1 1 260px' }}
              value={editing.tags} onChange={e => setEditing({ ...editing, tags: e.target.value })} />
          </div>
          <textarea disabled={editing.source === 'builtin'} spellCheck={false}
            style={{ width: '100%', minHeight: '210px', fontFamily: 'monospace', fontSize: '0.78rem' }}
            value={editing.matchersText}
            onChange={e => setEditing({ ...editing, matchersText: e.target.value })}
          />
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginBottom: '0.6rem' }}>
            matcher 示例：<code>{'{"type":"header","field":"server","pattern":"nginx/([\\\\d.]+)","versionGroup":1}'}</code>
          </div>
          <div className="form-row">
            <button className="btn btn-primary" onClick={save}>保存</button>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="card">
        {grouped.map(([category, items]) => (
          <div key={category} style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: '0.4rem 0' }}>{category} <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{items.length} 条</span></h3>
            <table>
              <thead>
                <tr>
                  <th>状态</th><th>产品 / 规则</th><th>优先级</th><th>Matcher</th><th>标签</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map(rule => (
                  <tr key={rule.id} style={!rule.enabled ? { opacity: 0.55 } : {}}>
                    <td>
                      {rule.enabled ? <span className="badge badge-info">启用</span> : <span className="badge badge-low">禁用</span>}
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>{rule.source || 'user'}</div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 700 }}>{rule.product}</div>
                      <div>{rule.name}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-dim)' }}>{rule.id}</div>
                    </td>
                    <td>
                      <div>{rule.priority ?? 3}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{rule.matchMode || 'any'}</div>
                    </td>
                    <td style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.72rem', maxWidth: '520px' }}>
                      {matcherSummary(rule.matchers)}
                    </td>
                    <td style={{ fontSize: '0.75rem', maxWidth: '240px' }}>{(rule.tags || []).join(', ') || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => toggle(rule)}>{rule.enabled ? '禁用' : '启用'}</button>
                      <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => setEditing(toForm(rule))}>编辑</button>
                      <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => duplicate(rule)}>复制</button>
                      {rule.source !== 'builtin' && <button className="btn btn-danger" onClick={() => remove(rule)}>删除</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
