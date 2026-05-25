import { v4 as uuid } from 'uuid';
import type { Result, LiveEndpoint, Service, WebPath, Finding, FindingSeverity } from '@sasp/shared';
import { Store } from '../storage/store.js';
import { WebPathRiskEngine } from './web-path-risk.js';

/**
 * Enrichment Pipeline: Result → Dedup → Correlate → Enrich → Evaluate → Dispatch
 *
 * 负责把模块产出的 Result 归集到当前态表：
 *   endpoint_alive     → LiveEndpoint 表 (upsert by ip+port)
 *   service_identified → Service 表 (upsert by endpointId)
 *   web_path           → WebPath 表
 *   finding            → Finding 表
 */
export class EnrichmentPipeline {
  private webPathRisk: WebPathRiskEngine;

  constructor(private store: Store) {
    this.webPathRisk = new WebPathRiskEngine(store);
  }

  async process(result: Result): Promise<void> {
    this.store.insert('results', result);

    switch (result.resultType) {
      case 'endpoint_alive':
        this.handleEndpointAlive(result);
        break;
      case 'service_identified':
        this.handleServiceIdentified(result);
        break;
      case 'web_path':
        this.handleWebPath(result);
        break;
      case 'finding':
        this.handleFinding(result);
        break;
      case 'change':
        this.handleChange(result);
        break;
      default:
        break; // log/error 只存 Result
    }
  }

