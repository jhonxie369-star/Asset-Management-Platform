import net from 'net';
import type { Tester } from './types.js';

const OP_ERROR = 0x00;
const OP_STARTUP = 0x01;
const OP_READY = 0x02;
const OP_AUTHENTICATE = 0x03;
const OP_AUTH_CHALLENGE = 0x0e;
const OP_AUTH_RESPONSE = 0x0f;
const OP_AUTH_SUCCESS = 0x10;

type Frame = { opcode: number; body: Buffer };

/**
 * Cassandra 官方 driver 会做集群/连接池初始化，弱口令逐个尝试时容易留下大量
 * 9042 长连接。这里直接走最小 CQL native protocol 握手：STARTUP → AUTH_RESPONSE。
 */
export const testCassandra: Tester = async ({ host, port, username, password, timeoutMs }) => {
  return new Promise(resolve => {
    const user = username || '';
    const pass = password || '';
    let stage: 'startup' | 'auth' = 'startup';
    let buffer = Buffer.alloc(0);
    let settled = false;

    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => finish({ success: false, message: 'timeout' }), Math.max(1000, timeoutMs));

    function finish(result: { success: boolean; username?: string; password?: string; message?: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    }

    socket.once('connect', () => {
      socket.write(buildFrame(1, OP_STARTUP, buildStringMap({ CQL_VERSION: '3.0.0' })));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame: Frame | undefined;
      while ((frame = readFrame()) && !settled) handleFrame(frame);
    });
    socket.once('error', err => finish({ success: false, message: normalizeError(err.message) }));
    socket.once('close', () => finish({ success: false, message: 'connection_closed' }));

    function handleFrame(frame: Frame) {
      if (frame.opcode === OP_ERROR) {
        finish({ success: false, message: normalizeError(readErrorMessage(frame.body)) });
        return;
      }

      if (stage === 'startup') {
        if (frame.opcode === OP_READY) {
          // 服务端未启用认证。只把空账号空密码标为未授权，避免非空凭据误报为弱口令。
          finish(user || pass
            ? { success: false, message: 'auth_not_required' }
            : { success: true, username: user, password: pass, message: 'no_auth_required' });
          return;
        }
        if (frame.opcode === OP_AUTHENTICATE) {
          if (!user && !pass) {
            finish({ success: false, message: 'auth_required' });
            return;
          }
          stage = 'auth';
          const token = Buffer.from(`\0${user}\0${pass}`, 'utf8');
          socket.write(buildFrame(2, OP_AUTH_RESPONSE, buildBytes(token)));
          return;
        }
      } else if (stage === 'auth') {
        if (frame.opcode === OP_AUTH_SUCCESS) {
          finish({ success: true, username: user, password: pass });
          return;
        }
        if (frame.opcode === OP_AUTH_CHALLENGE) {
          finish({ success: false, message: 'auth_challenge_unsupported' });
          return;
        }
      }

      finish({ success: false, message: `unexpected_opcode_${frame.opcode}` });
    }

    function readFrame(): Frame | undefined {
      if (buffer.length < 9) return undefined;
      const length = buffer.readInt32BE(5);
      if (buffer.length < 9 + length) return undefined;
      const opcode = buffer[4];
      const body = buffer.subarray(9, 9 + length);
      buffer = buffer.subarray(9 + length);
      return { opcode, body };
    }
  });
};

function buildFrame(stream: number, opcode: number, body: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header[0] = 0x04; // request, protocol v4
  header[1] = 0x00;
  header.writeInt16BE(stream, 2);
  header[4] = opcode;
  header.writeInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

function buildString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function buildStringMap(values: Record<string, string>): Buffer {
  const entries = Object.entries(values);
  const count = Buffer.alloc(2);
  count.writeUInt16BE(entries.length, 0);
  return Buffer.concat([count, ...entries.flatMap(([key, value]) => [buildString(key), buildString(value)])]);
}

function buildBytes(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(value.length, 0);
  return Buffer.concat([len, value]);
}

function readString(buf: Buffer, offset: number): { value: string; next: number } {
  if (buf.length < offset + 2) return { value: '', next: buf.length };
  const len = buf.readUInt16BE(offset);
  const start = offset + 2;
  const end = Math.min(start + len, buf.length);
  return { value: buf.subarray(start, end).toString('utf8'), next: end };
}

function readErrorMessage(body: Buffer): string {
  if (body.length < 6) return 'cassandra_error';
  return readString(body, 4).value || 'cassandra_error';
}

function normalizeError(message?: string): string {
  const msg = String(message || '').trim();
  if (/authentication|bad credentials|username and\/or password are incorrect/i.test(msg)) return 'auth_failed';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/refused/i.test(msg)) return 'connection_refused';
  if (/closed|reset/i.test(msg)) return 'connection_reset';
  return msg.slice(0, 200) || 'unknown';
}
