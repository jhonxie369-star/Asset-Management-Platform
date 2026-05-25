import type { Tester } from './types.js';

/**
 * MySQL / MariaDB / PolarDB / ADB / StarRocks — 统一 MySQL 协议兼容
 * 使用 mysql2 驱动，不做任何查询，握手成功即认为认证通过。
 */
export const testMysql: Tester = async ({ host, port, username, password, timeoutMs }) => {
  // 动态 import，避免启动时加载
  const { createConnection } = await import('mysql2/promise');
  let conn: any;
  try {
    conn = await createConnection({
      host, port, user: username, password,
      connectTimeout: timeoutMs,
      // 禁止任何 query，避免误触发副作用
      multipleStatements: false,
      enableKeepAlive: false,
      rowsAsArray: true,
    });
    await conn.ping();
    return { success: true, username, password };
  } catch (err: any) {
    const msg = String(err?.message || err);
    // 认证失败明确信号
    if (/ER_ACCESS_DENIED_ERROR|Access denied/i.test(msg)) {
      return { success: false, message: 'auth_failed' };
    }
    return { success: false, message: msg.slice(0, 200) };
  } finally {
    try { await conn?.end(); } catch { /* ignore */ }
  }
};
