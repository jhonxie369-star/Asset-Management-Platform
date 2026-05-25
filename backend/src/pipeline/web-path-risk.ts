import { v4 as uuid } from 'uuid';
import type { Finding, FindingSeverity, Service, WebPath, WebPathRule } from '@sasp/shared';
import { Store } from '../storage/store.js';

export type FindingEmitter = (params: {
  assetId: string;
  endpointId?: string;
  serviceId?: string;
  webPathId?: string;
  type: any;
  severity: FindingSeverity;
  title: string;
  description?: string;
  evidence?: string;
  recommendation?: string;
  dedupeKey: string;
}) => void;

export function emitWebPathFinding(store: Store, params: Parameters<FindingEmitter>[0]): void {
  const t = now();
  const existing = store.query('findings', (f: any) => f.dedupeKey === params.dedupeKey)[0] as Finding | undefined;
  if (existing) {
    store.update('findings', existing.id, {
      lastSeenAt: t,
      severity: params.severity,
      title: params.title,
      description: params.description,
      evidence: params.evidence,
      recommendation: params.recommendation,
      webPathId: params.webPathId,
    } as any);
    return;
  }
  store.insert('findings', {
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
    dedupeKey: params.dedupeKey,
    firstSeenAt: t,
    lastSeenAt: t,
  } as Finding);
}

const now = () => new Date().toISOString();

export const DEFAULT_WEB_PATH_RULES: WebPathRule[] = [
  {
    id: 'spring-actuator-env',
    name: 'Spring Actuator env 暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'critical',
    category: 'sensitive_leak',
    match: {
      pathRegex: '^/(?:actuator|management)/env$',
      statusCodes: [200],
      contentTypeIncludes: ['json'],
      bodyContainsAny: ['propertySources', 'activeProfiles'],
    },
    description: 'Actuator env 可能泄露环境变量、配置、数据库连接串、密钥等敏感信息。',
    recommendation: '关闭公网访问或加认证；仅允许管理网段访问，并禁用 env 等敏感端点。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'spring-actuator-heapdump',
    name: 'Spring Actuator heapdump 暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'critical',
    category: 'sensitive_leak',
    match: {
      pathRegex: '^/(?:actuator/)?heapdump$',
      statusCodes: [200],
      bodyContainsAny: ['JAVA PROFILE', 'HPROF'],
    },
    description: 'heapdump 可能包含内存中的 token、密码、连接串和业务数据。',
    recommendation: '立即禁止公网访问 heapdump，并检查是否已有敏感信息泄露。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'git-config-leak',
    name: '.git/config 泄露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'critical',
    category: 'sensitive_leak',
    match: {
      pathRegex: '/\\.git/config$',
      statusCodes: [200],
      bodyContainsAny: ['[core]', 'repositoryformatversion'],
    },
    description: 'Git 仓库配置暴露，通常意味着 .git 目录可被下载，存在源码泄露风险。',
    recommendation: '删除 Web 根目录中的 .git，或在 Web Server 层禁止访问隐藏目录。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'env-file-leak',
    name: '.env 配置文件泄露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'critical',
    category: 'sensitive_leak',
    match: {
      pathRegex: '/\\.env(?:\\.|$)',
      statusCodes: [200],
      bodyRegex: '(DB_|MYSQL_|REDIS_|SECRET|TOKEN|PASSWORD|ACCESS_KEY|AK|SK)[A-Z0-9_]*\\s*=',
    },
    description: '.env 配置文件可能泄露数据库密码、云密钥、Token 等敏感信息。',
    recommendation: '移除公网可访问的配置文件，轮换已泄露凭据。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'prometheus-pprof',
    name: 'Go pprof 敏感调试数据暴露',
    enabled: false,
    builtin: true,
    type: 'sensitive_path',
    severity: 'high',
    category: 'debug',
    match: {
      pathRegex: '^/debug/pprof/(?:heap|trace|profile)$',
      statusCodes: [200],
      bodyContainsAny: ['go 1.', 'heap profile'],
    },
    description: 'pprof heap/trace/profile 可能泄露运行时信息，并可造成性能压力。',
    recommendation: '关闭公网 pprof，仅允许内网诊断网段访问。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'prometheus-pprof-index',
    name: 'Go pprof 入口暴露',
    enabled: false,
    builtin: true,
    type: 'sensitive_path',
    severity: 'medium',
    category: 'debug',
    match: {
      pathRegex: '^/debug/pprof/?$',
      statusCodes: [200],
      bodyContainsAny: ['/debug/pprof/', 'profile-name'],
    },
    description: 'pprof 入口暴露会公开调试能力入口，heap/trace/profile 等子端点风险更高。',
    recommendation: '关闭公网 pprof，仅允许内网诊断网段访问。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'prometheus-metrics',
    name: 'Prometheus metrics 暴露',
    enabled: false,
    builtin: true,
    type: 'sensitive_path',
    severity: 'medium',
    category: 'metrics',
    match: {
      pathRegex: '^/(?:metrics|prometheus)$',
      statusCodes: [200],
      bodyContainsAny: ['# HELP', '# TYPE'],
    },
    description: 'metrics 可能泄露组件、版本、接口、主机名、业务指标等信息。',
    recommendation: '给 metrics 加认证或仅允许监控网段访问。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'swagger-openapi',
    name: 'Swagger/OpenAPI 文档暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'medium',
    category: 'api_doc',
    match: {
      pathRegex: '(swagger|api-docs|openapi)',
      statusCodes: [200],
      bodyContainsAny: ['"openapi"', '"swagger"', '"paths"'],
    },
    description: '接口文档暴露可能帮助攻击者枚举 API 和参数。',
    recommendation: '生产环境关闭或加认证；仅允许研发/测试网段访问。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'tomcat-manager',
    name: 'Tomcat Manager 入口暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'medium',
    category: 'admin_entry',
    match: {
      pathRegex: '^/manager/(?:html|jmxproxy|status)',
      statusCodes: [200, 401, 403],
      bodyContainsAny: ['Tomcat', '401 Unauthorized', 'manager'],
    },
    description: '管理入口暴露到公网，即使有认证也会增加弱口令和爆破风险。',
    recommendation: '限制访问来源；确认无默认口令/弱口令。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'spring-actuator-info',
    name: 'Spring Actuator 信息端点暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'medium',
    category: 'debug',
    match: {
      pathRegex: '^/(?:actuator|management)/(?:beans|configprops|mappings|conditions|loggers|scheduledtasks|threaddump)$',
      statusCodes: [200],
      bodyContainsAny: ['contexts', 'beans', 'mappings', 'levels', 'threadName'],
    },
    description: 'Actuator 信息端点会暴露应用结构、Bean、路由、线程等调试信息。',
    recommendation: '关闭公网访问或加认证，仅保留 health/info 等低敏端点。',
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'admin-login-entry',
    name: '管理/登录入口暴露',
    enabled: true,
    builtin: true,
    type: 'sensitive_path',
    severity: 'low',
    category: 'admin_entry',
    match: {
      pathRegex: '^/(?:admin|console|dashboard|login|wp-login|phpMyAdmin|pma)(?:/|\\.php|$)',
      statusCodes: [200, 301, 302, 401, 403],
    },
    description: '发现管理或登录入口。此类入口本身不等于漏洞，但需要纳入暴露面台账。',
    recommendation: '确认是否必须公网开放；必要时加访问控制和弱口令检查。',
    createdAt: now(),
    updatedAt: now(),
  },
];

