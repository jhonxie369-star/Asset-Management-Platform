import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import type { Asset, ModuleDefinition, Result, ServiceProtocol } from '@sasp/shared';
import type { IModule, ModuleContext } from '../engine/module-interface.js';

const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
  mongodb: 27017,
  elasticsearch: 9200,
};

const PORT_PROTOCOL: Record<number, ServiceProtocol> = {
  3306: 'mysql',
  3307: 'mysql',
  3308: 'mysql',
  5432: 'postgres',
  5433: 'postgres',
  6379: 'redis',
  6380: 'redis',
  27017: 'mongodb',
  27018: 'mongodb',
  9200: 'elasticsearch',
};

const definition: ModuleDefinition = {
  id: 'db-endpoint-probe',
  name: '数据库端点探测',
  category: 'recon',
  targetType: 'asset',
  riskLevel: 'safe_active',
  description: '面向 RDS/云数据库域名 endpoint：DNS 解析 + 指定端口连通性 + 协议画像沉淀。',
  configSchema: {
    timeoutMs: { type: 'number', default: 3000 },
    workers: { type: 'number', default: 80 },
    includeIpAssets: { type: 'boolean', default: false, description: '默认只处理 domain/db_endpoint 资产' },
  },
};

function isIp(value: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value);
}

function inferProtocol(asset: Asset, port: number): ServiceProtocol {
  if (asset.endpointProtocol) return asset.endpointProtocol;
  const product = (asset.cloudProduct || '').toLowerCase();
  if (product === 'rds' && [3306, 3307, 3308].includes(port)) return 'mysql';
  if (product in DEFAULT_PORTS) return product as ServiceProtocol;
  return PORT_PROTOCOL[port] || 'tcp';
}

function inferPort(asset: Asset): number | undefined {
  if (asset.endpointPort) return asset.endpointPort;
  if (asset.endpointProtocol && DEFAULT_PORTS[asset.endpointProtocol]) return DEFAULT_PORTS[asset.endpointProtocol];
  if (asset.cloudProduct && DEFAULT_PORTS[asset.cloudProduct]) return DEFAULT_PORTS[asset.cloudProduct];
  return undefined;
}

async function resolveHost(host: string): Promise<string[]> {
  if (isIp(host)) return [host];
  try {
    const records = await dns.lookup(host, { all: true, family: 0 });
    return [...new Set(records.map(r => r.address))];
  } catch {
    return [];
  }
}

function connect(host: string, port: number, timeoutMs: number): Promise<{
  open: boolean;
  banner?: string;
  reason?: 'timeout' | 'connection_refused' | 'network_unreachable' | 'host_unreachable' | 'dns_error' | 'connection_reset' | 'socket_error';
  errorCode?: string;
  errorMessage?: string;
  elapsedMs: number;
}> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let banner = '';
    let done = false;
    const startedAt = Date.now();
    const finish = (open: boolean, extra: Partial<Awaited<ReturnType<typeof connect>>> = {}) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ open, banner: banner.slice(0, 512) || undefined, elapsedMs: Date.now() - startedAt, ...extra });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      // Redis 等可通过轻量探针增加 banner 信号；其他 DB 多数会主动握手或保持静默。
      if (port === 6379 || port === 6380) sock.write('*1\r\n$4\r\nPING\r\n');
      setTimeout(() => finish(true), 350);
    });
    sock.on('data', d => { banner += d.toString('utf8'); });
    sock.on('timeout', () => finish(false, { reason: 'timeout', errorCode: 'ETIMEDOUT', errorMessage: `connect timeout after ${timeoutMs}ms` }));
    sock.on('error', (err: any) => {
      const code = String(err?.code || 'SOCKET_ERROR');
      const reason = code === 'ECONNREFUSED' ? 'connection_refused'
        : code === 'ENETUNREACH' ? 'network_unreachable'
          : code === 'EHOSTUNREACH' ? 'host_unreachable'
            : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns_error'
              : code === 'ECONNRESET' ? 'connection_reset'
                : 'socket_error';
      finish(false, { reason, errorCode: code, errorMessage: String(err?.message || code).slice(0, 200) });
    });
    sock.connect(port, host);
  });
}

function productFor(protocol: ServiceProtocol): string | undefined {
  const map: Partial<Record<ServiceProtocol, string>> = {
    mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch',
  };
  return map[protocol];
}

export class DbEndpointProbeModule implements IModule {
  definition = definition;

  async *execute(ctx: ModuleContext): AsyncGenerator<Result> {
    const timeoutMs = (ctx.config.timeoutMs as number) || 3000;
    const workers = Math.max(1, Math.min((ctx.config.workers as number) || 80, 300));
    const includeIpAssets = (ctx.config.includeIpAssets as boolean) || false;

    const targets = ctx.assets
      .map(asset => ({ asset, host: asset.address || asset.ip, port: inferPort(asset) }))
      .filter(t => t.host && t.port && (includeIpAssets || t.asset.assetKind === 'domain' || t.asset.assetKind === 'db_endpoint')) as Array<{ asset: Asset; host: string; port: number }>;

    const results: Result[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const target = targets[idx++];
        const resolvedIps = await resolveHost(target.host);
        const probe = await connect(target.host, target.port, timeoutMs);
        const protocol = inferProtocol(target.asset, target.port);
        if (probe.open) {
          const product = productFor(protocol);
          results.push({
            id: '',
            runId: ctx.run.id,
            moduleId: definition.id,
            assetId: target.asset.id,
            resultType: 'endpoint_alive',
            data: {
              ip: target.host,
              host: target.host,
              resolvedIp: resolvedIps[0],
              resolvedIps,
              port: target.port,
              protocol,
              product,
              title: `${product || protocol} endpoint`,
              banner: probe.banner,
              probeElapsedMs: probe.elapsedMs,
              fingerprint: product ? { name: product, confidence: 80, source: 'db-endpoint-probe' } : undefined,
            },
            evidence: JSON.stringify({ host: target.host, resolvedIps, port: target.port, protocol }),
            createdAt: new Date().toISOString(),
          });
        } else {
          results.push({
            id: '', runId: ctx.run.id, moduleId: definition.id, assetId: target.asset.id,
            resultType: 'log',
            data: {
              host: target.host,
              resolvedIps,
              port: target.port,
              open: false,
              reason: probe.reason || 'connect_failed',
              errorCode: probe.errorCode,
              errorMessage: probe.errorMessage,
              probeElapsedMs: probe.elapsedMs,
            },
            createdAt: new Date().toISOString(),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(workers, targets.length) }, () => worker()));
    for (const r of results) yield r;
  }
}
