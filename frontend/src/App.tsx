import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Endpoints from './pages/Endpoints';
import Tasks from './pages/Tasks';
import Findings from './pages/Findings';
import FingerprintStats from './pages/FingerprintStats';
import WebPathRules from './pages/WebPathRules';
import PortLists from './pages/PortLists';
import AssetLists from './pages/AssetLists';
import Login from './pages/Login';
import { api, setUnauthorizedHandler } from './api';

const navItems = [
  { path: '/endpoints', label: '活端点与服务' },
  { path: '/fingerprints', label: '指纹统计' },
  { path: '/tasks', label: '任务中心' },
  { path: '/findings', label: '问题发现' },
  { path: '/web-path-rules', label: '风险路径规则' },
  { path: '/asset-lists', label: '资产列表' },
  { path: '/port-lists', label: '端口列表' },
];

type AuthState = 'checking' | 'needLogin' | 'authed';

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<string | null>(null);

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' });
      const data = await res.json();
      if (data.ok) {
        if (!data.data.authRequired) {
          setAuthState('authed');
          setUser('guest');
        } else if (data.data.authenticated) {
          setAuthState('authed');
          setUser(data.data.user);
        } else {
          setAuthState('needLogin');
        }
      } else {
        setAuthState('needLogin');
      }
    } catch {
      setAuthState('needLogin');
    }
  };

  useEffect(() => {
    checkAuth();
    setUnauthorizedHandler(() => setAuthState('needLogin'));
  }, []);

  const logout = async () => {
    await api.logout();
    setUser(null);
    setAuthState('needLogin');
  };

  if (authState === 'checking') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-dim)',
      }}>加载中…</div>
    );
  }

  if (authState === 'needLogin') {
    return <Login onSuccess={u => { setUser(u); setAuthState('authed'); }} />;
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>SASP</h1>
        {navItems.map(n => (
          <NavLink key={n.path} to={n.path}>{n.label}</NavLink>
        ))}
        <div style={{
          marginTop: 'auto', padding: '0.5rem 1rem', fontSize: '0.7rem',
          color: 'var(--text-dim)', borderTop: '1px solid var(--border)',
          position: 'absolute', bottom: 0, width: '100%',
        }}>
          <div>👤 {user}</div>
          <button className="btn" onClick={logout} style={{ width: '100%', marginTop: '0.4rem', fontSize: '0.7rem' }}>
            退出登录
          </button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/endpoints" replace />} />
          <Route path="/endpoints" element={<Endpoints />} />
          <Route path="/fingerprints" element={<FingerprintStats />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/findings" element={<Findings />} />
          <Route path="/web-path-rules" element={<WebPathRules />} />
          <Route path="/asset-lists" element={<AssetLists />} />
          <Route path="/port-lists" element={<PortLists />} />
        </Routes>
      </main>
    </div>
  );
}
