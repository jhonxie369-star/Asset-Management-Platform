import { Router } from 'express';
import { Store } from '../storage/store.js';

export function aiRoutes(store: Store): Router {
  const r = Router();

  r.get('/context', (req, res) => {
    const q = String(req.query.asset || req.query.q || '').trim().toLowerCase();
    const assets = store.getAll('assets') as any[];
    const endpoints = store.getAll('liveEndpoints') as any[];
    const services = store.getAll('services') as any[];
    const webPaths = store.getAll('webPaths') as any[];
    const findings = store.getAll('findings') as any[];

    const matchedAssets = q
      ? assets.filter(a => [a.id, a.ip, a.address, a.hostname, a.instanceName].filter(Boolean).some(v => String(v).toLowerCase().includes(q))).slice(0, 20)
      : assets.slice(0, 20);
    const assetIds = new Set(matchedAssets.map(a => a.id));
    const eps = endpoints.filter(e => assetIds.has(e.assetId));
    const epIds = new Set(eps.map(e => e.id));
    const svcs = services.filter(s => assetIds.has(s.assetId) || epIds.has(s.endpointId));
    const svcIds = new Set(svcs.map(s => s.id));

    res.json({
      ok: true,
      data: {
        query: q || null,
        assets: matchedAssets,
        endpoints: eps,
        services: svcs,
        webPaths: webPaths.filter(w => svcIds.has(w.serviceId)).slice(0, 200),
        findings: findings.filter(f => assetIds.has(f.assetId) || (f.endpointId && epIds.has(f.endpointId)) || (f.serviceId && svcIds.has(f.serviceId))),
      },
    });
  });

  r.post('/query', (req, res) => {
    res.json({
      ok: true,
      data: {
        answer: 'AI query endpoint reserved. Use /api/ai/context for structured context in this version.',
        query: req.body?.query || '',
      },
    });
  });

  return r;
}
