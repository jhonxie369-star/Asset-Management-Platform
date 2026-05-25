import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import type { Result, ModuleDefinition, LiveEndpoint, Service } from '@sasp/shared';
import type { IModule, ModuleContext } from '../../engine/module-interface.js';
import { Store } from '../../storage/store.js';
import {
  DEFAULT_WORDLIST,
  DEFAULT_STATUS_CODES,
  DEFAULT_EXTENSIONS,
  DIRSEARCH_STATUS_PATH_BLACKLIST,
  DIRSEARCH_TAG_EXTENSIONS,
} from './wordlist.js';

const definition: ModuleDefinition = {
  id: 'dirsearch',
  name: '目录扫描',
  category: 'recon',
  targetType: 'endpoint',
  riskLevel: 'safe_active',
  description: '对 HTTP(S) 端点按字典扫描路径。多层真实性验证（baseline / 关键字 / 最小长度 / 重定向），减少通配误报。',
  configSchema: {
    wordlist: { type: 'array', description: '路径字典（可粘贴）' },
    extensions: { type: 'array', default: [], description: '扩展名列表，如 [php, jsp]' },
    statusCodes: { type: 'array', default: DEFAULT_STATUS_CODES, description: '视作命中的状态码' },
    workers: { type: 'number', default: 30 },
    timeoutMs: { type: 'number', default: 3000 },
    baselineProbes: { type: 'number', default: 3, description: '每个端点先请求 N 个随机路径做 baseline' },
    minBodyLength: { type: 'number', default: 0, description: 'body 小于此长度则视为空/无效（0 = 不检查）' },
    sizeToleranceBytes: { type: 'number', default: 64, description: 'body 长度与 baseline 相差小于此值视为同一通配响应' },
    skipDatabasePorts: { type: 'boolean', default: true, description: '跳过数据库/数据类中间件端口，避免公网任务对 DB 做目录扫描' },
    dropGenericErrorPages: {
      type: 'boolean',
      default: true,
      description: '过滤通用错误/拦截页，以及 .git/.htaccess 等敏感路径的非泄露响应',
    },
    bodyExcludeKeywords: {
      type: 'array',
      default: [
        '认证失败', '请登录', '请先登录', '未登录', '无权访问', '无权限', '权限不足', '尚未登录',
        'unauthorized', 'please login', 'login required', 'authentication failed',
        'access denied', 'permission denied', 'not logged in', 'forbidden',
        'invalid token', 'token expired', 'session expired',
      ],
      description: '响应 body 含任一关键字视为非命中（登录/错误页）',
    },
    reportSuspected: { type: 'boolean', default: false, description: '把被过滤的可疑结果也输出（标签 suspected）' },
  },
};

const UA = 'Mozilla/5.0 (SASP-Scanner)';

interface ScanJob {
  endpoint: LiveEndpoint;
  service?: Service;
  scheme: 'http' | 'https';
  path: string;
}

interface EndpointPlan {
  endpoint: LiveEndpoint;
  service?: Service;
  scheme: 'http' | 'https';
}

interface HttpResp {
  status: number;
  headers: Record<string, string>;
  bodyBuf: Buffer;
  body: string;        // utf8 decode，限 32KB
  bodyLen: number;
  contentLength: number;
  contentType: string;
  title?: string;
  location?: string;
  bodyHash: string;    // sha1 前 8 位
}

interface Baseline {
  responses: number;
  statusCounts: Map<number, number>;
  sizes: number[];
  hashes: Set<string>;
  locations: Set<string>;
  titles: Set<string>;
}

const BASELINE_PROBE_PREFIX = 'sasp-nope-';

const DATABASE_PROTOCOLS = new Set([
  'mysql', 'mariadb', 'polardb', 'adb', 'starrocks', 'tidb', 'oceanbase', 'doris',
  'postgres', 'postgresql', 'redis', 'mongodb', 'cassandra',
  'elasticsearch', 'opensearch', 'solr', 'clickhouse', 'couchdb', 'influxdb',
  'aerospike', 'hbase', 'hdfs', 'hive', 'memcached', 'zookeeper',
  'etcd', 'kafka', 'rabbitmq', 'rocketmq', 'pulsar', 'consul', 'nacos',
]);

