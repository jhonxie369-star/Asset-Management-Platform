import * as net from 'net';
import type { Tester, TesterResult } from './types.js';

interface FtpReply { code?: number; text: string }

export const testFtpCredential: Tester = async ({ host, port, username, password, timeoutMs }) => {
  return ftpLogin(host, port, username, password, timeoutMs);
};

export async function checkFtpAnonymous(host: string, port: number, timeoutMs: number): Promise<TesterResult> {
  return ftpLogin(host, port, 'anonymous', 'anonymous@', timeoutMs);
}

export async function grabFtpBanner(host: string, port: number, timeoutMs: number): Promise<TesterResult> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = '';
    let done = false;
    const finish = (r: TesterResult) => {
      if (done) return;
      done = true;
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => undefined);
    sock.on('data', d => {
      buf += d.toString('utf8');
      const reply = parseReply(buf);
      if (reply.code) finish({ success: reply.code === 220, banner: reply.text, message: `ftp_${reply.code}` });
    });
    sock.on('timeout', () => finish({ success: false, message: 'timeout', banner: buf.slice(0, 200) }));
    sock.on('error', e => finish({ success: false, message: String(e.message || e).slice(0, 200), banner: buf.slice(0, 200) }));
    sock.connect(port, host);
  });
}

function ftpLogin(host: string, port: number, username: string, password: string, timeoutMs: number): Promise<TesterResult> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = '';
    let banner = '';
    let stage: 'banner' | 'user' | 'pass' | 'done' = 'banner';
    let done = false;

    const finish = (r: TesterResult) => {
      if (done) return;
      done = true;
      stage = 'done';
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
      sock.destroy();
      resolve({ ...r, username, password, banner: r.banner || banner || undefined });
    };

    const handleReply = (reply: FtpReply) => {
      if (!reply.code) return;
      if (stage === 'banner') {
        banner = reply.text;
        if (reply.code !== 220) return finish({ success: false, message: `ftp_${reply.code}` });
        stage = 'user';
        sock.write(`USER ${username}\r\n`);
        buf = '';
        return;
      }
      if (stage === 'user') {
        if (reply.code === 230) return finish({ success: true, message: 'login_ok' });
        if (reply.code === 331 || reply.code === 332) {
          stage = 'pass';
          sock.write(`PASS ${password}\r\n`);
          buf = '';
          return;
        }
        if (reply.code === 530) return finish({ success: false, message: 'auth_failed' });
        return finish({ success: false, message: `ftp_${reply.code}` });
      }
      if (stage === 'pass') {
        if (reply.code === 230) return finish({ success: true, message: 'login_ok' });
        if (reply.code === 530) return finish({ success: false, message: 'auth_failed' });
        return finish({ success: false, message: `ftp_${reply.code}` });
      }
    };

    sock.setTimeout(timeoutMs);
    sock.on('data', d => {
      buf += d.toString('utf8');
      const reply = parseReply(buf);
      if (reply.code) handleReply(reply);
    });
    sock.on('timeout', () => finish({ success: false, message: 'timeout' }));
    sock.on('error', e => finish({ success: false, message: String(e.message || e).slice(0, 200) }));
    sock.connect(port, host);
  });
}

function parseReply(buf: string): FtpReply {
  const lines = buf.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { text: '' };
  const first = lines[0];
  const m = first.match(/^(\d{3})([ -])/);
  if (!m) return { text: buf.slice(0, 300) };
  const code = Number(m[1]);
  if (m[2] === '-') {
    const end = lines.find(l => l.startsWith(`${m[1]} `));
    if (!end) return { text: buf.slice(0, 300) };
  }
  return { code, text: lines.slice(0, 5).join('\n').slice(0, 300) };
}
