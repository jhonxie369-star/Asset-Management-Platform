import type { Result, ModuleDefinition } from '@sasp/shared';
import type { IModule, ModuleContext } from '../../engine/module-interface.js';
import { Store } from '../../storage/store.js';
import {
  AUTH_TESTERS, DEFAULT_AUTH_PROFILES, DEFAULT_AUTH_USERNAMES,
  DEFAULT_AUTH_PASSWORDS_MAP, DEFAULT_EXTRA_PASSWORDS, DEFAULT_PASSWORDS,
} from './registry.js';
import { resolveAuthTargets } from './resolver.js';
import type { AuthFindingDraft, AuthProfile, AuthTarget } from './types.js';
import { checkFtpAnonymous, grabFtpBanner } from './testers/ftp.js';

const definition: ModuleDefinition = {
  id: 'weak-password',
  name: '认证面巡检',
  category: 'bruteforce',
  targetType: 'endpoint',
  riskLevel: 'intrusive',
  description: '对已发现活端点做认证风险巡检：未授权/匿名登录/明文协议/弱口令。保留 weak-password id 兼容旧任务。',
  configSchema: {
    authProfiles: { type: 'array', description: '认证 tester 配置数组,每项 { name, enabled, ports, fingerprintProducts, checks }' },
    dbs: { type: 'array', description: '[兼容] 旧 DB 配置数组,会转换为 authProfiles' },
    usernames: { type: 'object', description: '按 tester 名的 usernames map' },
    passwordsMap: { type: 'object', description: '按 tester 名的 passwords map' },
    extraPasswords: { type: 'array', description: '所有 tester 共享的追加密码' },
    passwords: { type: 'array', description: '[兼容] 全局密码数组' },
    timeoutMs: { type: 'number', default: 4000 },
    workers: { type: 'number', default: 20 },
    stopOnFirstHit: { type: 'boolean', default: true, description: '单个目标命中首条凭据就停' },
    delayBetweenMs: { type: 'number', default: 100, description: '对同一目标两次尝试的间隔,避免触发锁' },
  },
};

export class WeakPasswordModule implements IModule {
  definition = definition;
  constructor(private store: Store) {}

