import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { PortList } from '@sasp/shared';
import { Store } from '../storage/store.js';

export function parsePorts(input: string): number[] {
  const result = new Set<number>();
  const parts = input.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [_, from, to] = rangeMatch;
      const f = Math.max(1, parseInt(from));
      const t = Math.min(65535, parseInt(to));
      for (let p = f; p <= t; p++) result.add(p);
    } else {
      const n = parseInt(part);
      if (n > 0 && n < 65536) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

export function portListRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const lists = store.getAll('portLists') as PortList[];
    res.json({ ok: true, data: lists, total: lists.length });
  });

  r.get('/:id', (req, res) => {
    const list = store.getById('portLists', req.params.id);
    if (!list) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, data: list });
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const ports = Array.isArray(req.body.ports) ? req.body.ports : parsePorts(req.body.portsText || '');
    if (ports.length === 0) return res.status(400).json({ ok: false, error: '端口列表不能为空' });
    const list: PortList = {
      id: uuid(),
      name: req.body.name || 'Unnamed',
      description: req.body.description,
      ports,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    store.insert('portLists', list);
    res.status(201).json({ ok: true, data: list });
  });

  r.put('/:id', (req, res) => {
    const existing = store.getById('portLists', req.params.id) as PortList | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: '内置端口列表不可修改' });
    const ports = Array.isArray(req.body.ports) ? req.body.ports : parsePorts(req.body.portsText || '');
    store.update('portLists', req.params.id, {
      name: req.body.name ?? existing.name,
      description: req.body.description ?? existing.description,
      ports: ports.length > 0 ? ports : existing.ports,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true, data: store.getById('portLists', req.params.id) });
  });

  r.delete('/:id', (req, res) => {
    const existing = store.getById('portLists', req.params.id) as PortList | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: '内置端口列表不可删除' });
    store.delete('portLists', req.params.id);
    res.json({ ok: true });
  });

  return r;
}
