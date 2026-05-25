import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import type { Tester, TesterResult } from './types.js';

type Scheme = 'http' | 'https';

interface HttpResult {
  scheme: Scheme;
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  error?: string;
}

function schemeOrder(port: number, preferred?: Scheme): Scheme[] {
  if (preferred) return [preferred, preferred === 'https' ? 'http' : 'https'];
  if ([443, 8443, 9443, 10250].includes(port)) return ['https', 'http'];
  return ['http', 'https'];
}

function httpRequest(opts: {
  host: string;
  port: number;
  scheme: Scheme;
  path: string;
  timeoutMs: number;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise(resolve => {
    const mod = opts.scheme === 'https' ? https : http;
    const headers: Record<string, string> = {
      'User-Agent': 'SASP-Scanner',
      Accept: 'application/json,text/plain,*/*',
      ...(opts.headers || {}),
    };
    if (opts.body !== undefined && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(opts.body).toString();
    const req = mod.request({
      host: opts.host,
      port: opts.port,
      path: opts.path,
      method: opts.method || 'GET',
      timeout: opts.timeoutMs,
      rejectUnauthorized: false,
      headers,
    } as any, res => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total <= 256 * 1024) chunks.push(c);
      });
      res.on('end', () => resolve({
        scheme: opts.scheme,
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', e => resolve({
        scheme: opts.scheme,
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        error: String(e.message || e).slice(0, 160),
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ scheme: opts.scheme, status: 0, headers: {}, body: '', error: 'timeout' });
    });
    req.on('error', e => resolve({ scheme: opts.scheme, status: 0, headers: {}, body: '', error: String(e.message || e).slice(0, 160) }));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function firstHttp(opts: Omit<Parameters<typeof httpRequest>[0], 'scheme'> & { preferred?: Scheme }): Promise<HttpResult> {
  let last: HttpResult | undefined;
  for (const scheme of schemeOrder(opts.port, opts.preferred)) {
    const res = await httpRequest({ ...opts, scheme });
    if (res.status > 0) return res;
    last = res;
  }
  return last || { scheme: opts.preferred || 'http', status: 0, headers: {}, body: '', error: 'connect_failed' };
}

function tryJson<T = any>(body: string): T | undefined {
  try { return JSON.parse(body) as T; } catch { return undefined; }
}

function authFailed(status: number) {
  return status === 401 || status === 403;
}

function okJson(res: HttpResult) {
  return res.status >= 200 && res.status < 300 && !!tryJson(res.body);
}

function summarizeJson(value: unknown, max = 220): string {
  return JSON.stringify(value).slice(0, max);
}

function credentialUnsupported(username: string, password: string): TesterResult | undefined {
  return username || password ? { success: false, message: 'credential_not_supported' } : undefined;
}

export const testKubelet: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const unsupported = credentialUnsupported(username, password);
  if (unsupported) return unsupported;

  let sawAuth = false;
  let sawHealth = false;
  for (const scheme of schemeOrder(port, port === 10255 ? 'http' : port === 10250 ? 'https' : undefined)) {
    for (const path of ['/pods', '/stats/summary', '/metrics', '/healthz']) {
      const res = await httpRequest({ host, port, scheme, path, timeoutMs });
      if (authFailed(res.status)) {
        sawAuth = true;
        continue;
      }
      if (res.status !== 200) continue;
      if (path === '/pods') {
        const json = tryJson<any>(res.body);
        if (Array.isArray(json?.items) && (json.items[0]?.metadata || json.items[0]?.spec?.containers)) {
          return { success: true, message: 'kubelet_pods_read', banner: `${scheme} /pods items=${json.items.length}` };
        }
      } else if (path === '/stats/summary') {
        const json = tryJson<any>(res.body);
        if (json?.node && Array.isArray(json?.pods)) {
          return { success: true, message: 'kubelet_stats_read', banner: `${scheme} /stats/summary pods=${json.pods.length}` };
        }
      } else if (path === '/metrics') {
        if (/(^|\n)#\s*(HELP|TYPE)\s+|kubelet_|container_|apiserver_/i.test(res.body)) {
          return { success: true, message: 'kubelet_metrics_read', banner: `${scheme} /metrics ${res.body.slice(0, 220)}` };
        }
      } else if (res.body.trim() === 'ok') {
        sawHealth = true;
      }
    }
  }
  return { success: false, message: sawAuth ? 'auth_failed' : sawHealth ? 'kubelet_healthz_only' : 'kubelet_no_readable_endpoint' };
};

export const testPrometheus: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const unsupported = credentialUnsupported(username, password);
  if (unsupported) return unsupported;
  const targets = await firstHttp({ host, port, path: '/api/v1/targets', timeoutMs });
  if (authFailed(targets.status)) return { success: false, message: 'auth_failed' };
  const json = tryJson<any>(targets.body);
  if (targets.status === 200 && json?.status === 'success' && Array.isArray(json?.data?.activeTargets)) {
    return { success: true, message: 'prometheus_targets_read', banner: `targets=${json.data.activeTargets.length}` };
  }
  const config = await firstHttp({ host, port, path: '/api/v1/status/config', timeoutMs, preferred: targets.scheme });
  const cfg = tryJson<any>(config.body);
  if (config.status === 200 && cfg?.status === 'success' && cfg?.data?.yaml) {
    return { success: true, message: 'prometheus_config_read', banner: `configBytes=${String(cfg.data.yaml).length}` };
  }
  return { success: false, message: `http_${targets.status || config.status || 0}` };
};