  async *execute(ctx: ModuleContext): AsyncGenerator<Result> {
    const cfg = ctx.config;
    const profiles = normalizeProfiles(cfg);
    const passwordsMap = (cfg.passwordsMap as Record<string, string[]>) || DEFAULT_AUTH_PASSWORDS_MAP;
    const extraPasswords = (cfg.extraPasswords as string[]) || DEFAULT_EXTRA_PASSWORDS;
    const legacyPasswords = (cfg.passwords as string[]) || DEFAULT_PASSWORDS;
    const usernamesMap = (cfg.usernames as Record<string, string[]>) || DEFAULT_AUTH_USERNAMES;
    const timeoutMs = (cfg.timeoutMs as number) || 4000;
    const attemptTimeoutMs = Math.max(timeoutMs + 1000, Math.ceil(timeoutMs * 1.5));
    const workers = Math.max(1, Math.min((cfg.workers as number) || 20, 100));
    const stopOnFirst = (cfg.stopOnFirstHit as boolean) ?? true;
    const delayMs = (cfg.delayBetweenMs as number) ?? 100;

    const services = this.store.getAll('services') as any[];
    const targets = resolveAuthTargets(ctx.endpoints, services, profiles);
    if (targets.length === 0) return;

    const passwordsFor = (testerId: string): string[] => {
      const own = passwordsMap[testerId];
      const seen = new Set<string>();
      const out: string[] = [];
      const push = (s: string) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
      for (const p of (own && own.length > 0 ? own : legacyPasswords)) push(p);
      for (const p of extraPasswords) push(p);
      return out;
    };

    let idx = 0;
    const queue = new AsyncResultQueue();

    const worker = async () => {
      while (idx < targets.length) {
        const target = targets[idx++];
        const checks = { ...target.tester.checks, ...(target.profile.checks || {}) };
        let tried = 0;
        let hit = false;
        const failures: Record<string, number> = {};
        const samples: Record<string, string> = {};

        if (target.tester.id === 'ftp' && checks.plaintext) {
          const banner = await withHardTimeout(
            grabFtpBanner(targetHost(target), target.endpoint.port, timeoutMs),
            attemptTimeoutMs,
            'ftp_banner_timeout',
          );
          if (banner.success) {
            queue.push(findingResult(ctx, target, {
              type: 'plaintext_protocol', severity: 'medium',
              title: `FTP 明文协议暴露 ${targetHost(target)}:${target.endpoint.port}`,
              description: 'FTP 使用明文传输账号密码，公网或跨网段使用时容易被窃听。',
              evidence: banner.banner || banner.message,
              recommendation: '如无必要关闭 FTP；确需文件传输时改用 SFTP/FTPS，并限制来源 IP。',
              dedupeKey: `plaintext_protocol:ftp:${targetHost(target)}:${target.endpoint.port}`,
            }));
          }
        }

        if (target.tester.id === 'ftp' && checks.anonymous) {
          tried++;
          const r = await withHardTimeout(
            checkFtpAnonymous(targetHost(target), target.endpoint.port, timeoutMs),
            attemptTimeoutMs,
            'ftp_anonymous_timeout',
          );
          if (r.success) {
            hit = true;
            queue.push(findingResult(ctx, target, {
              type: 'anonymous_login', severity: 'high',
              title: `FTP 匿名登录 ${targetHost(target)}:${target.endpoint.port}`,
              description: 'FTP 允许 anonymous 匿名登录，可能导致敏感文件泄露或目录被枚举。',
              evidence: r.banner || r.message,
              recommendation: '禁用 anonymous 登录；如业务确需匿名下载，应最小化目录权限并禁止写入。',
              dedupeKey: `anonymous_login:ftp:${targetHost(target)}:${target.endpoint.port}`,
              credentials: { username: 'anonymous', password: 'anonymous@', passwordMasked: 'anonymous@' },
            }));
          } else {
            recordFailure(failures, samples, r.message);
          }
        }

        if (checks.weakPassword && target.tester.credentialTester) {
          const users = usernamesMap[target.tester.id] || usernamesMap.default || [''];
          const pwList = passwordsFor(target.tester.id);
          outer:
          for (const u of users) {
            for (const p of pwList) {
              if (!u && !p && !checks.anonymous) continue;
              tried++;
              try {
                const r = await withHardTimeout(
                  target.tester.credentialTester({
                    host: targetHost(target), port: target.endpoint.port,
                    username: u, password: p, timeoutMs,
                  }),
                  attemptTimeoutMs,
                  'credential_attempt_timeout',
                );
                if (r.success) {
                  hit = true;
                  const unauth = !u && !p;
                  queue.push(findingResult(ctx, target, credentialFinding(target, u, p, r.banner || r.message, unauth, r.message)));
                  if (stopOnFirst) break outer;
                } else {
                  recordFailure(failures, samples, r.message);
                }
              } catch (err: any) {
                // 单次 tester 异常不影响后续凭据尝试。
                recordFailure(failures, samples, err?.message || String(err));
              }
              if (delayMs > 0) await sleep(delayMs);
            }
          }
        }

        queue.push({
          id: '', runId: ctx.run.id, moduleId: definition.id,
          assetId: target.endpoint.assetId,
          endpointId: target.endpoint.id,
          serviceId: target.service?.id,
          resultType: 'log',
          data: {
            tester: target.tester.id,
            target: `${targetHost(target)}:${target.endpoint.port}`,
            tried, hit, matchedBy: target.matchedBy,
            selectionReason: target.selectionReason,
            checks,
            failures,
            failureSamples: samples,
          },
          createdAt: new Date().toISOString(),
        });
      }
    };

    const pool = Array.from({ length: Math.min(workers, targets.length) }, () => worker());
    Promise.allSettled(pool).then(settled => {
      const failed = settled.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      queue.close(failed?.reason);
    });

    for await (const r of queue) yield r;
  }
}

