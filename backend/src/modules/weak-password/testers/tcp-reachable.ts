import * as net from 'net';
import { AEROSPIKE_INFO_PROBE } from '../../fingerprints/probes.js';
import type { Tester } from './types.js';

/**
 * Aerospike / HBase — 尚未完整支持原生认证测试。
 * 当前策略：尝试 TCP 建链，成功即报告"可达"（作为低置信度弱凭据/未授权线索）。
 * 后续可根据具体部署补 Aerospike ClientV2 / HBase Thrift 认证。
 */
export function makeTcpReachableTester(label: string): Tester {
  return ({ host, port, timeoutMs }) => new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r: Parameters<typeof resolve>[0]) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish({ success: true, message: `${label}_reachable_unauth_unchecked` }));
    sock.on('timeout', () => finish({ success: false, message: 'timeout' }));
    sock.on('error', () => finish({ success: false, message: 'connect_failed' }));
    sock.connect(port, host);
  });
}

export const testAerospike: Tester = ({ host, port, timeoutMs }) => new Promise(resolve => {
  const sock = new net.Socket();
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (success: boolean, message: string) => {
    if (done) return;
    done = true;
    sock.destroy();
    const text = buf.toString('utf8').replace(/[^\x20-\x7e\t\r\n]/g, '').slice(0, 300);
    resolve({ success, message, banner: text });
  };
  sock.setTimeout(timeoutMs);
  sock.on('connect', () => sock.write(AEROSPIKE_INFO_PROBE));
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]).slice(0, 4096);
    const text = buf.toString('utf8');
    if (/build\t|edition\t|node\t|features\t|service\b|services\b/i.test(text)) {
      finish(true, 'aerospike_info_read');
    }
  });
  sock.on('timeout', () => finish(false, 'timeout'));
  sock.on('error', () => finish(false, 'connect_failed'));
  sock.connect(port, host);
});
export const testHbase: Tester = makeTcpReachableTester('hbase');
