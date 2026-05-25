import type { Result, ModuleDefinition, FingerprintRule, LiveEndpoint, Service, WebPath } from '@sasp/shared';
import type { IModule, ModuleContext } from '../engine/module-interface.js';
import { Store } from '../storage/store.js';
import {
  probeHttp, probeTcpBanner, probeKafkaMetadata, fetchFavicon,
  getCachedFaviconHash, setCachedFaviconHash,
  REDIS_PROBE, MEMCACHED_PROBE, ZOOKEEPER_PROBE, AEROSPIKE_INFO_PROBE,
  type ProbeSignals,
} from './fingerprints/probes.js';
import { faviconHash } from './fingerprints/mmh3.js';
import { matchAll, type MatchHit } from './fingerprints/matcher.js';

const definition: ModuleDefinition = {
  id: 'fingerprint',
  name: '指纹识别',
  category: 'fingerprint',
  targetType: 'endpoint',
  riskLevel: 'passive',
  description: '分层探测（banner → handshake → HTTP → favicon → TLS）+ 规则匹配，早停短路。输出已识别的服务。',
  configSchema: {
    workers: { type: 'number', default: 60, description: '并发探测数' },
    httpTimeoutMs: { type: 'number', default: 3000 },
    tcpTimeoutMs: { type: 'number', default: 2000 },
    faviconTimeoutMs: { type: 'number', default: 2000 },
    enableFavicon: { type: 'boolean', default: true },
    enableTls: { type: 'boolean', default: true },
  },
};

/**
 * 端口→默认协议猜测（用于选探测路径，不是最终协议）
 * 已知非 HTTP 的协议端口优先走对应 handshake；未知端口先试 HTTP 再降级。
 */
const PORT_PROTOCOL_HINT: Record<number, string> = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns',
  110: 'pop3', 143: 'imap', 389: 'ldap', 445: 'smb',
  465: 'smtp', 587: 'smtp', 636: 'ldap', 873: 'rsync', 989: 'ftp', 990: 'ftp', 993: 'imap', 995: 'pop3',
  1080: 'socks', 1081: 'socks', 1099: 'rmi', 1883: 'mqtt', 2049: 'nfs',
  2375: 'docker', 2376: 'docker',
  3389: 'rdp', 3690: 'svn', 4369: 'epmd', 5671: 'amqp', 5672: 'amqp',
  5900: 'vnc', 5901: 'vnc', 5902: 'vnc', 5903: 'vnc',
  6000: 'x11', 6001: 'x11', 6006: 'tensorboard', 6443: 'kubernetes', 8009: 'ajp',
  8883: 'mqtt', 9100: 'printer', 9418: 'git', 10050: 'zabbix-agent', 10051: 'zabbix',
  10250: 'kubelet', 10255: 'kubelet', 10256: 'kube-proxy',
  25672: 'erlang-distribution', 61613: 'stomp', 61614: 'stomp', 61616: 'activemq',
  1433: 'mssql', 1434: 'mssql', 1521: 'oracle', 1522: 'oracle',
  2881: 'oceanbase', 2882: 'oceanbase', 2883: 'oceanbase', 2884: 'oceanbase',
  3306: 'mysql', 3307: 'mysql', 3308: 'mysql',
  4000: 'tidb', 10080: 'tidb', 20160: 'tidb', 20180: 'tidb',
  5432: 'postgres', 5433: 'postgres',
  6379: 'redis', 6380: 'redis',
  6650: 'pulsar', 6651: 'pulsar',
  7000: 'http', 7001: 'http', 7002: 'http', 7003: 'http', 7004: 'http', 7005: 'http', 7006: 'http',
  8030: 'http', 8040: 'http', 8060: 'http',
  9042: 'cassandra', 9160: 'cassandra',
  9083: 'hive',
  9200: 'http', // ES
  9300: 'elasticsearch-transport',
  9600: 'http',
  8983: 'http',
  11211: 'memcached',
  27017: 'mongodb', 27018: 'mongodb', 27019: 'mongodb',
  2181: 'zookeeper', 2182: 'zookeeper', 2183: 'zookeeper', 2888: 'zookeeper', 3888: 'zookeeper',
  2379: 'etcd', 2380: 'etcd',
  7474: 'http', 7687: 'neo4j',
  9092: 'kafka', 9093: 'kafka', 19092: 'kafka',
  9876: 'rocketmq', 10909: 'rocketmq', 10911: 'rocketmq', 10912: 'rocketmq',
  11212: 'memcached',
  15671: 'http', 15672: 'http',
  8083: 'http', 8500: 'http', 8600: 'consul', 8848: 'http',
  8123: 'http', // ClickHouse HTTP
  9050: 'doris', 9060: 'doris',
  9870: 'http', 9871: 'http', 9864: 'http', 9866: 'hdfs', 9867: 'hdfs',
  16000: 'http', 16010: 'http', 16020: 'http',
  50070: 'http', 50075: 'http', 50090: 'http',
  60010: 'http',
};

