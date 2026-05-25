import type { LiveEndpoint, Service } from '@sasp/shared';
import { AUTH_TESTERS } from './registry.js';
import type { AuthProfile, AuthTarget } from './types.js';

export function resolveAuthTargets(
  endpoints: LiveEndpoint[],
  services: Service[],
  profiles: AuthProfile[],
): AuthTarget[] {
  const svcByEndpoint = new Map<string, Service>();
  for (const s of services) svcByEndpoint.set(s.endpointId, s);

  const out: AuthTarget[] = [];
  const dedup = new Set<string>();

  for (const ep of endpoints) {
    if (!ep.alive || ep.disappearedAt) continue;
    const svc = svcByEndpoint.get(ep.id);
    const product = svc?.product?.trim().toLowerCase();
    const protocol = svc?.protocol?.trim().toLowerCase();

    const candidates: AuthTarget[] = [];
    for (const profile of profiles) {
      if (!profile.enabled) continue;
      const tester = AUTH_TESTERS[profile.name];
      if (!tester) continue;

      const products = (profile.fingerprintProducts || tester.fingerprintProducts).map(p => p.toLowerCase());
      const productHit = !!product && products.some(p => p === product || product.includes(p));
      const protocolHit = !!protocol && tester.protocols.includes(protocol);
      const portHit = (profile.ports || tester.defaultPorts).includes(ep.port);

      // 如果已有明确服务指纹/协议，则它可以否决同端口误判，避免 21/3306 上的非目标服务被测。
      if ((product || protocol) && !productHit && !protocolHit) continue;
      if (!portHit && !productHit && !protocolHit) continue;

      const key = `${ep.id}:${profile.name}`;
      if (dedup.has(key)) continue;
      dedup.add(key);

      candidates.push({
        endpoint: ep,
        service: svc,
        profile,
        tester,
        matchedBy: (portHit && (productHit || protocolHit)) ? 'both' : productHit ? 'fingerprint' : protocolHit ? 'protocol' : 'port',
      });
    }

    for (const selected of selectAuthTargets(candidates, product, protocol)) {
      selected.selectionReason = selected.selectionReason || 'selected';
      out.push(selected);
    }
  }
  return out;
}

function selectAuthTargets(candidates: AuthTarget[], product?: string, protocol?: string): AuthTarget[] {
  const byGroup = new Map<string, AuthTarget[]>();
  for (const target of candidates) {
    const group = testerGroup(target.tester.id);
    const arr = byGroup.get(group) || [];
    arr.push(target);
    byGroup.set(group, arr);
  }

  const selected: AuthTarget[] = [];
  for (const [group, targets] of byGroup) {
    if (targets.length === 1 || group === 'ftp') {
      selected.push(...targets.map(t => ({ ...t, selectionReason: 'single-candidate' })));
      continue;
    }
    const best = [...targets].sort((a, b) =>
      targetScore(b, product, protocol) - targetScore(a, product, protocol)
        || testerPriority(b.tester.id) - testerPriority(a.tester.id)
        || a.tester.id.localeCompare(b.tester.id)
    )[0];
    selected.push({
      ...best,
      selectionReason: `selected-from-${group}:${targets.map(t => t.tester.id).join(',')}`,
    });
  }
  return selected;
}

function testerGroup(id: string): string {
  if (['mysql', 'mariadb', 'polardb', 'adb', 'starrocks', 'tidb', 'oceanbase', 'doris'].includes(id)) return 'mysql-family';
  return id;
}

function targetScore(target: AuthTarget, product?: string, protocol?: string): number {
  let score = 0;
  const products = (target.profile.fingerprintProducts || target.tester.fingerprintProducts).map(p => p.toLowerCase());
  const exactProduct = !!product && products.some(p => p === product);
  const fuzzyProduct = !!product && products.some(p => p !== product && product.includes(p));
  if (exactProduct) score += 100;
  else if (fuzzyProduct) score += 80;
  if (protocol && target.tester.protocols.includes(protocol)) score += 30;
  if ((target.profile.ports || target.tester.defaultPorts).includes(target.endpoint.port)) score += 10;
  return score;
}

function testerPriority(id: string): number {
  const priorities: Record<string, number> = {
    mysql: 100, mariadb: 95, polardb: 90, adb: 80, starrocks: 70, tidb: 68, oceanbase: 66, doris: 64,
  };
  return priorities[id] || 0;
}
