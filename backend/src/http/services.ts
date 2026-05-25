import { Router } from 'express';
import { Store } from '../storage/store.js';
import { parsePageParams } from './paginate.js';

export function serviceRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const q = ((req.query.q as string) || '').trim().toLowerCase();
    const assetId = (req.query.assetId as string) || '';
    const protocol = (req.query.protocol as string) || '';
    const product = (req.query.product as string) || '';
    const instance = ((req.query.instance as string) || '').trim().toLowerCase();
    const params = parsePageParams(req.query, { defaultSort: 'lastSeenAt:desc' });
    const paged = store.servicePage(params, { q, assetId, protocol, product, instance });
    res.json({ ok: true, ...paged });
  });

  r.get('/:id', (req, res) => {
    const svc = store.getById('services', req.params.id);
    if (!svc) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: svc });
  });

  return r;
}
