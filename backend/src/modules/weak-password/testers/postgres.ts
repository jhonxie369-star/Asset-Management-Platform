import type { Tester } from './types.js';

/**
 * PostgreSQL / PolarDB-PG — 使用 pg 驱动连接 postgres 库。
 */
export const testPostgres: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const pg: any = (await import('pg')).default || (await import('pg'));
  const client = new pg.Client({
    host, port,
    user: username || 'postgres',
    password: password || '',
    database: 'postgres',
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    return { success: true, username, password };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/password authentication failed|authentication failed/i.test(msg)) {
      return { success: false, message: 'auth_failed' };
    }
    return { success: false, message: msg.slice(0, 200) };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