const HTTPS_PORT_HINT = new Set([443, 4443, 7443, 8443, 9443, 8834]);
const AEROSPIKE_PORTS = new Set([3000, 3001, 3002, 3003]);

const PROTOCOL_PRODUCT_FALLBACK: Record<string, string> = {
  ssh: 'SSH',
  ftp: 'FTP',
  telnet: 'Telnet',
  smtp: 'SMTP',
  pop3: 'POP3',
  imap: 'IMAP',
  dns: 'DNS',
  ldap: 'LDAP',
  smb: 'SMB',
  rsync: 'Rsync',
  socks: 'SOCKS Proxy',
  rmi: 'Java RMI',
  mqtt: 'MQTT',
  nfs: 'NFS',
  docker: 'Docker API',
  rdp: 'RDP',
  svn: 'Subversion',
  epmd: 'Erlang EPMD',
  amqp: 'AMQP',
  vnc: 'VNC',
  x11: 'X11',
  tensorboard: 'TensorBoard',
  kubernetes: 'Kubernetes API',
  ajp: 'AJP',
  printer: 'JetDirect',
  git: 'Git',
  'zabbix-agent': 'Zabbix Agent',
  zabbix: 'Zabbix',
  kubelet: 'Kubelet',
  'kube-proxy': 'Kube Proxy',
  'erlang-distribution': 'Erlang Distribution',
  stomp: 'STOMP',
  activemq: 'ActiveMQ',
  mssql: 'MSSQL',
  oracle: 'Oracle',
  kafka: 'Kafka',
  tidb: 'TiDB',
  oceanbase: 'OceanBase',
  pulsar: 'Pulsar',
  rocketmq: 'RocketMQ',
  doris: 'Doris',
  hive: 'HiveServer2',
  hdfs: 'HDFS',
  consul: 'Consul',
};

function hintHttps(port: number): boolean {
  return HTTPS_PORT_HINT.has(port);
}

function hintExplicitNonHttp(port: number): string | undefined {
  const p = PORT_PROTOCOL_HINT[port];
  if (!p) return undefined;
  if (p === 'http') return undefined;
  return p;
}

