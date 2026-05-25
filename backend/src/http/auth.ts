import { Router, type RequestHandler } from 'express';
import { timingSafeEqual } from 'crypto';
import type { ApiKeyRecord } from '@sasp/shared';
import { appConfig } from '../config/app.js';
import { Store } from '../storage/store.js';
import { sha256 } from './api-keys.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearerToken(req: any): string | undefined {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

function keyIdFromToken(token: string): string | undefined {
  const m = token.match(/^(sasp_[a-f0-9]{12})\./i);
  return m?.[1];
}

export function requireAuth(store: Store): RequestHandler {
  return (req, res, next) => {
    if (appConfig.auth.disabled) {
      (req as any).authActor = { type: 'system', id: 'auth-disabled', scopes: ['*'] };
      return next();
    }
    const path = req.path;
    if (path.startsWith('/auth/') || path === '/auth') return next();

    const token = bearerToken(req);
    if (token) {
      const keyId = keyIdFromToken(token);
      const key = keyId
        ? (store.getAll('apiKeys') as ApiKeyRecord[]).find(k => k.keyId === keyId && !k.revokedAt)
        : undefined;
      if (key && safeEqual(key.keyHash, sha256(token))) {
        store.update('apiKeys', key.id, { lastUsedAt: new Date().toISOString() });
        (req as any).authActor = { type: 'api_key', id: key.keyId, scopes: key.scopes, name: key.name };
        return next();
      }
    }

    const sess = (req as any).session;
    if (sess && sess.user) {
      (req as any).authActor = { type: 'session', user: sess.user, scopes: ['*'] };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}

export function authRoutes(): Router {
  const r = Router();

  r.get('/status', (req, res) => {
    const sess = (req as any).session;
    const actor = (req as any).authActor;
    res.json({
      ok: true,
      data: {
        authRequired: !appConfig.auth.disabled,
        authenticated: !!sess?.user || !!actor,
        user: sess?.user || null,
        actor: actor || null,
      },
    });
  });

  r.post('/login', (req, res) => {
    if (appConfig.auth.disabled) {
      return res.json({ ok: true, data: { user: 'guest' } });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'username 和 password 必填' });
    }
    const hit = appConfig.auth.users.find(u => u.username === username && u.password === password);
    if (!hit) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }
    (req as any).session.user = hit.username;
    res.json({ ok: true, data: { user: hit.username } });
  });

  r.post('/logout', (req, res) => {
    const sess = (req as any).session;
    if (sess) {
      sess.destroy((err: any) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.clearCookie('sasp.sid');
        res.json({ ok: true });
      });
    } else {
      res.json({ ok: true });
    }
  });

  return r;
}