// 只放数据库/数据类中间件的明确端口；8443/9000 这类通用 Web 端口仅靠产品/协议命中时跳过。
const DATABASE_PORTS = new Set([
  3306, 3307, 3308, 33060,
  5432, 5433,
  6379, 6380, 16379, 26379,
  27017, 27018, 27019, 28017,
  9200, 9201, 9300,
  9042, 9142, 9160,
  5984, 5986,
  8086,
  8123, 9009, 9010,
  8030, 8040, 8060, 9030, 9050, 9060,
  11211, 11212,
  2181, 2888, 3888,
  2379, 2380,
  2881, 2882, 2883, 2884,
  4000, 10080, 20160, 20180,
  6650, 6651,
  8500, 8600, 8848, 8983, 9083, 9600, 9848, 9849,
  9870, 9871, 9864, 9866, 9867,
  9876, 10909, 10911, 10912,
  15671, 15672, 19092,
]);

const DATABASE_PRODUCT_KEYWORDS = [
  'mysql', 'mariadb', 'polardb', 'adb', 'analyticdb', 'starrocks', 'tidb', 'oceanbase', 'doris',
  'postgres', 'postgresql', 'redis', 'mongodb', 'mongo',
  'cassandra', 'elasticsearch', 'elastic search', 'opensearch', 'solr', 'clickhouse',
  'couchdb', 'influxdb', 'aerospike', 'hbase', 'hdfs', 'hive', 'memcached', 'zookeeper',
  'etcd', 'kafka', 'rabbitmq', 'rocketmq', 'pulsar', 'consul', 'nacos', 'trino', 'presto',
];

const HTTP_LIKE_PORTS = new Set([
  80, 81, 82, 83, 84, 88, 443, 3000, 3001, 3002, 3003,
  5000, 5601, 6006, 7001, 7002, 7443, 8000, 8001, 8008, 8080, 8081, 8082, 8083, 8088,
  8090, 8091, 8123, 8443, 8800, 8888, 9000, 9090, 9098, 9099, 9100, 9200, 9443, 9999,
  10000, 10249, 10250, 10255, 10256, 18000,
]);

const NON_HTTP_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 389, 445, 465, 587, 993, 995, 9092]);
const NON_HTTP_PRODUCT_KEYWORDS = [
  'ssh', 'openssh', 'ftp', 'smtp', 'imap', 'pop3', 'kafka',
];

export class DirsearchModule implements IModule {
  definition = definition;
  constructor(private store: Store) {}