export const testFlink: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const unsupported = credentialUnsupported(username, password);
  if (unsupported) return unsupported;
  const res = await firstHttp({ host, port, path: '/overview', timeoutMs });
  if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
  const json = tryJson<any>(res.body);
  if (res.status === 200 && (json?.taskmanagers !== undefined || json?.slotsTotal !== undefined || json?.jobs !== undefined)) {
    return { success: true, message: 'flink_overview_read', banner: summarizeJson(json) };
  }
  const jobs = await firstHttp({ host, port, path: '/jobs/overview', timeoutMs, preferred: res.scheme });
  const jobsJson = tryJson<any>(jobs.body);
  if (jobs.status === 200 && Array.isArray(jobsJson?.jobs)) {
    return { success: true, message: 'flink_jobs_read', banner: `jobs=${jobsJson.jobs.length}` };
  }
  return { success: false, message: `http_${res.status || jobs.status || 0}` };
};

export const testKafkaConnect: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const unsupported = credentialUnsupported(username, password);
  if (unsupported) return unsupported;
  const list = await firstHttp({ host, port, path: '/connectors', timeoutMs });
  if (authFailed(list.status)) return { success: false, message: 'auth_failed' };
  const connectors = tryJson<any>(list.body);
  if (list.status === 200 && Array.isArray(connectors)) {
    const names = connectors.map(String).filter(Boolean);
    if (names.length > 0) {
      const name = encodeURIComponent(names[0]);
      const cfg = await firstHttp({ host, port, path: `/connectors/${name}/config`, timeoutMs, preferred: list.scheme });
      const cfgJson = tryJson<Record<string, unknown>>(cfg.body);
      if (cfg.status === 200 && cfgJson && Object.keys(cfgJson).length > 0) {
        const keys = Object.keys(cfgJson).filter(k => !/password|secret|token|key/i.test(k)).slice(0, 12).join(',');
        return { success: true, message: 'kafka_connect_config_read', banner: `connectors=${names.slice(0, 8).join(',')} configKeys=${keys}` };
      }
    }
    return { success: true, message: 'kafka_connect_connector_list_read', banner: `connectors=${names.length}${names.length ? ` ${names.slice(0, 8).join(',')}` : ''}` };
  }
  return { success: false, message: `http_${list.status || 0}` };
};