function normalizeProfiles(cfg: Record<string, unknown>): AuthProfile[] {
  if (Array.isArray(cfg.authProfiles)) return mergeDefaultProfiles(cfg.authProfiles as AuthProfile[]);
  if (Array.isArray(cfg.dbs)) {
    const legacy = cfg.dbs as AuthProfile[];
    const hasFtp = legacy.some(p => p.name === 'ftp');
    return mergeDefaultProfiles(hasFtp ? legacy : [...legacy, DEFAULT_AUTH_PROFILES.find(p => p.name === 'ftp')!]);
  }
  return DEFAULT_AUTH_PROFILES;
}

function mergeDefaultProfiles(profiles: AuthProfile[]): AuthProfile[] {
  const byName = new Map(profiles.map(p => [p.name, p]));
  const merged = profiles.map(p => {
    const defaults = DEFAULT_AUTH_PROFILES.find(d => d.name === p.name);
    if (!defaults) return p;
    return {
      ...defaults,
      ...p,
      ports: p.ports?.length ? p.ports : defaults.ports,
      fingerprintProducts: p.fingerprintProducts?.length ? p.fingerprintProducts : defaults.fingerprintProducts,
      checks: { ...(defaults.checks || {}), ...(p.checks || {}) },
    };
  });
  for (const defaults of DEFAULT_AUTH_PROFILES) {
    if (!byName.has(defaults.name)) merged.push(defaults);
  }
  return merged;
}

function targetHost(target: AuthTarget): string {
  return target.endpoint.host || target.endpoint.ip;
}

function credentialFinding(target: AuthTarget, username: string, password: string, evidence?: string, unauth = false, message?: string): AuthFindingDraft {
  const label = target.tester.name || target.tester.id.toUpperCase();
  const host = targetHost(target);
  const capability = unauth ? unauthCapability(target.tester.id, message) : undefined;
  return {
    type: unauth ? (capability?.type || 'unauth') : 'weak_password',
    severity: unauth ? (capability?.severity || 'high') : 'critical',
    title: unauth
      ? `${label} ${capability?.title || '未授权访问'} ${host}:${target.endpoint.port}`
      : `${label} 弱口令 ${host}:${target.endpoint.port}`,
    description: unauth
      ? (capability?.description || `${label} 未启用认证且已验证到可读/可操作能力。`)
      : `${label} 存在弱口令，命中账号 ${username || '(empty)'}，密码 ${password || '(empty)'}。`,
    evidence,
    recommendation: unauth
      ? '启用身份认证，限制访问来源 IP。'
      : '修改为强密码（12+ 位，含大小写/数字/符号），禁止常见弱口令。',
    dedupeKey: `${unauth ? 'unauth' : 'weak_password'}:${target.tester.id}:${host}:${target.endpoint.port}`,
    credentials: { username, password, passwordMasked: maskPassword(password), passwordEmpty: password === '' },
  };
}