  async *execute(ctx: ModuleContext): AsyncGenerator<Result> {
    const cfg = ctx.config;
    const cfgWordlist = Array.isArray(cfg.wordlist) ? (cfg.wordlist as string[]).filter(Boolean) : [];
    const wordlist = cfgWordlist.length > 0 ? cfgWordlist : [...DEFAULT_WORDLIST];
    const extensions = ((cfg.extensions as string[]) || DEFAULT_EXTENSIONS).filter(Boolean);
    const statusCodes = new Set((cfg.statusCodes as number[]) || DEFAULT_STATUS_CODES);
    const workers = Math.max(1, Math.min((cfg.workers as number) || 20, 200));
    const timeoutMs = (cfg.timeoutMs as number) || 3000;
    const baselineProbes = Math.max(0, Math.min((cfg.baselineProbes as number) ?? 3, 10));
    const minBodyLength = (cfg.minBodyLength as number) ?? 0;
    const sizeTol = (cfg.sizeToleranceBytes as number) ?? 64;
    const excludeKw = ((cfg.bodyExcludeKeywords as string[]) || []).map(s => s.toLowerCase()).filter(Boolean);
    const reportSuspected = (cfg.reportSuspected as boolean) ?? false;
    const skipDatabasePorts = (cfg.skipDatabasePorts as boolean) ?? true;
    const dropGenericErrorPages = (cfg.dropGenericErrorPages as boolean) ?? true;

    // 不再为 endpoint × wordlist 预生成百万级 jobs，避免公网巡检时 OOM。
    const words = this.expand(wordlist, extensions);
    const endpoints = this.selectEndpoints(ctx.endpoints, skipDatabasePorts);
    if (endpoints.length === 0 || words.length === 0) return;

    const queue = new AsyncResultQueue();
    let epIdx = 0;
    let processedEndpoints = 0;
    let scannedRequests = 0;
    let hits = 0;
    const endpointParallel = Math.max(1, Math.min(endpoints.length, Math.ceil(Math.sqrt(workers)), 8));
    const perEndpointWorkers = Math.max(1, Math.floor(workers / endpointParallel));

    const pushLog = (type: string, message: string, extra: Record<string, unknown> = {}) => {
      queue.push({
        id: '', runId: ctx.run.id, moduleId: definition.id,
        resultType: 'log',
        data: {
          type,
          message,
          processedEndpoints,
          totalEndpoints: endpoints.length,
          scannedRequests,
          hits,
          workers,
          endpointParallel,
          perEndpointWorkers,
          ...extra,
        },
        createdAt: new Date().toISOString(),
      });
    };

    const endpointWorker = async () => {
      while (epIdx < endpoints.length) {
        const plan = endpoints[epIdx++];
        let { endpoint, service, scheme } = plan;

        // 1) baseline
        let baseline = await this.buildBaseline(endpoint, service, scheme, baselineProbes, timeoutMs);
        if (baselineProbes > 0 && baseline.responses === 0 && !service && scheme === 'http') {
          const alt = await this.buildBaseline(endpoint, service, 'https', baselineProbes, timeoutMs);
          if (alt.responses > 0) {
            scheme = 'https';
            baseline = alt;
          }
        }
        if (baselineProbes > 0 && baseline.responses === 0) {
          processedEndpoints++;
          if (processedEndpoints % 10 === 0 || processedEndpoints === endpoints.length) {
            pushLog('progress', `目录扫描进度: ${processedEndpoints}/${endpoints.length}, 请求 ${scannedRequests}, 命中 ${hits}`);
          }
          continue;
        }

        // 2) 并发扫描该端点
        let wordIdx = 0;
        const pendingByTemplate = new Map<string, Result[]>();
        const suppressedTemplates = new Set<string>();
        const repeatedTemplateThreshold = 5;
        const emitResult = (result: Result, resp: HttpResp, path: string) => {
          if (!this.isRepeatedTemplateCandidate(resp, path)) {
            hits++;
            queue.push(result);
            return;
          }
          const key = this.responseTemplateKey(resp);
          if (suppressedTemplates.has(key)) return;
          const pending = pendingByTemplate.get(key) || [];
          pending.push(result);
          pendingByTemplate.set(key, pending);
          if (pending.length > repeatedTemplateThreshold) {
            // 同一端点大量不同路径返回同一模板，基本是 SPA/通配/认证门禁，整组丢弃。
            pendingByTemplate.delete(key);
            suppressedTemplates.add(key);
          }
        };
        const pathWorker = async () => {
          while (wordIdx < words.length) {
            const path = words[wordIdx++];
            const job: ScanJob = { endpoint, service, scheme, path };
            const resp = await this.request(job, timeoutMs);
            scannedRequests++;
            if (!resp) continue;
            if (!statusCodes.has(resp.status)) continue;
            if (this.isPathBlacklisted(resp.status, job.path)) continue;

            const verdict = this.verify(resp, baseline, job.path, { minBodyLength, sizeTol, excludeKw, dropGenericErrorPages });
            if (!verdict.real && !reportSuspected) continue;

            const result: Result = {
              id: '', runId: ctx.run.id, moduleId: definition.id,
              assetId: job.endpoint.assetId,
              endpointId: job.endpoint.id,
              serviceId: job.service?.id,
              resultType: 'web_path',
              data: {
                url: `${job.scheme}://${job.endpoint.ip}:${job.endpoint.port}/${job.path}`,
                path: '/' + job.path,
                statusCode: resp.status,
                title: resp.title,
                contentLength: resp.bodyLen,
                contentType: resp.contentType,
                location: resp.location,
                bodyPreview: resp.body.slice(0, 200),
                verified: verdict.real ? 'real' : 'suspected',
                verifyReasons: verdict.reasons,
                tags: [
                  resp.status === 200 ? '200-ok'
                    : resp.status >= 300 && resp.status < 400 ? 'redirect'
                    : resp.status === 401 || resp.status === 403 ? 'protected'
                    : `http-${resp.status}`,
                  ...(verdict.real ? [] : ['suspected']),
                ],
              },
              createdAt: new Date().toISOString(),
            };
            emitResult(result, resp, job.path);
          }
        };

        const pool: Promise<void>[] = [];
        const parallel = Math.min(perEndpointWorkers, words.length);
        for (let i = 0; i < parallel; i++) pool.push(pathWorker());
        await Promise.all(pool);
        for (const pending of pendingByTemplate.values()) {
          for (const result of pending) {
            hits++;
            queue.push(result);
          }
        }
        processedEndpoints++;
        if (processedEndpoints % 10 === 0 || processedEndpoints === endpoints.length) {
          pushLog('progress', `目录扫描进度: ${processedEndpoints}/${endpoints.length}, 请求 ${scannedRequests}, 命中 ${hits}`);
        }
      }
    };

    const epPool: Promise<void>[] = [];
    for (let i = 0; i < endpointParallel; i++) epPool.push(endpointWorker());
    Promise.all(epPool)
      .then(() => {
        pushLog('progress_final', `目录扫描完成: ${processedEndpoints}/${endpoints.length}, 请求 ${scannedRequests}, 命中 ${hits}`);
        queue.close();
      })
      .catch(err => queue.close(err));

    for await (const r of queue) yield r;
  }