export const testGrafana: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) {
    const res = await firstHttp({ host, port, path: '/api/search?limit=1', timeoutMs });
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
    const json = tryJson<any>(res.body);
    if (res.status === 200 && Array.isArray(json)) {
      return { success: true, message: 'grafana_anonymous_search', banner: `searchItems=${json.length}` };
    }
    return { success: false, message: `http_${res.status || 0}` };
  }
  const body = JSON.stringify({ user: username, email: '', password });
  const res = await firstHttp({
    host, port, path: '/login', timeoutMs, method: 'POST', body,
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = String(res.headers['set-cookie'] || '');
  if (res.status === 200 && (/grafana_session/i.test(setCookie) || /Logged in|User logged in/i.test(res.body))) {
    return { success: true, message: 'grafana_login_success', banner: `status=${res.status}` };
  }
  return { success: false, message: authFailed(res.status) ? 'auth_failed' : `http_${res.status || 0}` };
};

export const testNacos: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) {
    const res = await firstHttp({ host, port, path: '/nacos/v1/ns/service/list?pageNo=1&pageSize=1', timeoutMs });
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
    const json = tryJson<any>(res.body);
    if (res.status === 200 && (Array.isArray(json?.doms) || typeof json?.count === 'number')) {
      return { success: true, message: 'nacos_service_list_read', banner: summarizeJson(json) };
    }
    return { success: false, message: `http_${res.status || 0}` };
  }
  const form = new URLSearchParams({ username, password }).toString();
  const res = await firstHttp({
    host, port, path: '/nacos/v1/auth/users/login', timeoutMs, method: 'POST', body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const json = tryJson<any>(res.body);
  if (res.status === 200 && (json?.accessToken || json?.globalAdmin !== undefined)) {
    return { success: true, message: 'nacos_login_success', banner: `globalAdmin=${json?.globalAdmin}` };
  }
  return { success: false, message: authFailed(res.status) ? 'auth_failed' : `http_${res.status || 0}` };
};

export const testArgoCd: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) {
    const res = await firstHttp({ host, port, path: '/api/v1/applications?fields=items.metadata.name', timeoutMs });
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
    const json = tryJson<any>(res.body);
    if (res.status === 200 && Array.isArray(json?.items)) {
      return { success: true, message: 'argocd_applications_read', banner: `applications=${json.items.length}` };
    }
    return { success: false, message: `http_${res.status || 0}` };
  }
  const res = await firstHttp({
    host, port, path: '/api/v1/session', timeoutMs, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = tryJson<any>(res.body);
  if (res.status === 200 && typeof json?.token === 'string' && json.token.length > 20) {
    return { success: true, message: 'argocd_login_success', banner: 'session token issued' };
  }
  return { success: false, message: authFailed(res.status) ? 'auth_failed' : `http_${res.status || 0}` };
};

export const testSuperset: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) {
    const res = await firstHttp({ host, port, path: '/api/v1/dashboard/?page_size=1', timeoutMs });
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
    const json = tryJson<any>(res.body);
    if (res.status === 200 && (Array.isArray(json?.result) || Array.isArray(json?.result?.result))) {
      return { success: true, message: 'superset_dashboard_list_read', banner: summarizeJson(json?.result) };
    }
    return { success: false, message: `http_${res.status || 0}` };
  }
  const res = await firstHttp({
    host, port, path: '/api/v1/security/login', timeoutMs, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, provider: 'db', refresh: true }),
  });
  const json = tryJson<any>(res.body);
  if (res.status === 200 && typeof json?.access_token === 'string') {
    return { success: true, message: 'superset_login_success', banner: 'access_token issued' };
  }
  return { success: false, message: authFailed(res.status) ? 'auth_failed' : `http_${res.status || 0}` };
};

export const testZabbix: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) return { success: false, message: 'credential_required' };
  const payloads = [
    { jsonrpc: '2.0', method: 'user.login', params: { user: username, password }, id: 1 },
    { jsonrpc: '2.0', method: 'user.login', params: { username, password }, id: 1 },
  ];
  for (const payload of payloads) {
    const res = await firstHttp({
      host, port, path: '/api_jsonrpc.php', timeoutMs, method: 'POST',
      headers: { 'Content-Type': 'application/json-rpc' },
      body: JSON.stringify(payload),
    });
    const json = tryJson<any>(res.body);
    if (res.status === 200 && typeof json?.result === 'string' && json.result.length > 8) {
      return { success: true, message: 'zabbix_login_success', banner: 'auth token issued' };
    }
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
  }
  return { success: false, message: 'auth_failed' };
};

function hmac(key: Buffer | string, data: string) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function minioSignedHeaders(host: string, port: number, accessKey: string, secretKey: string) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const region = 'us-east-1';
  const payloadHash = crypto.createHash('sha256').update('').digest('hex');
  const hostHeader = `${host}:${port}`;
  const canonicalHeaders = `host:${hostHeader}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    Host: hostHeader,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export const testMinio: Tester = async ({ host, port, username, password, timeoutMs }) => {
  if (!username && !password) {
    const res = await firstHttp({ host, port, path: '/', timeoutMs });
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
    if (res.status === 200 && /ListAllMyBucketsResult|<Buckets>|<Owner>/i.test(res.body)) {
      return { success: true, message: 'minio_anonymous_bucket_list', banner: res.body.slice(0, 220) };
    }
    return { success: false, message: `http_${res.status || 0}` };
  }
  for (const scheme of schemeOrder(port)) {
    const res = await httpRequest({
      host, port, scheme, path: '/', timeoutMs,
      headers: minioSignedHeaders(host, port, username, password),
    });
    if (res.status === 200 && /ListAllMyBucketsResult|<Buckets>|<Owner>/i.test(res.body)) {
      return { success: true, message: 'minio_login_success', banner: res.body.slice(0, 220) };
    }
    if (authFailed(res.status)) return { success: false, message: 'auth_failed' };
  }
  return { success: false, message: 'connect_failed' };
};