  private handleEndpointAlive(result: Result) {
    const d = result.data as any;
    const now = new Date().toISOString();
    const host = d.host || d.ip;
    const existing = this.store.query('liveEndpoints', (ep: any) =>
      (ep.host || ep.ip) === host && ep.port === d.port
    )[0] as LiveEndpoint | undefined;

    let endpointId: string;
    if (existing) {
      this.store.update('liveEndpoints', existing.id, {
        alive: true,
        host,
        resolvedIp: d.resolvedIp ?? existing.resolvedIp,
        resolvedIps: d.resolvedIps ?? existing.resolvedIps,
        banner: d.banner ?? existing.banner,
        lastSeenAt: now,
        disappearedAt: undefined,
      });
      endpointId = existing.id;
    } else {
      const ep: LiveEndpoint = {
        id: uuid(),
        assetId: result.assetId || '',
        ip: d.ip || host,
        host,
        resolvedIp: d.resolvedIp,
        resolvedIps: d.resolvedIps,
        port: d.port,
        alive: true,
        banner: d.banner,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.store.insert('liveEndpoints', ep);
      endpointId = ep.id;

      // 新活端点 Finding
      this.emitFinding({
        assetId: result.assetId || '',
        endpointId,
        type: 'new_endpoint',
        severity: 'info',
        title: `新发现活端点 ${host}:${d.port}`,
        dedupeKey: `new_endpoint:${host}:${d.port}`,
      });
    }

    // 把 endpointId 回写给 Result（便于下游查找）
    result.endpointId = endpointId;
    this.store.update('results', result.id, { endpointId });

    if (result.assetId && (d.resolvedIps || d.resolvedIp)) {
      this.store.update('assets', result.assetId, {
        resolvedIps: d.resolvedIps || (d.resolvedIp ? [d.resolvedIp] : undefined),
        lastResolvedAt: now,
        updatedAt: now,
      });
    }

    // RDS/domain endpoint probe 会在 endpoint_alive 中带协议/产品，直接沉淀 Service。
    if (d.protocol || d.product || d.title) {
      this.handleServiceIdentified({
        ...result,
        endpointId,
        resultType: 'service_identified',
        data: {
          protocol: d.protocol,
          product: d.product,
          version: d.version,
          title: d.title,
          banner: d.banner,
          fingerprint: d.fingerprint,
        },
      });
    }
  }

  private handleServiceIdentified(result: Result) {
    const d = result.data as any;
    const now = new Date().toISOString();
    const endpointId = result.endpointId || d.endpointId;
    if (!endpointId) return;

    const ep = this.store.getById('liveEndpoints', endpointId) as LiveEndpoint | undefined;
    if (!ep) return;

    const existing = this.store.query('services', (s: any) => s.endpointId === endpointId)[0] as Service | undefined;

    if (existing) {
      const replace = !!d.replaceFingerprints;
      const nextFps = replace
        ? (Array.isArray(d.fingerprints) ? d.fingerprints : (d.fingerprint ? [d.fingerprint] : []))
        : [...(existing.fingerprints || [])];
      if (!replace && d.fingerprint) {
        const exists = nextFps.find((f: any) => f.name === d.fingerprint.name);
        if (!exists) nextFps.push(d.fingerprint);
      }
      const patch: Partial<Service> = {
        protocol: d.protocol || existing.protocol,
        fingerprints: nextFps,
        lastSeenAt: now,
      };
      if (replace) {
        patch.product = d.product;
        patch.version = d.version;
        patch.title = d.title;
      } else {
        patch.product = d.product ?? existing.product;
        patch.version = d.version ?? existing.version;
        patch.title = d.title ?? existing.title;
      }
      this.store.update('services', existing.id, patch);
    } else {
      const fps = Array.isArray(d.fingerprints) ? d.fingerprints : (d.fingerprint ? [d.fingerprint] : []);
      const svc: Service = {
        id: uuid(),
        endpointId,
        assetId: ep.assetId,
        ip: ep.ip,
        host: ep.host,
        resolvedIp: ep.resolvedIp,
        resolvedIps: ep.resolvedIps,
        port: ep.port,
        protocol: d.protocol || 'tcp',
        product: d.product,
        version: d.version,
        title: d.title,
        fingerprints: fps,
        riskScore: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.store.insert('services', svc);

      // 新服务 Finding
      this.emitFinding({
        assetId: ep.assetId,
        endpointId,
        serviceId: svc.id,
        type: 'new_service',
        severity: 'info',
        title: `识别服务 ${ep.ip}:${ep.port} (${svc.protocol}${svc.product ? ' / ' + svc.product : ''})`,
        dedupeKey: `new_service:${ep.ip}:${ep.port}`,
      });
    }
  }

  private handleWebPath(result: Result) {
    const d = result.data as any;
    const now = new Date().toISOString();
    const existing = this.store.query('webPaths', (wp: any) =>
      wp.serviceId === result.serviceId && wp.path === d.path
    )[0] as WebPath | undefined;

    let saved: WebPath;
    if (existing) {
      const patch = {
        lastSeenAt: now,
        disappearedAt: undefined,
        statusCode: d.statusCode,
        title: d.title ?? existing.title,
        contentLength: d.contentLength ?? existing.contentLength,
        contentType: d.contentType ?? existing.contentType,
        location: d.location ?? existing.location,
        bodyPreview: d.bodyPreview ?? existing.bodyPreview,
        verified: d.verified ?? existing.verified,
        verifyReasons: d.verifyReasons ?? existing.verifyReasons,
        tags: d.tags ?? existing.tags,
      };
      this.store.update('webPaths', existing.id, patch);
      saved = { ...existing, ...patch };
    } else {
      const wp: WebPath = {
        id: uuid(),
        serviceId: result.serviceId || '',
        url: d.url || '',
        path: d.path,
        statusCode: d.statusCode || 200,
        title: d.title,
        contentLength: d.contentLength,
        contentType: d.contentType,
        location: d.location,
        bodyPreview: d.bodyPreview,
        verified: d.verified,
        verifyReasons: d.verifyReasons,
        source: result.moduleId,
        tags: d.tags || [],
        usefulForAI: d.usefulForAI ?? this.isUsefulPath(d.path),
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.store.insert('webPaths', wp);
      saved = wp;
    }
    this.webPathRisk.evaluateAndEmit(saved, params => this.emitFinding(params));
  }

  private handleFinding(result: Result) {
    const d = result.data as any;
    this.emitFinding({
      assetId: result.assetId || '',
      endpointId: result.endpointId,
      serviceId: result.serviceId,
      type: d.type || 'exposure',
      severity: d.severity || 'medium',
      title: d.title || 'Unknown finding',
      description: d.description,
      evidence: d.evidence || result.evidence,
      recommendation: d.recommendation,
      credentials: d.credentials,
      dedupeKey: d.dedupeKey || `${d.type}:${result.serviceId || result.endpointId}:${d.title}`,
    });
  }

  private handleChange(result: Result) {
    const d = result.data as any;
    this.emitFinding({
      assetId: result.assetId || '',
      endpointId: result.endpointId,
      serviceId: result.serviceId,
      type: d.changeType || 'fingerprint_change',
      severity: 'low',
      title: d.title || 'Change detected',
      evidence: d.evidence,
      dedupeKey: d.dedupeKey || `change:${result.serviceId || result.endpointId}:${d.changeType}`,
    });
  }

  private emitFinding(params: {
    assetId: string; endpointId?: string; serviceId?: string; webPathId?: string;
    type: any; severity: FindingSeverity; title: string;
    description?: string; evidence?: string; recommendation?: string; dedupeKey: string;
    credentials?: { username?: string; password?: string; passwordMasked?: string; passwordEmpty?: boolean };
  }) {
    const now = new Date().toISOString();
    const existing = this.store.query('findings', (f: any) => f.dedupeKey === params.dedupeKey)[0] as Finding | undefined;

    if (existing) {
      this.store.update('findings', existing.id, {
        lastSeenAt: now,
        credentials: params.credentials ?? (existing as any).credentials,
      } as any);
    } else {
      const finding: Finding = {
        id: uuid(),
        assetId: params.assetId,
        endpointId: params.endpointId,
        serviceId: params.serviceId,
        webPathId: params.webPathId,
        type: params.type,
        severity: params.severity,
        status: 'open',
        title: params.title,
        description: params.description,
        evidence: params.evidence,
        recommendation: params.recommendation,
        credentials: params.credentials,
        dedupeKey: params.dedupeKey,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.store.insert('findings', finding);
    }
  }

  private isUsefulPath(path: string): boolean {
    const keywords = ['admin', 'login', 'api', 'console', 'manage', 'dashboard', 'config', 'debug', 'swagger', 'phpmyadmin'];
    const lower = path.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }
}