  // ── baseline 构建 ─────────────────────────────────────────────
  private async buildBaseline(
    ep: LiveEndpoint, svc: Service | undefined, scheme: 'http' | 'https',
    probes: number, timeoutMs: number,
  ): Promise<Baseline> {
    const bl: Baseline = {
      responses: 0,
      statusCounts: new Map(),
      sizes: [],
      hashes: new Set(),
      locations: new Set(),
      titles: new Set(),
    };
    if (probes <= 0) return bl;

    const paths = new Array(probes).fill(0).flatMap(() => {
      const token = BASELINE_PROBE_PREFIX + crypto.randomBytes(6).toString('hex');
      return [
        token,
        `${token}/`,
        `admin/${token}`,
        `api/${token}`,
      ];
    });
    await Promise.all(paths.map(async p => {
      const job: ScanJob = { endpoint: ep, service: svc, scheme, path: p };
      const r = await this.request(job, timeoutMs);
      if (!r) return;
      bl.responses++;
      bl.statusCounts.set(r.status, (bl.statusCounts.get(r.status) || 0) + 1);
      bl.sizes.push(r.bodyLen);
      bl.hashes.add(r.bodyHash);
      if (r.location) bl.locations.add(r.location);
      if (r.title) bl.titles.add(r.title);
    }));
    return bl;
  }

