import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { FingerprintMatcher, FingerprintRule } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { getBuiltinFingerprintRules } from '../modules/fingerprints/index.js';

const CATEGORIES = new Set(['database', 'middleware', 'webserver', 'cms', 'framework', 'devops', 'monitoring', 'other']);
const MATCHER_TYPES = new Set(['banner', 'header', 'body', 'title', 'favicon', 'cert']);

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

function validateMatchers(value: unknown): FingerprintMatcher[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('matchers 至少需要 1 条');
  return value.map((raw, index) => {
    const m = raw as Partial<FingerprintMatcher>;
    if (!MATCHER_TYPES.has(String(m.type))) throw new Error(`matchers[${index}].type 无效`);
    if (!m.pattern) throw new Error(`matchers[${index}].pattern 必填`);
    if (m.type !== 'favicon') {
      try { new RegExp(String(m.pattern), String(m.flags || 'i')); } catch (err: any) {
        throw new Error(`matchers[${index}].pattern 正则无效: ${err.message}`);
      }
    }
    return {
      type: m.type as FingerprintMatcher['type'],
      field: m.field ? String(m.field) : undefined,
      pattern: String(m.pattern),
      flags: m.flags ? String(m.flags) : undefined,
      versionGroup: m.versionGroup ? Number(m.versionGroup) : undefined,
    };
  });
}

function normalizeRuleBody(body: any, existing?: FingerprintRule): FingerprintRule {
  const now = new Date().toISOString();
  const category = body.category || existing?.category || 'other';
  if (category && !CATEGORIES.has(category)) throw new Error('category 无效');
  const matchMode = body.matchMode || existing?.matchMode || 'any';
  if (matchMode !== 'any' && matchMode !== 'all') throw new Error('matchMode 只能是 any/all');
  const priority = Number(body.priority ?? existing?.priority ?? 3);
  if (!Number.isFinite(priority) || priority < 0 || priority > 10) throw new Error('priority 需要在 0-10 之间');

  return {
    id: existing?.id || `user:fingerprint:${uuid()}`,
    name: String(body.name ?? existing?.name ?? '').trim(),
    product: String(body.product ?? existing?.product ?? '').trim(),
    category,
    matchers: validateMatchers(body.matchers ?? existing?.matchers),
    matchMode,
    priority,
    severity: body.severity ?? existing?.severity,
    tags: splitList(body.tags ?? existing?.tags),
    enabled: Boolean(body.enabled ?? existing?.enabled ?? true),
    source: existing?.source || 'user',
  };
}

function searchableText(rule: FingerprintRule): string {
  return [
    rule.id, rule.name, rule.product, rule.category, rule.source,
    rule.matchMode, rule.priority, rule.severity, ...(rule.tags || []),
    ...(rule.matchers || []).flatMap(m => [m.type, m.field, m.pattern, m.flags]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function stats(rules: FingerprintRule[]) {
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byMatcherType: Record<string, number> = {};
  let enabled = 0;
  for (const rule of rules) {
    if (rule.enabled) enabled++;
    byCategory[rule.category || 'other'] = (byCategory[rule.category || 'other'] || 0) + 1;
    bySource[rule.source || 'user'] = (bySource[rule.source || 'user'] || 0) + 1;
    for (const matcher of rule.matchers || []) {
      byMatcherType[matcher.type] = (byMatcherType[matcher.type] || 0) + 1;
    }
  }
  return { total: rules.length, enabled, disabled: rules.length - enabled, byCategory, bySource, byMatcherType };
}

export function fingerprintRuleRoutes(store: Store): Router {
  const r = Router();

  r.get('/', (req, res) => {
    let rules = store.getAll('fingerprintRules') as FingerprintRule[];
    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '');
    const source = String(req.query.source || '');
    const enabled = String(req.query.enabled || '');
    const matcherType = String(req.query.matcherType || '');

    if (q) rules = rules.filter(rule => searchableText(rule).includes(q));
    if (category) rules = rules.filter(rule => (rule.category || 'other') === category);
    if (source) rules = rules.filter(rule => (rule.source || 'user') === source);
    if (enabled === 'true' || enabled === 'false') rules = rules.filter(rule => String(!!rule.enabled) === enabled);
    if (matcherType) rules = rules.filter(rule => rule.matchers?.some(m => m.type === matcherType));

    rules.sort((a, b) =>
      (a.category || '').localeCompare(b.category || '')
      || (a.product || '').localeCompare(b.product || '')
      || (a.priority ?? 3) - (b.priority ?? 3)
      || a.name.localeCompare(b.name)
    );
    res.json({ ok: true, data: rules, total: rules.length, stats: stats(rules) });
  });

  r.get('/stats', (_req, res) => {
    const rules = store.getAll('fingerprintRules') as FingerprintRule[];
    res.json({ ok: true, data: stats(rules) });
  });

  r.post('/reset-builtin', (_req, res) => {
    let count = 0;
    for (const rule of getBuiltinFingerprintRules()) {
      const existing = store.getById('fingerprintRules', rule.id) as FingerprintRule | undefined;
      store.upsert('fingerprintRules', { ...rule, enabled: existing?.enabled ?? rule.enabled });
      count++;
    }
    res.json({ ok: true, data: { restored: count } });
  });

  r.get('/:id', (req, res) => {
    const rule = store.getById('fingerprintRules', req.params.id) as FingerprintRule | undefined;
    if (!rule) return res.status(404).json({ ok: false, error: '规则不存在' });
    res.json({ ok: true, data: rule });
  });

  r.post('/', (req, res) => {
    try {
      const rule = normalizeRuleBody(req.body);
      if (!rule.name || !rule.product) return res.status(400).json({ ok: false, error: 'name/product 必填' });
      store.insert('fingerprintRules', rule);
      res.status(201).json({ ok: true, data: rule });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || '规则无效' });
    }
  });

  r.put('/:id', (req, res) => {
    const existing = store.getById('fingerprintRules', req.params.id) as FingerprintRule | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: '规则不存在' });
    try {
      if (existing.source === 'builtin') {
        const patch: Partial<FingerprintRule> = {};
        if (req.body.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
        if (req.body.tags !== undefined) patch.tags = splitList(req.body.tags);
        store.update('fingerprintRules', req.params.id, patch);
        return res.json({ ok: true, data: store.getById('fingerprintRules', req.params.id) });
      }
      const next = normalizeRuleBody(req.body, existing);
      if (!next.name || !next.product) return res.status(400).json({ ok: false, error: 'name/product 必填' });
      store.update('fingerprintRules', req.params.id, next);
      res.json({ ok: true, data: store.getById('fingerprintRules', req.params.id) });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || '规则无效' });
    }
  });

  r.delete('/:id', (req, res) => {
    const existing = store.getById('fingerprintRules', req.params.id) as FingerprintRule | undefined;
    if (!existing) return res.status(404).json({ ok: false, error: '规则不存在' });
    if (existing.source === 'builtin') return res.status(403).json({ ok: false, error: '内置规则不可删除，可禁用' });
    store.delete('fingerprintRules', req.params.id);
    res.json({ ok: true });
  });

  return r;
}