export class WebPathRiskEngine {
  constructor(private store: Store) {}

  ensureDefaultRules(): void {
    const existing = this.store.getAll('webPathRules') as WebPathRule[];
    const existingIds = new Set(existing.map(r => r.id));
    for (const rule of DEFAULT_WEB_PATH_RULES) {
      if (existingIds.has(rule.id)) continue;
      const t = now();
      this.store.insert('webPathRules', { ...rule, createdAt: t, updatedAt: t });
    }
  }

  evaluateAndEmit(webPath: WebPath, emit: FindingEmitter): number {
    if (webPath.disappearedAt) return 0;
    this.ensureDefaultRules();
    const rules = (this.store.getAll('webPathRules') as WebPathRule[]).filter(r => r.enabled);
    const service = this.store.getById('services', webPath.serviceId) as Service | undefined;
    if (!service) return 0;
    let count = 0;
    for (const rule of rules) {
      if (!this.matches(rule, webPath)) continue;
      emit(this.toFinding(rule, webPath, service));
      count++;
    }
    return count;
  }

  reevaluateAll(emit: FindingEmitter): { scanned: number; emitted: number } {
    this.ensureDefaultRules();
    const paths = (this.store.getAll('webPaths') as WebPath[]).filter(p => !p.disappearedAt);
    let emitted = 0;
    for (const path of paths) emitted += this.evaluateAndEmit(path, emit);
    return { scanned: paths.length, emitted };
  }

  private matches(rule: WebPathRule, webPath: WebPath): boolean {
    const m = rule.match || {};
    const path = webPath.path || '';
    const body = webPath.bodyPreview || '';
    const title = webPath.title || '';
    const contentType = webPath.contentType || '';
    if (m.statusCodes?.length && !m.statusCodes.includes(webPath.statusCode)) return false;
    if (m.pathRegex && !safeRegexTest(m.pathRegex, path, 'i')) return false;
    if (m.pathContainsAny?.length && !containsAny(path, m.pathContainsAny)) return false;
    if (m.contentTypeIncludes?.length && !containsAny(contentType, m.contentTypeIncludes)) return false;
    if (m.titleContainsAny?.length && !containsAny(title, m.titleContainsAny)) return false;
    if (m.bodyContainsAny?.length && !containsAny(body, m.bodyContainsAny)) return false;
    if (m.bodyRegex && !safeRegexTest(m.bodyRegex, body, 'i')) return false;
    return true;
  }

  private toFinding(rule: WebPathRule, webPath: WebPath, service: Service): Parameters<FindingEmitter>[0] {
    const host = service.host || service.ip;
    const title = `${rule.name} ${host}:${service.port}${webPath.path}`;
    return {
      assetId: service.assetId,
      endpointId: service.endpointId,
      serviceId: service.id,
      webPathId: webPath.id,
      type: 'sensitive_path',
      severity: rule.severity,
      title,
      description: rule.description,
      recommendation: rule.recommendation,
      evidence: [
        `rule=${rule.id}`,
        `url=${webPath.url}`,
        `status=${webPath.statusCode}`,
        webPath.contentType ? `contentType=${webPath.contentType}` : undefined,
        webPath.title ? `title=${webPath.title}` : undefined,
        webPath.bodyPreview ? `preview=${webPath.bodyPreview.slice(0, 300)}` : undefined,
      ].filter(Boolean).join('\n'),
      dedupeKey: `web_path_rule:${rule.id}:${webPath.serviceId}:${webPath.path}`,
    };
  }
}

function containsAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some(n => lower.includes(String(n).toLowerCase()));
}

function safeRegexTest(pattern: string, value: string, flags = ''): boolean {
  try {
    return new RegExp(pattern, flags).test(value);
  } catch {
    return false;
  }
}
