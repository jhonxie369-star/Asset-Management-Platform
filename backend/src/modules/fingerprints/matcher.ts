import type { FingerprintRule, FingerprintMatcher } from '@sasp/shared';
import type { ProbeSignals } from './probes.js';

interface CompiledMatcher {
  type: FingerprintMatcher['type'];
  field?: string;
  pattern: string;
  regex?: RegExp;
  versionGroup?: number;
}

interface CompiledRule {
  id: string;
  product: string;
  category?: string;
  priority: number;
  matchMode: 'any' | 'all';
  matchers: CompiledMatcher[];
  tags: string[];
  severity?: string;
}

const compileCache = new WeakMap<FingerprintRule, CompiledRule>();

function compile(rule: FingerprintRule): CompiledRule {
  const cached = compileCache.get(rule);
  if (cached) return cached;
  const compiled: CompiledRule = {
    id: rule.id,
    product: rule.product,
    category: rule.category,
    priority: rule.priority ?? 3,
    matchMode: rule.matchMode || 'any',
    tags: rule.tags,
    severity: rule.severity,
    matchers: rule.matchers.map(m => {
      const cm: CompiledMatcher = { ...m };
      if (m.type !== 'favicon') {
        try { cm.regex = new RegExp(m.pattern, m.flags || 'i'); } catch { /* bad regex, skip */ }
      }
      return cm;
    }),
  };
  compileCache.set(rule, compiled);
  return compiled;
}

/** 取信号对应字段的字符串 */
function getTarget(m: CompiledMatcher, sig: ProbeSignals): string | undefined {
  switch (m.type) {
    case 'banner': return sig.banner;
    case 'title': return sig.title;
    case 'body': return sig.body;
    case 'header':
      if (!sig.headers) return '';
      if (m.field) return sig.headers[m.field.toLowerCase()];
      return Object.entries(sig.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    case 'cert':
      return [sig.tlsSubject, sig.tlsIssuer, ...(sig.tlsSan || [])].filter(Boolean).join('\n');
    case 'favicon': return undefined;
  }
}

export interface MatchHit {
  ruleId: string;
  product: string;
  category?: string;
  version?: string;
  tags: string[];
  confidence: number;
  matcherType: string;
  severity?: string;
}

/** 单规则匹配，返回 hit 或 null */
export function matchRule(rule: FingerprintRule, sig: ProbeSignals): MatchHit | null {
  const c = compile(rule);
  let anyHit = false;
  let version: string | undefined;
  let matchedType = '';

  for (const m of c.matchers) {
    let hit = false;
    if (m.type === 'favicon') {
      hit = !!sig.faviconHash && String(sig.faviconHash) === m.pattern;
    } else {
      const target = getTarget(m, sig);
      if (!target || !m.regex) {
        hit = false;
      } else {
        const r = m.regex.exec(target);
        if (r) {
          hit = true;
          if (m.versionGroup && r[m.versionGroup]) version = r[m.versionGroup];
        }
      }
    }
    if (hit) {
      anyHit = true;
      matchedType = m.type;
      if (c.matchMode === 'any') break;
    } else if (c.matchMode === 'all') {
      return null;
    }
  }

  if (!anyHit) return null;
  return {
    ruleId: c.id,
    product: c.product,
    category: c.category,
    version,
    tags: c.tags,
    confidence: matchedType === 'favicon' ? 0.95 : matchedType === 'banner' || matchedType === 'header' ? 0.9 : 0.8,
    matcherType: matchedType,
    severity: c.severity,
  };
}

/** 按 priority 分桶 */
export function bucketByPriority(rules: FingerprintRule[]): Map<number, FingerprintRule[]> {
  const m = new Map<number, FingerprintRule[]>();
  for (const r of rules) {
    const p = r.priority ?? 3;
    if (!m.has(p)) m.set(p, []);
    m.get(p)!.push(r);
  }
  return m;
}

/** 整体匹配，返回所有命中 */
export function matchAll(rules: FingerprintRule[], sig: ProbeSignals): MatchHit[] {
  const hits: MatchHit[] = [];
  const ordered = [...rules].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
  for (const rule of ordered) {
    const h = matchRule(rule, sig);
    if (h) hits.push(h);
  }
  return hits;
}
