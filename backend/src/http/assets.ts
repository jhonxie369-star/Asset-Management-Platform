import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Asset } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { parsePageParams } from './paginate.js';

export function assetRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const q = ((req.query.q as string) || '').trim().toLowerCase();
    const zone = (req.query.zone as string) || '';
    const status = (req.query.status as string) || '';
    const params = parsePageParams(req.query, { defaultSort: 'lastSeenAt:desc' });
    const paged = store.assetPage(params, { q, zone, status });
    res.json({ ok: true, ...paged });
  });

  r.get('/:id', (req, res) => {
    const asset = store.getById('assets', req.params.id);
    if (!asset) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: asset });
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const asset: Asset = {
      id: uuid(),
      ip: req.body.ip,
      hostname: req.body.hostname,
      zone: req.body.zone || 'private',
      status: req.body.status || 'discovered',
      owner: req.body.owner,
      business: req.body.business,
      tags: req.body.tags || [],
      source: req.body.source || 'manual',
      riskScore: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
    };
    store.insert('assets', asset);
    res.status(201).json({ ok: true, data: asset });
  });

  r.put('/:id', (req, res) => {
    const existing = store.getById('assets', req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    store.update('assets', req.params.id, { ...req.body, updatedAt: new Date().toISOString() });
    res.json({ ok: true, data: store.getById('assets', req.params.id) });
  });

  r.delete('/:id', (req, res) => {
    store.delete('assets', req.params.id);
    res.json({ ok: true });
  });

  // 批量导入
  r.post('/import', (req, res) => {
    const items: any[] = req.body.assets || [];
    const now = new Date().toISOString();
    const created: Asset[] = [];
    for (const item of items) {
      const asset: Asset = {
        id: uuid(),
        ip: item.ip,
        hostname: item.hostname,
        zone: item.zone || 'private',
        status: 'discovered',
        owner: item.owner,
        business: item.business,
        tags: item.tags || [],
        source: 'imported',
        riskScore: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      };
      store.insert('assets', asset);
      created.push(asset);
    }
    res.status(201).json({ ok: true, data: created, total: created.length });
  });

  return r;
}
