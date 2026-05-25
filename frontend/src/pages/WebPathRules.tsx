import React, { useEffect, useState } from 'react';
import { api } from '../api';

const severities = ['critical', 'high', 'medium', 'low', 'info'];
const categories = ['sensitive_leak', 'admin_entry', 'api_doc', 'metrics', 'debug', 'other'];

function splitList(value: string): string[] {
  return value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function joinList(value?: string[]): string {
  return (value || []).join(', ');
}

function toForm(rule?: any) {
  return {
    id: rule?.id || '',
    name: rule?.name || '',
    enabled: rule?.enabled ?? true,
    builtin: rule?.builtin ?? false,
    severity: rule?.severity || 'medium',
    category: rule?.category || 'other',
    pathRegex: rule?.match?.pathRegex || '',
    pathContainsAny: joinList(rule?.match?.pathContainsAny),
    statusCodes: (rule?.match?.statusCodes || []).join(', '),
    contentTypeIncludes: joinList(rule?.match?.contentTypeIncludes),
    titleContainsAny: joinList(rule?.match?.titleContainsAny),
    bodyContainsAny: joinList(rule?.match?.bodyContainsAny),
    bodyRegex: rule?.match?.bodyRegex || '',
    description: rule?.description || '',
    recommendation: rule?.recommendation || '',
  };
}

function fromForm(form: any) {
  return {
    name: form.name,
    enabled: form.enabled,
    type: 'sensitive_path',
    severity: form.severity,
    category: form.category,
    match: {
      pathRegex: form.pathRegex || undefined,
      pathContainsAny: splitList(form.pathContainsAny),
      statusCodes: splitList(form.statusCodes).map(Number).filter(Boolean),
      contentTypeIncludes: splitList(form.contentTypeIncludes),
      titleContainsAny: splitList(form.titleContainsAny),
      bodyContainsAny: splitList(form.bodyContainsAny),
      bodyRegex: form.bodyRegex || undefined,
    },
    description: form.description,
    recommendation: form.recommendation,
  };
}

export default function WebPathRules() {
  const [rules, setRules] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [message, setMessage] = useState('');

  const load = async () => {
    const res: any = await api.getWebPathRules();
    if (res.ok) setRules(res.data || []);
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.name) return;
    const payload = fromForm(editing);
    const res: any = editing.id
      ? await api.updateWebPathRule(editing.id, payload)
      : await api.createWebPathRule(payload);
    if (res.ok) {
      setEditing(null);
      setMessage('规则已保存');
      load();
    } else {
      setMessage(res.error || '保存失败');
    }
  };

  const toggle = async (rule: any) => {
    await api.updateWebPathRule(rule.id, { enabled: !rule.enabled });
    load();
  };

  const remove = async (rule: any) => {
    if (!confirm(`确认删除规则：${rule.name}？`)) return;
    const res: any = await api.deleteWebPathRule(rule.id);
    setMessage(res.ok ? '规则已删除' : (res.error || '删除失败'));
    load();
  };

  const reevaluate = async () => {
    setMessage('正在重新评估历史 Web路径…');
    const res: any = await api.reevaluateWebPathRules();
    if (res.ok) setMessage(`重评估完成：扫描 ${res.data.scanned} 条路径，命中 ${res.data.emitted} 次规则`);
    else setMessage(res.error || '重评估失败');
  };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>风险路径规则</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        规则只对已通过 dirsearch 真实性校验的 Web路径做内容确认。敏感信息泄露按高危/严重处理，普通入口/文档/指标默认中低危。
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setEditing(toForm())}>新增规则</button>
          <button className="btn" onClick={reevaluate}>重新评估历史 Web路径</button>
          {message && <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{message}</span>}
        </div>
      </div>

      {editing && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>{editing.id ? '编辑规则' : '新增规则'}</h3>
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <input placeholder="规则名称" style={{ flex: '1 1 260px' }} value={editing.name}
              onChange={e => setEditing({ ...editing, name: e.target.value })} />
            <select value={editing.severity} onChange={e => setEditing({ ...editing, severity: e.target.value })}>
              {severities.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} />
              启用
            </label>
          </div>
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <input placeholder="pathRegex，例如 ^/actuator/env$" style={{ flex: '1 1 320px' }} value={editing.pathRegex}
              onChange={e => setEditing({ ...editing, pathRegex: e.target.value })} />
            <input placeholder="状态码，例如 200,401" style={{ width: '180px' }} value={editing.statusCodes}
              onChange={e => setEditing({ ...editing, statusCodes: e.target.value })} />
            <input placeholder="Content-Type 包含，例如 json" style={{ width: '220px' }} value={editing.contentTypeIncludes}
              onChange={e => setEditing({ ...editing, contentTypeIncludes: e.target.value })} />
          </div>
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <input placeholder="路径包含任一，逗号分隔" style={{ flex: '1 1 260px' }} value={editing.pathContainsAny}
              onChange={e => setEditing({ ...editing, pathContainsAny: e.target.value })} />
            <input placeholder="标题包含任一，逗号分隔" style={{ flex: '1 1 260px' }} value={editing.titleContainsAny}
              onChange={e => setEditing({ ...editing, titleContainsAny: e.target.value })} />
            <input placeholder="bodyRegex" style={{ flex: '1 1 260px' }} value={editing.bodyRegex}
              onChange={e => setEditing({ ...editing, bodyRegex: e.target.value })} />
          </div>
          <textarea placeholder="Body 包含任一，逗号或换行分隔" style={{ width: '100%' }} value={editing.bodyContainsAny}
            onChange={e => setEditing({ ...editing, bodyContainsAny: e.target.value })} />
          <textarea placeholder="描述" style={{ width: '100%' }} value={editing.description}
            onChange={e => setEditing({ ...editing, description: e.target.value })} />
          <textarea placeholder="修复建议" style={{ width: '100%' }} value={editing.recommendation}
            onChange={e => setEditing({ ...editing, recommendation: e.target.value })} />
          <div className="form-row">
            <button className="btn btn-primary" onClick={save}>保存</button>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>状态</th><th>名称</th><th>等级</th><th>分类</th><th>路径规则</th><th>内容确认</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(rule => (
              <tr key={rule.id} style={!rule.enabled ? { opacity: 0.55 } : {}}>
                <td>{rule.enabled ? <span className="badge badge-info">启用</span> : <span className="badge badge-low">停用</span>}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{rule.name}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'monospace' }}>{rule.id}{rule.builtin ? ' · builtin' : ''}</div>
                </td>
                <td><span className={`badge badge-${rule.severity}`}>{rule.severity}</span></td>
                <td>{rule.category || '-'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: '0.75rem', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {rule.match?.pathRegex || joinList(rule.match?.pathContainsAny) || '-'}
                </td>
                <td style={{ fontSize: '0.75rem', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {[joinList(rule.match?.bodyContainsAny), rule.match?.bodyRegex, joinList(rule.match?.contentTypeIncludes)]
                    .filter(Boolean).join(' / ') || '-'}
                </td>
                <td>
                  <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => toggle(rule)}>{rule.enabled ? '禁用' : '启用'}</button>
                  <button className="btn" style={{ marginRight: '0.3rem' }} onClick={() => setEditing(toForm(rule))}>编辑</button>
                  {!rule.builtin && <button className="btn btn-danger" onClick={() => remove(rule)}>删除</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