async function probeEndpoint(
  ep: LiveEndpoint,
  cfg: { httpTimeoutMs: number; tcpTimeoutMs: number; faviconTimeoutMs: number; enableFavicon: boolean; enableTls: boolean },
  rules: FingerprintRule[],
): Promise<{ signals: ProbeSignals; hits: MatchHit[] }> {
  const signals: ProbeSignals = { banner: ep.banner, timings: {} };
  const hits: MatchHit[] = [];
  const t0 = Date.now();

  // ─ L0：用 port-discovery 已抓的 banner 先匹配（免费信号）
  if (signals.banner) {
    hits.push(...matchAll(rules.filter(r => r.matchers.some(m => m.type === 'banner')), signals));
    if (hits.length > 0) {
      signals.timings.l0 = Date.now() - t0;
      // banner 强信号命中，SSH/FTP/MySQL 这种已经足够，不再继续
      const strong = hits.find(h => h.category === 'database' || h.matcherType === 'banner');
      if (strong) return { signals, hits };
    }
  }

  // ─ L1：端口 hint 决定主路径
  const explicitNonHttp = hintExplicitNonHttp(ep.port);

  if (explicitNonHttp) {
    // 非 HTTP 端口：发专用探针抓 banner
    if (explicitNonHttp === 'kafka') {
      const b = await probeKafkaMetadata(ep.ip, ep.port, cfg.tcpTimeoutMs);
      if (b) signals.banner = (signals.banner || '') + b;
    }
    const probeMap: Record<string, Buffer | undefined> = {
      redis: REDIS_PROBE,
      memcached: MEMCACHED_PROBE,
      zookeeper: ZOOKEEPER_PROBE,
      aerospike: AEROSPIKE_INFO_PROBE,
    };
    const probe = probeMap[explicitNonHttp];
    if (!signals.banner || probe) {
      const b = await probeTcpBanner(ep.ip, ep.port, cfg.tcpTimeoutMs, probe);
      if (b) signals.banner = (signals.banner || '') + b;
    }
    signals.protocol = signals.protocol || explicitNonHttp;
    // 再次匹配 banner 规则
    hits.push(...matchAll(rules.filter(r => r.matchers.some(m => m.type === 'banner')), signals));
    signals.timings.l2 = Date.now() - t0;
    return { signals, hits: dedupeHits(hits) };
  }

  // ─ L3：HTTP / HTTPS 探测
  const scheme: 'http' | 'https' = hintHttps(ep.port) ? 'https' : 'http';
  let httpRes = await probeHttp(ep, scheme, cfg.httpTimeoutMs);
  let actualScheme: 'http' | 'https' = scheme;

  // 如果 http 探测失败，试 https（兼容自签端口）
  if (!httpRes.httpStatus && scheme === 'http' && cfg.enableTls) {
    const alt = await probeHttp(ep, 'https', cfg.httpTimeoutMs);
    if (alt.httpStatus) { httpRes = alt; actualScheme = 'https'; }
  }

  Object.assign(signals, httpRes);
  if (httpRes.httpStatus) signals.protocol = actualScheme;
  else if (!signals.protocol) {
    // HTTP 失败 → 尝试普通 banner 抓取
    if (!signals.banner) {
      const b = await probeTcpBanner(
        ep.ip,
        ep.port,
        cfg.tcpTimeoutMs,
        AEROSPIKE_PORTS.has(ep.port) ? AEROSPIKE_INFO_PROBE : undefined,
      );
      if (b) signals.banner = b;
    }
    signals.protocol = 'tcp';
  }

  // 匹配可用信号的规则
  hits.push(...matchAll(rules, signals));

  // ─ L4：favicon（HTTP 探测成功且尚未命中 高置信度规则时才拉）
  if (cfg.enableFavicon && httpRes.httpStatus && hits.length === 0) {
    const cacheKey = `${ep.ip}:${ep.port}:${actualScheme}`;
    let h = getCachedFaviconHash(cacheKey);
    if (h === undefined) {
      const buf = await fetchFavicon(ep, actualScheme, cfg.faviconTimeoutMs);
      if (buf && buf.length > 0) {
        h = faviconHash(buf);
        setCachedFaviconHash(cacheKey, h);
      }
    }
    if (h !== undefined) {
      signals.faviconHash = h;
      hits.push(...matchAll(rules.filter(r => r.matchers.some(m => m.type === 'favicon')), signals));
    }
  }

  signals.timings.total = Date.now() - t0;
  return { signals, hits: dedupeHits(hits) };
}

