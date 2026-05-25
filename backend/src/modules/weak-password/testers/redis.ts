import * as net from 'net';
import type { Tester } from './types.js';

/**
 * Redis — 自己发 RESP 协议，避免引入 ioredis/redis 依赖。
 * 规则：
 *   - 空密码：发 INFO server，若回复以 $ 开头 或 "redis_version" 出现 → 未授权
 *   - 有密码：AUTH <pwd>\r\nINFO server\r\n，看回复是 +OK 还是 -ERR
 *   - 若默认启动有 ACL 用户：AUTH <user> <pwd>
 */
export const testRedis: Tester = ({ host, port, username, password, timeoutMs }) => {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = '';
    let done = false;

    const finish = (r: Parameters<typeof resolve>[0]) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      const cmds: string[] = [];
      if (password || username) {
        const args = username ? [username, password] : [password];
        cmds.push(buildResp(['AUTH', ...args]));
      }
      cmds.push(buildResp(['INFO', 'server']));
      sock.write(cmds.join(''));
    });
    sock.on('data', d => {
      buf += d.toString('utf8');
      if (buf.includes('redis_version')) {
        finish({ success: true, username, password, banner: extractLine(buf, 'redis_version') });
      } else if (/\n-NOAUTH|\n-DENIED|WRONGPASS|-ERR Client sent AUTH/i.test(buf)) {
        finish({ success: false, message: 'auth_failed' });
      } else if (/-ERR unknown command/i.test(buf)) {
        // 可能不是 Redis
        finish({ success: false, message: 'not_redis' });
      }
    });
    sock.on('timeout', () => finish({ success: false, message: 'timeout' }));
    sock.on('error', e => finish({ success: false, message: String(e.message || e).slice(0, 200) }));
    sock.connect(port, host);
  });
};

function buildResp(args: string[]): string {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return parts.join('');
}

function extractLine(text: string, key: string): string | undefined {
  const m = text.split(/\r?\n/).find(l => l.startsWith(key));
  return m?.slice(0, 200);
}
