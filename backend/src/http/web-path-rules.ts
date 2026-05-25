import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { WebPathRule } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { emitWebPathFinding, WebPathRiskEngine } from '../pipeline/web-path-risk.js';

export function webPathRuleRoutes(store: Store): Router {
  const r = Router();
  const engine = new WebPathRiskEngine(store);

  r.get('/', (req, res) => {
    engine.ensureDefaultRules();
    const rules = store.getAll('webPathRules') as WebPathRule[];
    res.json({ ok: true, data: rules, total: rules.length });
  });

  r.post('/', (req, res) => {
    const now = new Date().toISOString();
    const body = req.body || {};
    const rule: WebPathRule = {
      id: body.id || uuid(),
      name: body.name || '未命名 Web路径规则',
      enabled: body.enabled !== false,
      builtin: false,
      type: body.type === 'exposure' ? 'exposure' : 'sensitive_path',
      severity: body.severity || 'medium',
      category: body.category || 'other',
      match: body.match || {},
      description: body.description,
      recommendation: body.recommendation,
      createdAt: now,
      updatedAt: now,
    };
    store.insert('webPathRules', rule);
    res.status(201).json({ ok: true, data: rule });
  });

  r.put('/:id', (req, res) => {
    engine.ensureDefaultRules();
    const existing = store.getById('webPathRules', req.params.id) as WebPathRule | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: '规则不存在' });
    const body = req.body || {};
    const patch: Partial<WebPathRule> = {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      type: body.type ?? existing.type,
      severity: body.severity ?? existing.severity,
      category: body.category ?? existing.category,
      match: body.match ?? existing.match,
      description: body.description ?? existing.description,
      recommendation: body.recommendation ?? existing.recommendation,
      updatedAt: new Date().toISOString(),
    };
    store.update('webPathRules', req.params.id, patch);
    res.json({ ok: true, data: store.getById('webPathRules', req.params.id) });
  });

  r.delete('/:id', (req, res) => {
    const existing = store.getById('webPathRules', req.params.id) as WebPathRule | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: '规则不存在' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: '内置规则不可删除，可以禁用' });
    store.delete('webPathRules', req.params.id);
    res.json({ ok: true });
  });

  r.post('/reevaluate', (req, res) => {
    const summary = engine.reevaluateAll(params => emitWebPathFinding(store, params));
    res.json({ ok: true, data: summary });
  });

  return r;
}
