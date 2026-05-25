import React, { useState } from 'react';

export default function Login({ onSuccess }: { onSuccess: (user: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.ok) {
        onSuccess(data.data.user);
      } else {
        setError(data.error || '登录失败');
      }
    } catch (err: any) {
      setError(err.message || '网络错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <form onSubmit={submit} style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '8px', padding: '2rem', width: '360px',
      }}>
        <h1 style={{ color: 'var(--accent)', fontSize: '1.2rem', marginBottom: '0.3rem' }}>SASP</h1>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
          安全资产扫描平台
        </p>

        <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
          用户名
        </label>
        <input style={{ width: '100%', marginBottom: '0.8rem' }}
          value={username} onChange={e => setUsername(e.target.value)} autoFocus />

        <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>
          密码
        </label>
        <input style={{ width: '100%', marginBottom: '1rem' }}
          type="password" value={password} onChange={e => setPassword(e.target.value)} />

        {error && (
          <div style={{
            padding: '0.5rem', marginBottom: '0.8rem', background: 'rgba(239,83,80,0.1)',
            border: '1px solid var(--danger)', borderRadius: '4px',
            color: 'var(--danger)', fontSize: '0.8rem',
          }}>{error}</div>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || !username || !password}
          style={{ width: '100%', padding: '0.6rem' }}>
          {busy ? '登录中…' : '登录'}
        </button>

        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '1rem', textAlign: 'center' }}>
          凭据配置在 .env 文件中
        </div>
      </form>
    </div>
  );
}