  // ── 真实性判定 ─────────────────────────────────────────────
  private verify(
    resp: HttpResp, bl: Baseline, path: string,
    opts: { minBodyLength: number; sizeTol: number; excludeKw: string[]; dropGenericErrorPages: boolean },
  ): { real: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // 1) 最小 body 长度
    if (opts.minBodyLength > 0 && resp.bodyLen < opts.minBodyLength) {
      reasons.push(`body_too_short(${resp.bodyLen}<${opts.minBodyLength})`);
    }

    // 2) 关键字黑名单
    if (opts.excludeKw.length > 0) {
      const lowerBody = resp.body.toLowerCase();
      const lowerTitle = (resp.title || '').toLowerCase();
      for (const kw of opts.excludeKw) {
        if (lowerBody.includes(kw) || lowerTitle.includes(kw)) {
          reasons.push(`keyword:${kw}`);
          break;
        }
      }
    }

    // 3) 与 baseline 相同状态码 + 相似大小（通配响应）
    if (bl.statusCounts.get(resp.status)) {
      // 同样的 hash = 一定是通配
      if (bl.hashes.has(resp.bodyHash)) reasons.push('baseline_same_body');
      // 同样的 Location = 通配重定向到登录页之类
      else if (resp.location && bl.locations.has(resp.location)) reasons.push('baseline_same_location');
      // 大小接近
      else if (bl.sizes.length > 0) {
        const avg = bl.sizes.reduce((a, b) => a + b, 0) / bl.sizes.length;
        if (Math.abs(resp.bodyLen - avg) <= opts.sizeTol) reasons.push(`baseline_similar_size(~${Math.round(avg)})`);
      }
      // 同样的 title
      if (resp.title && bl.titles.has(resp.title)) reasons.push('baseline_same_title');
    }

    // 4) 模板化错误/拦截页、敏感路径伪命中。
    // 有些站点对任意路径返回 200/403，但内容只是“非法请求”“403 nginx”或 SPA 首页。
    if (opts.dropGenericErrorPages) {
      const genericReason = this.classifyGenericNoContent(resp, path);
      if (genericReason) reasons.push(genericReason);
    }

    return { real: reasons.length === 0, reasons };
  }

  private classifyGenericNoContent(resp: HttpResp, path: string): string | undefined {
    const normalizedPath = '/' + path.replace(/^\/+/, '').toLowerCase();
    const body = resp.body.slice(0, 4096);
    const compactBody = body.replace(/\s+/g, ' ').trim();
    const lower = compactBody.toLowerCase();
    const title = (resp.title || '').trim().toLowerCase();

    if (this.isGitHeadPath(normalizedPath) && !this.looksLikeGitHeadLeak(compactBody)) {
      return 'git_head_not_leak';
    }
    if (this.isGitConfigPath(normalizedPath) && !this.looksLikeGitConfigLeak(compactBody)) {
      return 'git_config_not_leak';
    }
    if (this.isHtaccessPath(normalizedPath) && !this.looksLikeHtaccessLeak(compactBody)) {
      return 'htaccess_not_leak';
    }
    if (this.isHtpasswdPath(normalizedPath) && !this.looksLikeHtpasswdLeak(compactBody)) {
      return 'htpasswd_not_leak';
    }
    if (normalizedPath === '/actuator') return 'actuator_index_not_sensitive';

    // 401 only proves an auth gate exists. Keep real login/admin entries,
    // but drop generic paths such as /config to avoid noisy "protected" rows.
    if (resp.status === 401 && !this.isProtectedEntryPath(normalizedPath)) {
      return 'generic_401_auth_gate';
    }

    if (compactBody.includes('非法请求')) return 'generic_illegal_request';
    if (compactBody.includes('前往OMG访问')) return 'generic_omg_landing';
    if (compactBody.includes('认证失败')
      || compactBody.includes('无法访问系统资源')
      || compactBody.includes('用户未登录')
      || /token has expired/i.test(compactBody)
      || /no authority/i.test(compactBody)
      || /authorization is required/i.test(compactBody)
      || /need authorization header/i.test(compactBody)
      || /you have not logged in yet/i.test(compactBody)
      || /notlogin/i.test(compactBody)
      || title === 'error 401 authentication required') {
      return 'generic_auth_failure';
    }
    if (/range \[\d+,\s*\d+\) out of bounds/i.test(compactBody) && /"success"\s*:\s*false/i.test(compactBody)) {
      return 'generic_backend_error';
    }
    if (/no static resource /i.test(compactBody) && /"success"\s*:\s*false/i.test(compactBody)) {
      return 'generic_static_not_found';
    }
    if (/api not exist/i.test(compactBody) || /^param failed$/i.test(compactBody)) {
      return 'generic_api_not_found';
    }
    if (/the requested url was rejected/i.test(compactBody)) return 'generic_request_rejected';
    if (/request rejected/i.test(compactBody)) return 'generic_request_rejected';
    if (/access denied/i.test(compactBody) && resp.status !== 401) return 'generic_access_denied';

    if (resp.status >= 300 && resp.status < 400 && this.isCanonicalSlashRedirect(resp, normalizedPath)) {
      return 'canonical_slash_redirect';
    }
    if ((resp.status === 401 || resp.status === 403) && resp.bodyLen === 0) {
      return 'empty_protected_response';
    }

    const stripped = lower
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (resp.status === 403) {
      const isPlainForbidden = title === '403 forbidden'
        || /^403 forbidden(?: nginx)?$/.test(stripped)
        || /^forbidden(?: nginx)?$/.test(stripped)
        || (stripped.includes('403 forbidden') && stripped.includes('nginx') && stripped.length <= 80);
      if (isPlainForbidden) return 'generic_403_forbidden';
    }
    if (resp.status >= 500 && /^(?:\d{3} )?(?:internal server error|bad gateway|service unavailable|gateway timeout)/i.test(stripped)) {
      return 'generic_5xx_error';
    }
    if ([400, 404, 405].includes(resp.status) && /^(?:\d{3} )?(?:bad request|not found|method not allowed)/i.test(stripped) && stripped.length <= 120) {
      return `generic_${resp.status}_error`;
    }

    return undefined;
  }

