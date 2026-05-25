import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { LiveEndpoint } from '@sasp/shared';

export interface ProbeSignals {
  banner?: string;           // TCP 首包（可能已由 port-discovery 抓到）
  protocol?: string;          // 初步协议：http/https/ssh/mysql/...
  httpStatus?: number;
  headers?: Record<string, string>;
  body?: string;              // 限 64KB
  title?: string;
  faviconHash?: number;       // FOFA mmh3 hash
  tlsSubject?: string;
  tlsIssuer?: string;
  tlsSan?: string[];
  /** 采集期间耗时追踪 */
  timings: Record<string, number>;
}

const UA = 'Mozilla/5.0 (SASP-Scanner)';
const MAX_BODY = 64 * 1024;

// ── HTTP / HTTPS 探测 ────────────────────────────────────────────────
export function probeHttp(
  ep: LiveEndpoint,
  scheme: 'http' | 'https',
  timeoutMs: number,
  path = '/',
): Promise<Partial<ProbeSignals>> {
  return new Promise(resolve => {
    const mod = scheme === 'https' ? https : http;
    const startedAt = Date.now();
    const out: Partial<ProbeSignals> = { timings: {} };
    const req = mod.get(
      {
        host: ep.ip,
        port: ep.port,
        path,
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      },
      res => {
        const chunks: Buffer[] = [];
        let size = 0;
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          const body = Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY);
          const titleMatch = body.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
          out.protocol = scheme;
          out.httpStatus = res.statusCode;
          out.headers = normalizeHeaders(res.headers);
          out.body = body;
          out.title = titleMatch ? titleMatch[1].trim() : undefined;
          if (scheme === 'https') {
            const sock = (res.socket as tls.TLSSocket);
            const cert = sock?.getPeerCertificate?.(false);
            if (cert && cert.subject) {
              out.tlsSubject = Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(',');
              out.tlsIssuer = cert.issuer ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join(',') : undefined;
              out.tlsSan = (cert as any).subjectaltname ? String((cert as any).subjectaltname).split(',').map(s => s.trim()) : undefined;
            }
          }
          out.timings![`${scheme}Probe`] = Date.now() - startedAt;
          resolve(out);
        };
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
          if (size >= MAX_BODY) {
            finish();
            req.destroy();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('aborted', finish);
        res.on('error', () => { if (!resolved) { out.timings![`${scheme}Probe`] = Date.now() - startedAt; resolve(out); } });
      },
    );
    req.on('timeout', () => { req.destroy(); out.timings![`${scheme}Probe`] = Date.now() - startedAt; resolve(out); });
    req.on('error', () => { out.timings![`${scheme}Probe`] = Date.now() - startedAt; resolve(out); });
  });
}

function normalizeHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in h) {
    const v = h[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

// ── favicon 拉取 ─────────────────────────────────────────────────────
const faviconCache = new Map<string, number>();

export function fetchFavicon(
  ep: LiveEndpoint,
  scheme: 'http' | 'https',
  timeoutMs: number,
  path = '/favicon.ico',
): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const mod = scheme === 'https' ? https : http;
    const req = mod.get(
      {
        host: ep.ip, port: ep.port, path,
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { 'User-Agent': UA },
      },
      res => {
        if (res.statusCode !== 200) { res.resume(); resolve(undefined); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size <= 128 * 1024) chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.on('error', () => resolve(undefined));
  });
}

export function getCachedFaviconHash(key: string): number | undefined {
  return faviconCache.get(key);
}

export function setCachedFaviconHash(key: string, hash: number) {
  if (faviconCache.size > 500) faviconCache.clear();
  faviconCache.set(key, hash);
}

// ── TCP banner 探测（被动：短连接抓首包；支持发探针） ──────────────
export function probeTcpBanner(
  ip: string,
  port: number,
  timeoutMs: number,
  probe?: Buffer,
): Promise<string | undefined> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(buf.length ? buf.toString('utf8').slice(0, 1024) : undefined);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      if (probe) sock.write(probe);
      setTimeout(done, 400);
    });
    sock.on('data', (d: Buffer) => { buf = Buffer.concat([buf, d]).slice(0, 2048); });
    sock.on('timeout', done);
    sock.on('error', done);
    sock.connect(port, ip);
  });
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

function kafkaString(value: string): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([int16(body.length), body]);
}

function kafkaRequest(apiKey: number, apiVersion: number, correlationId: number, body?: Uint8Array): Buffer {
  const payload = Buffer.concat([
    int16(apiKey),
    int16(apiVersion),
    int32(correlationId),
    kafkaString('sasp'),
    Buffer.from(body || new Uint8Array()),
  ]);
  return Buffer.concat([int32(payload.length), payload]);
}

export function probeKafkaMetadata(ip: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const correlationId = 0x53415350; // "SASP"
    let buf = Buffer.alloc(0);
    let resolved = false;
    const done = (banner?: string) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(banner);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      // MetadataRequest v0, empty topic list. A valid response is enough for fingerprinting a plaintext Kafka broker.
      sock.write(kafkaRequest(3, 0, correlationId, int32(0)));
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]).slice(0, 1024 * 1024);
      if (buf.length < 12) return;
      const frameLen = buf.readInt32BE(0);
      if (frameLen <= 0 || frameLen > 1024 * 1024 || buf.length < frameLen + 4) return done();
      const corr = buf.readInt32BE(4);
      if (corr !== correlationId) return done();
      const brokerCount = buf.readInt32BE(8);
      if (brokerCount >= 0 && brokerCount < 100000) return done(`Kafka Metadata brokers=${brokerCount}`);
      done();
    });
    sock.on('timeout', () => done());
    sock.on('error', () => done());
    sock.connect(port, ip);
  });
}

/** Redis 探针：INFO\r\n */
export const REDIS_PROBE = Buffer.from('*1\r\n$4\r\nINFO\r\n');
/** Memcached 探针 */
export const MEMCACHED_PROBE = Buffer.from('version\r\n');
/** Zookeeper 四字命令 */
export const ZOOKEEPER_PROBE = Buffer.from('stat');
/** Aerospike info 协议：请求 build，可返回 build\t<version> */
export const AEROSPIKE_INFO_PROBE = Buffer.concat([
  Buffer.from([0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06]),
  Buffer.from('build\n'),
]);
