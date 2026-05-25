import * as net from 'net';
import type { Result, ModuleDefinition } from '@sasp/shared';
import type { IModule, ModuleContext } from '../engine/module-interface.js';

const definition: ModuleDefinition = {
  id: 'port-discovery',
  name: '端口发现',
  category: 'recon',
  targetType: 'asset',
  riskLevel: 'passive',
  description: '输入 IP → 输出活端点（ip+port+alive）。Worker Pool 并发控制。',
  configSchema: {
    ports: { type: 'array', default: [22, 80, 443, 3306, 6379, 8080, 8443] },
    timeoutMs: { type: 'number', default: 2000 },
    workers: { type: 'number', default: 500, description: '并发 TCP 连接数' },
  },
};

function tcpConnect(ip: string, port: number, timeoutMs: number): Promise<{ open: boolean; banner?: string }> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let banner = '';
    let resolved = false;
    const done = (result: { open: boolean; banner?: string }) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.on('data', d => { banner += d.toString().slice(0, 256); });
      setTimeout(() => done({ open: true, banner: banner || undefined }), 300);
    });
    sock.on('timeout', () => done({ open: false }));
    sock.on('error', () => done({ open: false }));
    sock.connect(port, ip);
  });
}

function guessProtocol(port: number): string {
  const map: Record<number, string> = {
    21: 'ftp', 22: 'ssh', 80: 'http', 443: 'https', 3306: 'mysql',
    23: 'telnet', 25: 'smtp', 53: 'dns', 110: 'pop3', 143: 'imap',
    389: 'ldap', 445: 'smb', 465: 'smtp', 587: 'smtp', 636: 'ldap',
    873: 'rsync', 989: 'ftp', 990: 'ftp', 993: 'imap', 995: 'pop3',
    1080: 'socks', 1081: 'socks', 1099: 'rmi', 1883: 'mqtt', 2049: 'nfs',
    2375: 'docker', 2376: 'docker', 3389: 'rdp', 3690: 'svn', 4369: 'epmd',
    5671: 'amqp', 5672: 'amqp', 5900: 'vnc', 5901: 'vnc', 5902: 'vnc', 5903: 'vnc',
    6000: 'x11', 6001: 'x11', 6006: 'tensorboard', 6443: 'kubernetes', 8009: 'ajp',
    8883: 'mqtt', 9100: 'printer', 9418: 'git', 10050: 'zabbix-agent', 10051: 'zabbix',
    10250: 'kubelet', 10255: 'kubelet', 10256: 'kube-proxy',
    25672: 'erlang-distribution', 61613: 'stomp', 61614: 'stomp', 61616: 'activemq',
    5432: 'postgres', 6379: 'redis', 27017: 'mongodb',
    1433: 'mssql', 1434: 'mssql', 1521: 'oracle', 1522: 'oracle',
    2181: 'zookeeper', 2182: 'zookeeper', 2183: 'zookeeper', 2888: 'zookeeper', 3888: 'zookeeper',
    11211: 'memcached', 11212: 'memcached',
    2379: 'etcd', 2380: 'etcd', 7687: 'neo4j', 9092: 'kafka', 9093: 'kafka', 19092: 'kafka',
    9042: 'cassandra', 9142: 'cassandra', 9160: 'cassandra',
    2881: 'oceanbase', 2882: 'oceanbase', 2883: 'oceanbase', 2884: 'oceanbase',
    4000: 'tidb', 10080: 'tidb', 20160: 'tidb', 20180: 'tidb',
    6650: 'pulsar', 6651: 'pulsar',
    8030: 'doris', 8040: 'doris', 8060: 'doris', 9050: 'doris', 9060: 'doris',
    8983: 'solr', 9083: 'hive', 9600: 'opensearch',
    9870: 'hdfs', 9871: 'hdfs', 9864: 'hdfs', 9866: 'hdfs', 9867: 'hdfs',
    9876: 'rocketmq', 10909: 'rocketmq', 10911: 'rocketmq', 10912: 'rocketmq',
    8083: 'http', 8500: 'consul', 8600: 'consul', 8848: 'http',
  };
  if (map[port]) return map[port];
  if ([8080, 8081, 8443, 8000, 8888, 9000, 9090, 81, 82, 7000, 7001, 7002, 7003, 7004, 7005, 7006, 7474, 8123, 15671, 15672, 16010, 50070, 50075, 50090].includes(port)) return 'http';
  return 'tcp';
}

export class PortDiscoveryModule implements IModule {
  definition = definition;

  async *execute(ctx: ModuleContext): AsyncGenerator<Result> {
    const ports: number[] = (ctx.config.ports as number[]) || [22, 80, 443, 3306, 6379, 8080];
    const timeoutMs = (ctx.config.timeoutMs as number) || 2000;
    const workers = Math.max(1, Math.min((ctx.config.workers as number) || 500, 5000));

    // 任务集合 = 资产 × 端口
    interface Job { assetId: string; ip: string; host: string; port: number }
    const jobs: Job[] = [];
    for (const asset of ctx.assets) {
      const host = asset.address || asset.ip;
      for (const port of ports) jobs.push({ assetId: asset.id, ip: asset.ip, host, port });
    }
    if (jobs.length === 0) return;

    let idx = 0;
    let activeWorkers = Math.min(workers, jobs.length);
    let attempted = 0;
    let openCount = 0;
    let nextProgressAt = Math.min(1000, jobs.length);
    const progressEvery = Math.max(1000, Math.min((ctx.config.progressEvery as number) || 5000, 50000));
    const queue: Result[] = [];
    let notify: (() => void) | undefined;

    const pushResult = (result: Result) => {
      queue.push(result);
      notify?.();
      notify = undefined;
    };

    const notifyIfDrained = () => {
      if (activeWorkers === 0) {
        notify?.();
        notify = undefined;
      }
    };

    const pushProgress = (final = false) => {
      pushResult({
        id: '',
        runId: ctx.run.id,
        moduleId: definition.id,
        resultType: 'log',
        data: {
          type: final ? 'progress_final' : 'progress',
          message: final
            ? `端口发现完成: ${attempted}/${jobs.length}, 活端点 ${openCount}`
            : `端口发现进度: ${attempted}/${jobs.length}, 活端点 ${openCount}`,
          attempted,
          total: jobs.length,
          open: openCount,
          workers: activeWorkers,
        },
        createdAt: new Date().toISOString(),
      });
    };

    const worker = async () => {
      try {
        while (idx < jobs.length) {
          const job = jobs[idx++];
          try {
            const r = await tcpConnect(job.host, job.port, timeoutMs);
            attempted++;
            if (r.open) {
              openCount++;
              // 产出：活端点（只表示端口活着，不做服务识别）
              pushResult({
                id: '',
                runId: ctx.run.id,
                moduleId: definition.id,
                assetId: job.assetId,
                resultType: 'endpoint_alive',
                data: {
                  ip: job.ip,
                  host: job.host,
                  port: job.port,
                  banner: r.banner,
                },
                createdAt: new Date().toISOString(),
              });
            }
            if (attempted >= nextProgressAt) {
              pushProgress();
              nextProgressAt = attempted + progressEvery;
            }
          } catch { /* ignore */ }
        }
      } finally {
        activeWorkers--;
        if (activeWorkers === 0) pushProgress(true);
        notifyIfDrained();
      }
    };

    const pool: Promise<void>[] = [];
    for (let i = 0; i < activeWorkers; i++) pool.push(worker());

    while (activeWorkers > 0 || queue.length > 0) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>(resolve => { notify = resolve; });
    }
    await Promise.all(pool);
  }
}
