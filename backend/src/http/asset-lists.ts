import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { AssetList, AssetListEntry, ServiceProtocol } from '@sasp/shared';
import { Store } from '../storage/store.js';

function guessProtocol(port?: number): ServiceProtocol | undefined {
  if (!port) return undefined;
  if ([3306, 3307, 3308, 33060].includes(port)) return 'mysql';
  if ([5432, 5433].includes(port)) return 'postgres';
  if ([6379, 6380, 16379].includes(port)) return 'redis';
  if ([27017, 27018, 27019].includes(port)) return 'mongodb';
  if ([9200, 9201].includes(port)) return 'elasticsearch';
  return undefined;
}

function normalizeProtocol(value?: string): ServiceProtocol | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'pgsql' || v === 'postgresql') return 'postgres';
  if (v === 'mongo') return 'mongodb';
  if ([
    'http', 'https', 'ssh', 'ftp', 'tcp', 'unknown',
    'mysql', 'redis', 'postgres', 'mongodb',
    'cassandra', 'aerospike', 'hbase', 'clickhouse', 'elasticsearch',
  ].includes(v)) return v as ServiceProtocol;
  return undefined;
}

function parseHostPort(s: string): AssetListEntry | undefined {
  const m = s.match(/^([a-zA-Z0-9_.-]+):(\d{1,5})(?::([a-zA-Z0-9_-]+))?$/);
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return undefined;
  const protocol = normalizeProtocol(m[3]) || guessProtocol(port);
  const host = m[1];
  return {
    ip: host,
    address: host,
    hostname: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host,
    assetKind: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'ip' : 'db_endpoint',
    endpointPort: port,
    endpointProtocol: protocol,
    cloudProduct: protocol && ['mysql', 'postgres', 'redis', 'mongodb'].includes(protocol) ? protocol as any : 'other',
    source: 'manual',
  };
}

function entryObj(e: string | AssetListEntry): AssetListEntry {
  return typeof e === 'string' ? { ip: e, address: e, assetKind: 'ip', source: 'manual' } : e;
}

function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeFilename(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'asset-list';
}

function exportRows(list: AssetList): unknown[][] {
  return (list.entries || []).map(raw => {
    const e = entryObj(raw);
    return [
      e.ip,
      e.address || e.ip,
      e.assetKind || '',
      e.scope || '',
      e.endpointPort || '',
      e.endpointProtocol || '',
      e.cloudProduct || '',
      e.hostname || '',
      e.cloud || '',
      e.instanceRole || '',
      e.instanceName || '',
      e.instanceKey || '',
      e.source || '',
    ];
  });
}

export function parseAssetEntries(input: string): Array<string | AssetListEntry> {
  const set = new Map<string, string | AssetListEntry>();
  for (const line of input.split(/[\s,;\n]+/)) {
    const s = line.trim();
    if (!s) continue;
    const hp = parseHostPort(s);
    if (hp) {
      set.set(`${hp.ip}:${hp.endpointPort}`, hp);
      continue;
    }
    // CIDR 展开
    const cidr = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidr) {
      const [, baseIp, prefixStr] = cidr;
      const prefix = parseInt(prefixStr);
      if (prefix >= 8 && prefix <= 32) {
        const parts = baseIp.split('.').map(Number);
        const base = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
        const count = 2 ** (32 - prefix);
        if (count <= 65536) {
          const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
          const netBase = (base & mask) >>> 0;
          for (let i = 0; i < count; i++) {
            const ip = (netBase + i) >>> 0;
            const item = `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
            set.set(item, item);
          }
          continue;
        }
      }
    }
    // IP 范围 203.0.113.10-203.0.113.20
    const range = s.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/);
    if (range) {
      const toNum = (ip: string) => { const p = ip.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; };
      const toIp = (n: number) => `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
      const a = toNum(range[1]), b = toNum(range[2]);
      if (b - a <= 65536) {
        for (let i = a; i <= b; i++) {
          const item = toIp(i);
          set.set(item, item);
        }
        continue;
      }
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) set.set(s, s);
    else set.set(s, { ip: s, address: s, assetKind: 'domain', source: 'manual' });
  }
  return [...set.values()];
}

export function assetListRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const lists = store.getAll('assetLists') as AssetList[];
    res.json({ ok: true, data: lists, total: lists.length });
  });

  r.get('/:id', (req, res) => {
    const list = store.getById('assetLists', req.params.id);
    if (!list) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: list });
  });

  r.get('/:id/export', (req, res) => {
    const list = store.getById('assetLists', req.params.id) as AssetList | undefined;
    if (!list) return res.status(404).json({ ok: false, error: 'Not found' });
    const format = String(req.query.format || 'csv');
    const filename = `${safeFilename(list.name)}-${new Date().toISOString().slice(0, 10)}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename + '.json')}`);
      res.send(JSON.stringify(list, null, 2));
      return;
    }

    const headers = [
      'ip', 'address', 'assetKind', 'scope', 'endpointPort', 'endpointProtocol',
      'cloudProduct', 'hostname', 'cloud', 'instanceRole', 'instanceName', 'instanceKey', 'source',
    ];
    const csv = [headers.map(csvEscape).join(','), ...exportRows(list).map(row => row.map(csvEscape).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename + '.csv')}`);
    res.send('\ufeff' + csv);
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const entries = Array.isArray(req.body.entries) ? req.body.entries : parseAssetEntries(req.body.entriesText || '');
    if (entries.length === 0) return res.status(400).json({ ok: false, error: '资产列表不能为空' });
    const list: AssetList = {
      id: uuid(),
      name: req.body.name || 'Unnamed',
      description: req.body.description,
      entries,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    store.insert('assetLists', list);
    res.status(201).json({ ok: true, data: list });
  });

  r.put('/:id', (req, res) => {
    const existing = store.getById('assetLists', req.params.id) as AssetList | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: '内置资产列表不可修改' });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : parseAssetEntries(req.body.entriesText || '');
    const patch: any = {
      name: req.body.name ?? existing.name,
      description: req.body.description ?? existing.description,
      entries: entries.length > 0 ? entries : existing.entries,
      updatedAt: new Date().toISOString(),
    };
    if (req.body.autoSync !== undefined) patch.autoSync = req.body.autoSync || undefined;
    store.update('assetLists', req.params.id, patch);
    res.json({ ok: true, data: store.getById('assetLists', req.params.id) });
  });

  r.delete('/:id', (req, res) => {
    const existing = store.getById('assetLists', req.params.id) as AssetList | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: '内置资产列表不可删除' });
    store.delete('assetLists', req.params.id);
    res.json({ ok: true });
  });

  return r;
}