  private isGitHeadPath(path: string): boolean {
    return path.endsWith('/.git/head') || path.endsWith('.git/head');
  }

  private isGitConfigPath(path: string): boolean {
    return path.endsWith('/.git/config') || path.endsWith('.git/config');
  }

  private isHtaccessPath(path: string): boolean {
    return path.endsWith('/.htaccess') || path.endsWith('.htaccess');
  }

  private isHtpasswdPath(path: string): boolean {
    return path.endsWith('/.htpasswd') || path.endsWith('.htpasswd') || /\/\d+\.htpasswd$/.test(path) || path.endsWith('/_.htpasswd');
  }

  private looksLikeGitHeadLeak(body: string): boolean {
    const trimmed = body.trim();
    return /^ref:\s*refs\/heads\/[A-Za-z0-9._/-]+$/m.test(trimmed) || /^[a-f0-9]{40}$/im.test(trimmed);
  }

  private looksLikeGitConfigLeak(body: string): boolean {
    const lower = body.toLowerCase();
    return lower.includes('[core]') && (lower.includes('repositoryformatversion') || lower.includes('worktree') || lower.includes('bare ='));
  }

  private looksLikeHtaccessLeak(body: string): boolean {
    return /\b(?:rewriteengine|rewriterule|rewritecond|authtype|authname|authuserfile|require\s+valid-user|deny\s+from|allow\s+from|options\s+[+-]|directoryindex|sethandler|addhandler)\b/i.test(body);
  }

  private looksLikeHtpasswdLeak(body: string): boolean {
    return /^[A-Za-z0-9._-]{1,64}:(?:\$[A-Za-z0-9./$]+|[A-Za-z0-9./]{13,}|[a-f0-9]{32,})/m.test(body);
  }

  private isProtectedEntryPath(normalizedPath: string): boolean {
    return /^\/(?:admin|console|dashboard|login|signin|wp-login|phpmyadmin|pma)(?:\/|\.php|$)/i.test(normalizedPath)
      || /^\/manager\/(?:html|jmxproxy|status)(?:\/|$)/i.test(normalizedPath);
  }