function dedupeHits(hits: MatchHit[]): MatchHit[] {
  const seen = new Set<string>();
  const out: MatchHit[] = [];
  for (const h of hits) {
    const key = `${h.product}:${h.version || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildWebPathSignals(store: Store): Map<string, ProbeSignals> {
  const services = store.getAll('services') as Service[];
  const serviceToEndpoint = new Map(services.map(s => [s.id, s.endpointId]));
  const grouped = new Map<string, WebPath[]>();

  for (const wp of store.getAll('webPaths') as WebPath[]) {
    if ((wp as any).disappearedAt) continue;
    const endpointId = serviceToEndpoint.get(wp.serviceId);
    if (!endpointId) continue;
    const arr = grouped.get(endpointId) || [];
    arr.push(wp);
    grouped.set(endpointId, arr);
  }

  const out = new Map<string, ProbeSignals>();
  for (const [endpointId, paths] of grouped) {
    const useful = paths
      .filter(wp => wp.verified !== 'suspected')
      .sort((a, b) => (a.statusCode - b.statusCode) || a.path.localeCompare(b.path))
      .slice(0, 20);
    if (!useful.length) continue;

    const title = useful.find(wp => wp.title)?.title;
    const body = useful.map(wp => [
      wp.path,
      wp.url,
      wp.title || '',
      wp.contentType || '',
      wp.bodyPreview || '',
    ].join('\n')).join('\n---webpath---\n').slice(0, 64 * 1024);

    out.set(endpointId, { title, body, protocol: 'http', timings: {} });
  }
  return out;
}

const GENERIC_TITLE_PATTERNS = [
  /^title$/i,
  /^untitled$/i,
  /^index of\b/i,
  /^directory listing\b/i,
  /^welcome to (nginx|openresty|apache|centos)/i,
  /^(400|401|403|404|500|502|503)\b/i,
  /\b(not found|forbidden|unauthorized|bad gateway|internal server error|service unavailable)\b/i,
  /^error$/i,
  /^redirecting/i,
  /^manage page$/i,
  /^please sign in$/i,
];

function htmlDecodeLite(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#8212;|&mdash;/gi, '-');
}

function businessLabelFromTitle(title?: string): string | undefined {
  const clean = htmlDecodeLite(String(title || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.length < 3) return undefined;
  if (GENERIC_TITLE_PATTERNS.some(p => p.test(clean))) return undefined;

  // 业务站点常把品牌放在分隔符左侧；保留一个短标签，避免把整句营销文案当产品名。
  const label = clean
    .split(/\s+(?:[-–—|·]|::)\s+|\s+\|\s+/)[0]
    .replace(/^欢迎登录/, '')
    .trim()
    .slice(0, 60);
  if (!label || GENERIC_TITLE_PATTERNS.some(p => p.test(label))) return undefined;
  return label;
}

function fallbackProductFromProtocol(protocol?: string): string | undefined {
  if (!protocol || ['tcp', 'unknown', 'http', 'https'].includes(protocol)) return undefined;
  return PROTOCOL_PRODUCT_FALLBACK[protocol] || protocol.toUpperCase();
}

export class FingerprintModule implements IModule {
  definition = definition;
  constructor(private store: Store) {}

  async *execute(ctx: ModuleContext): AsyncGenerator<Result> {
    const cfg = {
      httpTimeoutMs: (ctx.config.httpTimeoutMs as number) || 3000,
      tcpTimeoutMs: (ctx.config.tcpTimeoutMs as number) || 2000,
      faviconTimeoutMs: (ctx.config.faviconTimeoutMs as number) || 2000,
      enableFavicon: (ctx.config.enableFavicon as boolean) ?? true,
      enableTls: (ctx.config.enableTls as boolean) ?? true,
    };
    const hardTimeoutMs = Math.max(
      (ctx.config.hardTimeoutMs as number) || 0,
      cfg.httpTimeoutMs * 3 + cfg.tcpTimeoutMs + cfg.faviconTimeoutMs + 3000,
      10_000,
    );
    const workers = Math.max(1, Math.min((ctx.config.workers as number) || 20, 200));
    const rules = (this.store.getAll('fingerprintRules') as FingerprintRule[]).filter(r => r.enabled);
    const webPathSignals = buildWebPathSignals(this.store);
    const endpoints = ctx.endpoints;
    if (endpoints.length === 0) return;

    let idx = 0;
    let processed = 0;
    let identified = 0;
    let activeWorkers = Math.min(workers, endpoints.length);
    let nextProgressAt = Math.min(50, endpoints.length);
    const progressEvery = Math.max(20, Math.min((ctx.config.progressEvery as number) || 100, 5000));
    const queue: Result[] = [];
    let notify: (() => void) | undefined;

    const pushResult = (result: Result) => {
      queue.push(result);
      notify?.();
      notify = undefined;
    };

    const notifyIfDrained = () => {
      if (activeWorkers === 0) {
        notify?.();
        notify = undefined;
      }
    };

    const pushProgress = (final = false) => {
      pushResult({
        id: '',
        runId: ctx.run.id,
        moduleId: definition.id,
        resultType: 'log',
        data: {
          type: final ? 'progress_final' : 'progress',
          message: final
            ? `指纹识别完成: ${processed}/${endpoints.length}, 服务 ${identified}`
            : `指纹识别进度: ${processed}/${endpoints.length}, 服务 ${identified}`,
          processed,
          total: endpoints.length,
          services: identified,
          workers: activeWorkers,
        },
        createdAt: new Date().toISOString(),
      });
    };

    const worker = async () => {
      try {
        while (idx < endpoints.length) {
          const ep = endpoints[idx++];
          try {
            const { signals, hits } = await withHardTimeout(
              probeEndpoint(ep, cfg, rules),
              hardTimeoutMs,
              'fingerprint_probe_timeout',
            );
            if (hits.length === 0) {
              const wpSignals = webPathSignals.get(ep.id);
              if (wpSignals?.body) {
                if (wpSignals.title && (!signals.title || !businessLabelFromTitle(signals.title))) signals.title = wpSignals.title;
                if (!signals.body) signals.body = wpSignals.body;
                else signals.body = `${signals.body}\n---webpath---\n${wpSignals.body}`.slice(0, 64 * 1024);
                hits.push(...matchAll(rules, signals));
              }
            }

            if (hits.length === 0) {
              const fallbackProduct = fallbackProductFromProtocol(signals.protocol);
              // 至少建一条 Service，带 protocol/title；立即产出，避免重启时整批丢失。
              pushResult({
                id: '', runId: ctx.run.id, moduleId: definition.id,
                assetId: ep.assetId, endpointId: ep.id,
                resultType: 'service_identified',
                data: {
                  protocol: signals.protocol || 'tcp',
                  product: fallbackProduct,
                  title: signals.title,
                  banner: signals.banner?.slice(0, 256),
                  fingerprints: fallbackProduct ? [{
                    name: fallbackProduct,
                    confidence: 0.35,
                    source: 'port-protocol-fallback',
                  }] : [],
                  replaceFingerprints: true,
                },
                createdAt: new Date().toISOString(),
              });
            } else {
              const primary = hits[0];
              pushResult({
                id: '', runId: ctx.run.id, moduleId: definition.id,
                assetId: ep.assetId, endpointId: ep.id,
                resultType: 'service_identified',
                data: {
                  protocol: signals.protocol || 'tcp',
                  product: primary.product,
                  version: primary.version,
                  title: signals.title,
                  fingerprints: hits.map(hit => ({
                    name: hit.product,
                    version: hit.version,
                    confidence: hit.confidence,
                    source: `fingerprint-rule:${hit.matcherType}`,
                  })),
                  replaceFingerprints: true,
                  ruleIds: hits.map(hit => hit.ruleId),
                  categories: [...new Set(hits.map(hit => hit.category).filter(Boolean))],
                  tags: [...new Set(hits.flatMap(hit => hit.tags || []))],
                },
                createdAt: new Date().toISOString(),
              });
            }
            identified++;
          } catch (err: any) {
            const protocol = hintExplicitNonHttp(ep.port) || (hintHttps(ep.port) ? 'https' : 'tcp');
            pushResult({
              id: '', runId: ctx.run.id, moduleId: definition.id,
              assetId: ep.assetId, endpointId: ep.id,
              resultType: 'service_identified',
              data: {
                protocol,
                fingerprints: [],
                replaceFingerprints: true,
              },
              createdAt: new Date().toISOString(),
            });
            pushResult({
              id: '', runId: ctx.run.id, moduleId: definition.id,
              assetId: ep.assetId, endpointId: ep.id,
              resultType: 'log',
              data: {
                type: 'probe_error',
                ip: ep.ip,
                host: ep.host || ep.ip,
                port: ep.port,
                error: err?.message || 'fingerprint_probe_failed',
              },
              createdAt: new Date().toISOString(),
            });
          }

          processed++;
          if (processed >= nextProgressAt) {
            pushProgress();
            nextProgressAt = processed + progressEvery;
          }
        }
      } finally {
        activeWorkers--;
        if (activeWorkers === 0) pushProgress(true);
        notifyIfDrained();
      }
    };

    const pool: Promise<void>[] = [];
    for (let i = 0; i < activeWorkers; i++) pool.push(worker());

    while (activeWorkers > 0 || queue.length > 0) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>(resolve => { notify = resolve; });
    }
    await Promise.all(pool);
  }
}
