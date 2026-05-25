import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import type { ApiKeyRecord, AuthAuditLog } from '@sasp/shared';
import { Store } from '../storage/store.js';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function apiKeyRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const keys = (store.getAll('apiKeys') as ApiKeyRecord[])
      .map(({ keyHash, ...safe }) => safe)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, data: keys, total: keys.length });
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name 必填' });
    const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length > 0
      ? req.body.scopes.map((s: unknown) => String(s)).filter(Boolean)
      : ['read:*'];
    const keyId = `sasp_${randomBytes(6).toString('hex')}`;
    const key = `${keyId}.${randomBytes(24).toString('hex')}`;
    const actor = (req as any).authActor;
    const record: ApiKeyRecord = {
      id: uuid(), keyId, name, scopes, keyHash: sha256(key),
      createdBy: actor?.id || actor?.user,
      createdAt: now,
    };
    store.insert('apiKeys', record);
    audit(store, {
      actorType: actor?.type || 'session', actorId: actor?.id || actor?.user,
      action: 'api_key.create', target: keyId, ok: true,
      message: `created ${name}`,
    });
    const { keyHash, ...safe } = record;
    res.status(201).json({ ok: true, data: { ...safe, key } });
  });

  r.delete('/:keyId', (req, res) => {
    const keyId = req.params.keyId;
    const existing = (store.getAll('apiKeys') as ApiKeyRecord[]).find(k => k.keyId === keyId);
    if (!existing) return res.status(404).json({ ok: false, error: 'API Key 不存在' });
    const now = new Date().toISOString();
    store.update('apiKeys', existing.id, { revokedAt: now });
    const actor = (req as any).authActor;
    audit(store, {
      actorType: actor?.type || 'session', actorId: actor?.id || actor?.user,
      action: 'api_key.revoke', target: keyId, ok: true,
    });
    res.json({ ok: true, data: { keyId, revokedAt: now } });
  });

  return r;
}

export function audit(store: Store, input: Omit<AuthAuditLog, 'id' | 'createdAt'>) {
  const log: AuthAuditLog = { id: uuid(), createdAt: new Date().toISOString(), ...input };
  store.insert('authAuditLogs', log);
}
