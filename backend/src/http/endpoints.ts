import { Router } from 'express';
import { Store } from '../storage/store.js';
import type { LiveEndpoint, Service, WebPath } from '@sasp/shared';
import { parsePageParams } from './paginate.js';

function timeMs(value?: string): number {
  const n = value ? new Date(value).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

function isServiceCurrent(endpoint: LiveEndpoint, service?: Service, showGone = false): service is Service {
  if (!service) return false;
  if (showGone) return true;
  if (endpoint.disappearedAt || !endpoint.alive) return false;
  return timeMs(service.lastSeenAt) >= timeMs(endpoint.lastSeenAt);
}

function isWebPathCurrent(service: Service, path: WebPath, showGone = false): boolean {
  if (showGone) return true;
  if (path.disappearedAt) return false;
  return timeMs(path.lastSeenAt) >= timeMs(service.lastSeenAt);
}

function matchesWebPathQuery(path: WebPath, q: string): boolean {
  if (!q) return true;
  const text = [
    path.path,
    path.url,
    path.title,
    path.statusCode,
    path.contentType,
    path.bodyPreview,
    ...(path.tags || []),
  ].filter(v => v !== undefined && v !== null).join(' ').toLowerCase();
  return text.includes(q);
}

export function endpointRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const q = ((req.query.q as string) || '').trim().toLowerCase();
    const webPath = ((req.query.webPath as string) || '').trim().toLowerCase();
    const assetId = (req.query.assetId as string) || '';
    const protocol = (req.query.protocol as string) || '';
    const product = (req.query.product as string) || '';
    const scope = (req.query.scope as string) || '';
    const instance = ((req.query.instance as string) || '').trim().toLowerCase();
    const hasService = req.query.hasService === 'true';
    const hasWebPath = req.query.hasWebPath === 'true';
    const showGone = req.query.showGone === 'true';
    const withService = req.query.withService === 'true';

    const params = parsePageParams(req.query, { defaultSort: 'lastSeenAt:desc' });
    const paged = store.endpointPage(params, {
      q, assetId, protocol, product, scope, hasService, showGone, withService, explicitSort: !!req.query.sort,
      instance, webPath, hasWebPath,
    });

    if (withService) {
      const serviceIds = [...new Set(paged.data.map((row: any) => row.service?.id).filter(Boolean))];
      const serviceById = new Map<string, Service>(paged.data
        .map((row: any) => row.service)
        .filter(Boolean)
        .map((s: Service) => [s.id, s]));
      const paths = serviceIds.length > 0
        ? store.listBySql(
          'webPaths',
          [`json_extract(json, '$.serviceId') IN (${serviceIds.map(() => '?').join(',')})`],
          serviceIds,
          `json_extract(json, '$.lastSeenAt') DESC`,
        ) as WebPath[]
        : [];
      const pathsByService = new Map<string, WebPath[]>();
      for (const p of paths) {
        const service = serviceById.get(p.serviceId);
        if (!service) continue;
        if (!isWebPathCurrent(service, p, showGone)) continue;
        if (!matchesWebPathQuery(p, webPath)) continue;
        const arr = pathsByService.get(p.serviceId) || [];
        arr.push(p);
        pathsByService.set(p.serviceId, arr);
      }
      const out = paged.data.map((row: any) => {
        const e = row.endpoint as LiveEndpoint;
        const a = row.asset;
        const service = row.service as Service | undefined;
        return {
          ...e,
          service: service ? { ...service, webPaths: pathsByService.get(service.id) || [] } : undefined,
          instance: a?.instanceKey ? {
            key: a.instanceKey, role: a.instanceRole, cloud: a.cloud, name: a.instanceName,
          } : undefined,
          scope: a?.zone,
        };
      });
      return res.json({ ok: true, ...paged, data: out });
    }
    res.json({ ok: true, ...paged, data: paged.data.map((row: any) => row.endpoint) });
  });

  r.get('/facets', (req, res) => {
    const showGone = req.query.showGone === 'true';
    const eps = store.getAll('liveEndpoints') as LiveEndpoint[];
    const services = store.getAll('services') as Service[];
    const rawSvcByEp = new Map<string, Service>();
    for (const s of services) rawSvcByEp.set(s.endpointId, s);
    const protocols = new Set<string>();
    const products = new Set<string>();
    let alive = 0, gone = 0, withService = 0;
    for (const e of eps) {
      if (e.disappearedAt) gone++; else alive++;
      if (!showGone && e.disappearedAt) continue;
      const s = rawSvcByEp.get(e.id);
      if (!isServiceCurrent(e, s, showGone)) continue;
      if (!e.disappearedAt) withService++;
      if (s.protocol) protocols.add(s.protocol);
      if (s.product) products.add(s.product);
    }
    res.json({
      ok: true,
      data: {
        protocols: [...protocols].sort(),
        products: [...products].sort(),
        counts: { alive, gone, withService, productCount: products.size },
      },
    });
  });

  r.get('/:id', (req, res) => {
    const ep = store.getById('liveEndpoints', req.params.id);
    if (!ep) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: ep });
  });

  return r;
}
