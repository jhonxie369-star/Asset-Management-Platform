import * as http from 'http';
import * as https from 'https';
import type { Tester } from './types.js';

/** HTTP basic auth tester 工厂 */
export function httpBasicAuth(opts: {
  scheme?: 'http' | 'https';
  path: string;
  successCheck: (status: number, body: string) => boolean;
  authFailedCheck?: (status: number, body: string) => boolean;
}): Tester {
  return ({ host, port, username, password, timeoutMs }) => new Promise(resolve => {
    const scheme = opts.scheme || 'http';
    const mod = scheme === 'https' ? https : http;
    const headers: Record<string, string> = { 'User-Agent': 'SASP-Scanner' };
    if (username || password) {
      headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    const req = mod.get({
      host, port, path: opts.path, timeout: timeoutMs,
      rejectUnauthorized: false, headers,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 4096);
        if (opts.successCheck(res.statusCode || 0, body)) {
          resolve({ success: true, username, password, banner: body.slice(0, 200) });
        } else if (opts.authFailedCheck?.(res.statusCode || 0, body) ?? res.statusCode === 401) {
          resolve({ success: false, message: 'auth_failed' });
        } else {
          resolve({ success: false, message: `http_${res.statusCode}` });
        }
      });
      res.on('error', e => resolve({ success: false, message: String(e.message || e).slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'timeout' }); });
    req.on('error', e => resolve({ success: false, message: String(e.message || e).slice(0, 200) }));
  });
}

export const testElasticsearch: Tester = httpBasicAuth({
  path: '/',
  successCheck: (status, body) =>
    status === 200 && /"cluster_name"|"tagline"\s*:\s*"You Know, for Search"/i.test(body),
});

export const testClickhouse: Tester = httpBasicAuth({
  // /?query=SELECT+1 返回 "1\n" 即认证通过
  path: '/?query=SELECT+1',
  successCheck: (status, body) => status === 200 && body.trim() === '1',
  authFailedCheck: (status, body) => status === 403 || /Authentication failed|Wrong password|User .* not found/i.test(body),
});

export const testCouchdb: Tester = httpBasicAuth({
  path: '/_all_dbs',
  successCheck: (status, body) => status === 200 && body.trim().startsWith('['),
});

export const testInfluxdb: Tester = httpBasicAuth({
  path: '/query?q=SHOW+DATABASES',
  successCheck: (status, body) => status === 200 && /"results"/.test(body),
});