function unauthCapability(testerId: string, message?: string): Pick<AuthFindingDraft, 'type' | 'severity' | 'title' | 'description'> | undefined {
  const msg = message || '';
  if (testerId === 'kafka') {
    if (msg.includes('kafka_business_message_read')) {
      return {
        type: 'unauth',
        severity: 'critical',
        title: '业务消息未授权读取',
        description: 'Kafka 未启用有效认证/授权，扫描端已可无认证读取业务 topic 消息，存在生产数据泄露风险。',
      };
    }
    if (msg.includes('kafka_internal_topic_read')) {
      return {
        type: 'auth_exposure',
        severity: 'high',
        title: '内部配置/状态 Topic 未授权读取',
        description: 'Kafka 未启用有效认证/授权，扫描端已可读取 Connect/MirrorMaker 等内部 topic，存在数据链路配置、拓扑和运行状态泄露风险。',
      };
    }
    if (msg.includes('kafka_message_read_unclassified') || msg.includes('kafka_message_read')) {
      return {
        type: 'auth_exposure',
        severity: 'high',
        title: '消息 Topic 未授权读取',
        description: 'Kafka 未启用有效认证/授权，扫描端已可读取 topic 消息字节，但尚未确认内容是否属于敏感业务数据。',
      };
    }
    return {
      type: 'auth_exposure',
      severity: 'medium',
      title: '元数据未授权读取',
      description: 'Kafka 元数据可被无认证读取。该能力暴露集群拓扑/Topic 信息，但尚未证明可读取消息数据。',
    };
  }
  if (testerId === 'zookeeper') {
    if (msg.includes('zookeeper_znode_data_read')) {
      return {
        type: 'unauth',
        severity: 'critical',
        title: 'znode 数据未授权读取',
        description: 'ZooKeeper 未启用有效 ACL，扫描端已可无认证读取非空 znode 数据，存在配置/注册数据泄露风险。',
      };
    }
    if (msg.includes('zookeeper_znode_enum')) {
      return {
        type: 'auth_exposure',
        severity: 'high',
        title: 'znode 未授权枚举',
        description: 'ZooKeeper 未启用有效 ACL，扫描端已可无认证枚举 znode 树，可能泄露服务注册、接口名和内部架构信息。',
      };
    }
    if (msg.includes('zookeeper_four_letter_info')) {
      return {
        type: 'auth_exposure',
        severity: 'medium',
        title: '管理信息未授权读取',
        description: 'ZooKeeper four-letter 管理命令暴露，可读取运行配置、环境路径、版本等机器/服务敏感信息。',
      };
    }
  }
  if (testerId === 'memcached' && msg.includes('memcached_data_read')) {
    return {
      type: 'unauth',
      severity: 'critical',
      title: '缓存数据未授权读取',
      description: 'Memcached 未启用有效访问控制，扫描端已可读取缓存 key/value 数据，存在生产数据泄露风险。',
    };
  }
  if (testerId === 'etcd') {
    return {
      type: 'unauth',
      severity: 'critical',
      title: '键值数据未授权读取',
      description: 'etcd 键值接口可无认证读取，可能泄露服务配置、密钥或注册数据。',
    };
  }
  if (testerId === 'aerospike' && msg.includes('aerospike_info_read')) {
    return {
      type: 'auth_exposure',
      severity: 'high',
      title: '管理信息未授权读取',
      description: 'Aerospike info 接口可无认证读取版本、节点或服务信息，默认无认证部署存在典型横向移动和数据面暴露风险。',
    };
  }
  if (testerId === 'kubelet') {
    if (msg.includes('kubelet_pods_read')) {
      return {
        type: 'unauth',
        severity: 'critical',
        title: 'Pod 列表未授权读取',
        description: 'Kubelet /pods 可无认证读取，扫描端已验证可获取 Pod/容器信息，可能进一步暴露业务拓扑、环境变量或挂载信息。',
      };
    }
    if (msg.includes('kubelet_stats_read')) {
      return {
        type: 'auth_exposure',
        severity: 'high',
        title: '节点/Pod 统计未授权读取',
        description: 'Kubelet /stats/summary 可无认证读取，暴露节点、Pod 与容器运行状态信息。',
      };
    }
    if (msg.includes('kubelet_metrics_read')) {
      return {
        type: 'auth_exposure',
        severity: 'medium',
        title: '指标未授权读取',
        description: 'Kubelet /metrics 可无认证读取，暴露节点与容器运行指标。',
      };
    }
  }
  if (testerId === 'kafka-connect') {
    if (msg.includes('kafka_connect_config_read')) {
      return {
        type: 'auth_exposure',
        severity: 'high',
        title: 'Connector 配置未授权读取',
        description: 'Kafka Connect REST 未启用有效认证，扫描端已可读取 connector 配置键，可能泄露数据链路、topic、库表或连接端点信息。',
      };
    }
    return {
      type: 'auth_exposure',
      severity: 'medium',
      title: 'Connector 列表未授权读取',
      description: 'Kafka Connect REST 未启用有效认证，扫描端已可读取 connector 列表。',
    };
  }
  if (testerId === 'prometheus') {
    return {
      type: 'auth_exposure',
      severity: msg.includes('prometheus_config_read') ? 'high' : 'medium',
      title: msg.includes('prometheus_config_read') ? '监控配置未授权读取' : '监控目标未授权读取',
      description: 'Prometheus API 未启用有效认证，扫描端已可读取监控目标或配置，可能暴露内部服务拓扑。',
    };
  }
  if (testerId === 'flink') {
    return {
      type: 'auth_exposure',
      severity: 'high',
      title: 'Flink 作业信息未授权读取',
      description: 'Flink Dashboard/API 未启用有效认证，扫描端已可读取集群概览或作业信息。',
    };
  }
  if (testerId === 'grafana') {
    return {
      type: 'auth_exposure',
      severity: 'medium',
      title: 'Grafana 匿名访问',
      description: 'Grafana API 允许匿名读取搜索结果，可能暴露看板、数据源名称或监控入口。',
    };
  }
  if (testerId === 'nacos') {
    return {
      type: 'auth_exposure',
      severity: 'high',
      title: '服务注册信息未授权读取',
      description: 'Nacos API 未启用有效认证，扫描端已可读取服务列表，可能暴露服务注册和内部拓扑。',
    };
  }
  if (testerId === 'argocd') {
    return {
      type: 'auth_exposure',
      severity: 'high',
      title: '应用列表未授权读取',
      description: 'Argo CD API 未启用有效认证，扫描端已可读取应用列表，可能暴露发布项目与集群信息。',
    };
  }
  if (testerId === 'superset') {
    return {
      type: 'auth_exposure',
      severity: 'medium',
      title: 'BI 看板列表未授权读取',
      description: 'Superset API 未启用有效认证，扫描端已可读取看板列表，可能暴露报表资产。',
    };
  }
  if (testerId === 'minio') {
    return {
      type: 'auth_exposure',
      severity: 'high',
      title: 'Bucket 列表未授权读取',
      description: 'MinIO/S3 API 未启用有效认证，扫描端已可列出 bucket，存在对象存储数据暴露风险。',
    };
  }
  return undefined;
}

