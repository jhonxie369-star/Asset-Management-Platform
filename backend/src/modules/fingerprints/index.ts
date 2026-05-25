import { v4 as uuid } from 'uuid';
import type { FingerprintRule } from '@sasp/shared';
import { databaseRules } from './rules/databases.js';
import { middlewareRules } from './rules/middleware.js';
import { devopsRules } from './rules/devops.js';
import { webappRules } from './rules/webapps.js';

/**
 * 内置指纹规则种子。按分类组织，便于后续沉淀。
 * 启动时 seed 到 store.fingerprintRules，幂等 upsert。
 */
export function getBuiltinFingerprintRules(): FingerprintRule[] {
  const all = [...databaseRules, ...middlewareRules, ...devopsRules, ...webappRules];
  return all.map(r => ({
    ...r,
    id: `builtin:${r.category || 'other'}:${r.product}:${r.name}`.replace(/\s+/g, '_').toLowerCase(),
    enabled: true,
    source: 'builtin' as const,
    matchMode: r.matchMode || 'any',
    priority: r.priority ?? 3,
  }));
}