  private isCanonicalSlashRedirect(resp: HttpResp, normalizedPath: string): boolean {
    if (!resp.location) return false;
    const locationPath = this.normalizeLocationPath(resp.location);
    if (!locationPath) return false;
    const withoutSlash = normalizedPath.replace(/\/+$/, '');
    const withSlash = `${withoutSlash}/`;
    return locationPath === withoutSlash || locationPath === withSlash;
  }

  private normalizeLocationPath(location: string): string | undefined {
    try {
      const parsed = location.startsWith('http://') || location.startsWith('https://')
        ? new URL(location)
        : new URL(location, 'http://placeholder.local');
      return (parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/').toLowerCase();
    } catch {
      return undefined;
    }
  }

  private isRepeatedTemplateCandidate(resp: HttpResp, path: string): boolean {
    const normalizedPath = '/' + path.replace(/^\/+/, '').toLowerCase();
    if (resp.status >= 300 && resp.status < 400) return true;
    if ((resp.status === 401 || resp.status === 403) && resp.bodyLen <= 512) return true;
    if (resp.status !== 200) return false;
    if (resp.bodyLen > 0 && resp.bodyLen <= 128) return true;
    if (!/html/i.test(resp.contentType)) return false;
    if (resp.bodyLen < 300) return false;
    if (normalizedPath === '/') return false;
    return true;
  }

  private responseTemplateKey(resp: HttpResp): string {
    const location = resp.location ? this.normalizeLocationPath(resp.location) || resp.location : '';
    const title = (resp.title || '').slice(0, 80);
    const bodyPrefix = resp.body.replace(/\s+/g, ' ').trim().slice(0, 160);
    const bodyHash = crypto.createHash('sha1').update(bodyPrefix).digest('hex').slice(0, 12);
    return [resp.status, title, location, resp.contentType, resp.bodyLen, bodyHash].join('|');
  }

  // ── 端点分组 + scheme 推断 ───────────────────────────────────
  private selectEndpoints(
    endpoints: LiveEndpoint[],
    skipDatabasePorts: boolean,
  ): EndpointPlan[] {
    const services = this.store.getAll('services') as Service[];
    const svcByEndpoint = new Map<string, Service>();
    for (const s of services) svcByEndpoint.set(s.endpointId, s);

    const plans: EndpointPlan[] = [];
    for (const ep of endpoints) {
      if (!ep.alive || ep.disappearedAt) continue;
      const svc = svcByEndpoint.get(ep.id);
      if (skipDatabasePorts && this.isDatabaseEndpoint(ep, svc)) continue;
      const scheme = this.inferScheme(ep, svc);
      if (!scheme) continue;
      plans.push({ endpoint: ep, service: svc, scheme });
    }
    return plans;
  }

  private isDatabaseEndpoint(ep: LiveEndpoint, svc?: Service): boolean {
    const protocol = svc?.protocol?.toLowerCase();
    if (protocol && DATABASE_PROTOCOLS.has(protocol)) return true;

    if (DATABASE_PORTS.has(ep.port)) return true;

    const fingerprintText = (svc?.fingerprints || []).map(f => `${f.name} ${f.source}`).join(' ');
    const text = `${svc?.product || ''} ${svc?.title || ''} ${fingerprintText} ${ep.banner || ''}`.toLowerCase();
    return DATABASE_PRODUCT_KEYWORDS.some(keyword => text.includes(keyword));
  }

  private inferScheme(ep: LiveEndpoint, svc?: Service): 'http' | 'https' | undefined {
    if (svc?.protocol === 'https') return 'https';
    if (svc?.protocol === 'http') return 'http';
    if (svc && svc.protocol !== 'tcp' && svc.protocol !== 'unknown') return undefined;
    if ([443, 4443, 7443, 8443, 9443].includes(ep.port)) return 'https';
    if (HTTP_LIKE_PORTS.has(ep.port)) return 'http';
    if (NON_HTTP_PORTS.has(ep.port)) return undefined;
    const fingerprintText = (svc?.fingerprints || []).map(f => `${f.name} ${f.source}`).join(' ');
    const text = `${svc?.product || ''} ${svc?.title || ''} ${fingerprintText} ${ep.banner || ''}`.toLowerCase();
    if (NON_HTTP_PRODUCT_KEYWORDS.some(keyword => text.includes(keyword))) return undefined;
    // Unknown non-standard ports are skipped to keep公网目录扫描可控；需要时把端口加入 HTTP_LIKE_PORTS。
    return undefined;
  }

  private expand(words: string[], extensions: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
      const normalized = value.replace(/^\/+/, '');
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    };
    for (const w of words) {
      if (/%EXT%/i.test(w)) {
        const tagExtensions = extensions.length > 0 ? extensions : DIRSEARCH_TAG_EXTENSIONS;
        for (const ext of tagExtensions) push(w.replace(/%EXT%/gi, ext.replace(/^\./, '')));
        continue;
      }
      push(w);
      if (extensions.length > 0 && !w.includes('.') && !w.endsWith('/')) {
        push(`${w}/`);
        for (const ext of extensions) push(`${w}.${ext.replace(/^\./, '')}`);
      }
    }
    return out;
  }