function findingResult(ctx: ModuleContext, target: AuthTarget, draft: AuthFindingDraft): Result {
  return {
    id: '', runId: ctx.run.id, moduleId: definition.id,
    assetId: target.endpoint.assetId,
    endpointId: target.endpoint.id,
    serviceId: target.service?.id,
    resultType: 'finding',
    data: {
      ...draft,
      tester: target.tester.id,
      matchedBy: target.matchedBy,
    },
    createdAt: new Date().toISOString(),
  };
}

function maskPassword(password: string): string {
  if (!password) return '(empty)';
  if (password.length <= 2) return '*'.repeat(password.length);
  return `${password[0]}${'*'.repeat(Math.min(password.length - 2, 6))}${password[password.length - 1]}`;
}

async function withHardTimeout<T extends { success: boolean; message?: string }>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve({ success: false, message } as T), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordFailure(failures: Record<string, number>, samples: Record<string, string>, message?: string) {
  const category = failureCategory(message);
  failures[category] = (failures[category] || 0) + 1;
  if (message && !samples[category]) samples[category] = String(message).slice(0, 200);
}

function failureCategory(message?: string): string {
  const msg = String(message || '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg === 'auth_failed' || /access denied|authentication failed|bad credentials|wrongpass|not authorized|requires authentication/.test(msg)) return 'auth_failed';
  if (/timeout|etimedout|operation timed out/.test(msg)) return 'timeout';
  if (/econnrefused|connection refused/.test(msg)) return 'connection_refused';
  if (/enotfound|eai_again|getaddrinfo|dns/.test(msg)) return 'dns_error';
  if (/econnreset|socket hang up|connection lost|closed/.test(msg)) return 'connection_reset';
  if (/protocol|packet|handshake|not_redis|unknown command|not supported auth|malformed/.test(msg)) return 'protocol_error';
  return 'other_error';
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export { AUTH_TESTERS };

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
