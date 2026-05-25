import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBeijingDateTime } from '../utils/time';

export default function PortLists() {
  const [lists, setLists] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', description: '', portsText: '' });

  const load = () => api.getPortLists().then((r: any) => setLists(r.data || []));
  useEffect(() => { load(); }, []);

  const startCreate = () => { setEditing({ builtin: false, isNew: true }); setForm({ name: '', description: '', portsText: '' }); };
  const startEdit = (list: any) => {
    setEditing(list);
    setForm({ name: list.name, description: list.description || '', portsText: list.ports.join(',') });
  };

  const save = async () => {
    if (!form.name.trim()) { alert('请填写名称'); return; }
    const payload = { name: form.name, description: form.description, portsText: form.portsText };
    if (editing?.isNew) {
      const res: any = await api.createPortList(payload);
      if (!res.ok) { alert(res.error); return; }
    } else {
      const res: any = await api.updatePortList(editing.id, payload);
      if (!res.ok) { alert(res.error); return; }
    }
    setEditing(null);
    load();
  };

  const del = async (id: string) => {
    if (!confirm('确认删除？')) return;
    const res: any = await api.deletePortList(id);
    if (!res.ok) alert(res.error);
    load();
  };

  const previewCount = form.portsText
    ? new Set(form.portsText.split(/[\s,;\n]+/).flatMap(s => {
        const m = s.match(/^(\d+)-(\d+)$/);
        if (m) { const arr = []; for (let i = +m[1]; i <= +m[2]; i++) arr.push(i); return arr; }
        const n = parseInt(s); return n > 0 && n < 65536 ? [n] : [];
      })).size
    : 0;

  return (
    <div>
      <h2 style={{ marginBottom: '1rem' }}>端口列表管理</h2>

      {editing ? (
        <div className="card">
          <h3>{editing.isNew ? '新建端口列表' : `编辑 ${editing.name}`}</h3>
          {editing.builtin && (
            <p style={{ color: 'var(--warning)', fontSize: '0.85rem', margin: '0.5rem 0' }}>⚠ 内置列表不可修改</p>
          )}
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <input placeholder="名称，例如 my-common" style={{ flex: 1 }} disabled={editing.builtin}
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-row">
            <input placeholder="说明" style={{ flex: 1 }} disabled={editing.builtin}
              value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
              端口（支持 22,80,443 / 1000-2000 / 换行或空格分隔，去重后 {previewCount} 个）
            </div>
            <textarea
              disabled={editing.builtin}
              value={form.portsText}
              onChange={e => setForm({ ...form, portsText: e.target.value })}
              style={{ width: '100%', minHeight: '200px', fontFamily: 'monospace', fontSize: '0.85rem',
                padding: '0.5rem', background: 'var(--bg)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: '4px' }}
              placeholder="22,80,443,3306,6379,8080&#10;或 1-1024"
            />
          </div>
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            {!editing.builtin && <button className="btn btn-primary" onClick={save}>保存</button>}
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>共 {lists.length} 个列表</span>
            <button className="btn btn-primary" onClick={startCreate}>+ 新建列表</button>
          </div>
          <table style={{ marginTop: '0.75rem' }}>
            <thead><tr><th>名称</th><th>说明</th><th>端口数</th><th>类型</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {lists.map(l => (
                <tr key={l.id}>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{l.name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>{l.description || '-'}</td>
                  <td>{l.ports?.length || 0}</td>
                  <td>{l.builtin ? <span className="badge badge-info">内置</span> : <span className="badge badge-medium">自定义</span>}</td>
                  <td>{formatBeijingDateTime(l.updatedAt)}</td>
                  <td>
                    <button className="btn" onClick={() => startEdit(l)}>{l.builtin ? '查看' : '编辑'}</button>
                    {!l.builtin && <button className="btn btn-danger" style={{ marginLeft: '0.3rem' }} onClick={() => del(l.id)}>删除</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