  private isPathBlacklisted(status: number, path: string): boolean {
    const blacklist = DIRSEARCH_STATUS_PATH_BLACKLIST[status];
    if (!blacklist?.length) return false;
    const normalized = path.replace(/^\/+/, '');
    return blacklist.some(suffix => normalized.endsWith(suffix.replace(/^\/+/, '')));
  }

  // ── HTTP 请求 ─────────────────────────────────────────────
  private request(job: ScanJob, timeoutMs: number): Promise<HttpResp | null> {
    return new Promise(resolve => {
      const mod = job.scheme === 'https' ? https : http;
      const path = '/' + job.path.replace(/^\/+/, '');
      let resolved = false;
      let timer: NodeJS.Timeout | undefined;
      let req: http.ClientRequest | undefined;
      const finish = (value: HttpResp | null) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        req?.destroy();
        finish(null);
      }, timeoutMs + 1000);
      req = mod.get({
        host: job.endpoint.ip, port: job.endpoint.port, path,
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      }, res => {
        const cl = Number(res.headers['content-length'] || 0);
        const ct = String(res.headers['content-type'] || '');
        const loc = (res.headers['location'] || '') as string;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finishResponse = () => {
          if (done) return;
          done = true;
          const bodyBuf = Buffer.concat(chunks);
          const body = bodyBuf.toString('utf8');
          const titleMatch = body.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
          const bodyHash = crypto.createHash('sha1').update(bodyBuf).digest('hex').slice(0, 12);
          finish({
            status: res.statusCode || 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v || '')])),
            bodyBuf, body,
            bodyLen: cl || size,
            contentLength: cl || size,
            contentType: ct,
            location: loc || undefined,
            title: titleMatch ? titleMatch[1].trim() : undefined,
            bodyHash,
          });
        };
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 32 * 1024) chunks.push(c);
          if (size >= 32 * 1024) {
            finishResponse();
            req?.destroy();
          }
        });
        res.on('end', finishResponse);
        res.on('close', finishResponse);
        res.on('aborted', finishResponse);
        res.on('error', () => finish(null));
      });
      req.on('timeout', () => { req?.destroy(); finish(null); });
      req.on('error', () => finish(null));
    });
  }
}

class AsyncResultQueue implements AsyncIterable<Result> {
  private items: Result[] = [];
  private closed = false;
  private error: unknown;
  private notify?: () => void;

  push(item: Result) {
    this.items.push(item);
    this.wake();
  }

  close(error?: unknown) {
    this.error = error;
    this.closed = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Result> {
    while (!this.closed || this.items.length > 0) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      await new Promise<void>(resolve => { this.notify = resolve; });
    }
    if (this.error) throw this.error;
  }

  private wake() {
    const notify = this.notify;
    this.notify = undefined;
    notify?.();
  }
}
