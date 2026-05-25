import type { Tester } from './types.js';

/**
 * MongoDB — 使用官方驱动。
 * 无密码：尝试以 admin 连接；admin 可达即未授权。
 * 有密码：走 authSource=admin，驱动内自动 SASL。
 */
export const testMongodb: Tester = async ({ host, port, username, password, timeoutMs }) => {
  const { MongoClient } = await import('mongodb');
  const uri = username
    ? `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/?authSource=admin&serverSelectionTimeoutMS=${timeoutMs}&connectTimeoutMS=${timeoutMs}`
    : `mongodb://${host}:${port}/?serverSelectionTimeoutMS=${timeoutMs}&connectTimeoutMS=${timeoutMs}`;
  let client: InstanceType<typeof MongoClient> | undefined;
  try {
    client = new MongoClient(uri);
    await client.connect();
    // ping/buildInfo 可能在开启认证时仍可执行；listDatabases 才能证明存在可用读权限。
    await client.db('admin').command({ listDatabases: 1 });
    return { success: true, username, password };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/Authentication failed|not authorized|requires authentication/i.test(msg)) {
      return { success: false, message: 'auth_failed' };
    }
    return { success: false, message: msg.slice(0, 200) };
  } finally {
    try { await client?.close(true); } catch { /* ignore */ }
  }
};
