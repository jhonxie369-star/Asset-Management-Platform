import React from 'react';

// 默认值（和后端保持一致）
export const DEFAULT_DB_PROFILES = [
  { name: 'mysql', enabled: true, ports: [3306, 3307, 3308, 33060], fingerprintProducts: ['MySQL', 'MariaDB'] },
  { name: 'polardb', enabled: true, ports: [], fingerprintProducts: ['PolarDB'] },
  { name: 'adb', enabled: true, ports: [3306], fingerprintProducts: ['ADB'] },
  { name: 'starrocks', enabled: true, ports: [9030], fingerprintProducts: ['StarRocks'] },
  { name: 'tidb', enabled: true, ports: [4000], fingerprintProducts: ['TiDB'] },
  { name: 'oceanbase', enabled: true, ports: [2881, 2883], fingerprintProducts: ['OceanBase'] },
  { name: 'doris', enabled: true, ports: [9030], fingerprintProducts: ['Doris'] },
  { name: 'postgres', enabled: true, ports: [5432, 5433], fingerprintProducts: ['PostgreSQL'] },
  { name: 'redis', enabled: true, ports: [6379, 6380, 16379], fingerprintProducts: ['Redis'] },
  { name: 'mongodb', enabled: true, ports: [27017, 27018, 27019], fingerprintProducts: ['MongoDB'] },
  { name: 'cassandra', enabled: true, ports: [9042, 9142], fingerprintProducts: ['Cassandra'] },
  { name: 'elasticsearch', enabled: true, ports: [9200, 9201], fingerprintProducts: ['Elasticsearch'] },
  { name: 'opensearch', enabled: true, ports: [9200, 9201, 9600], fingerprintProducts: ['OpenSearch'] },
  { name: 'clickhouse', enabled: true, ports: [8123, 8443, 9000], fingerprintProducts: ['ClickHouse'] },
  { name: 'couchdb', enabled: false, ports: [5984], fingerprintProducts: ['CouchDB'] },
  { name: 'influxdb', enabled: false, ports: [8086], fingerprintProducts: ['InfluxDB'] },
  { name: 'aerospike', enabled: true, ports: [3000, 3001, 3002, 3003], fingerprintProducts: ['Aerospike'] },
  { name: 'hbase', enabled: false, ports: [16010, 60010], fingerprintProducts: ['HBase'] },
  { name: 'memcached', enabled: true, ports: [11211, 11212], fingerprintProducts: ['Memcached'] },
  { name: 'zookeeper', enabled: true, ports: [2181, 2888, 3888], fingerprintProducts: ['ZooKeeper'] },
  { name: 'etcd', enabled: true, ports: [2379, 2380], fingerprintProducts: ['etcd'] },
  { name: 'neo4j', enabled: true, ports: [7474, 7687], fingerprintProducts: ['Neo4j'] },
  { name: 'rabbitmq', enabled: true, ports: [15672, 15671], fingerprintProducts: ['RabbitMQ'] },
  { name: 'kafka', enabled: true, ports: [9092, 9093, 19092], fingerprintProducts: ['Kafka'] },
  { name: 'kubelet', enabled: true, ports: [10250, 10255], fingerprintProducts: ['Kubelet'], checks: { anonymous: true, weakPassword: true } },
  { name: 'grafana', enabled: true, ports: [3000], fingerprintProducts: ['Grafana'], checks: { anonymous: true, weakPassword: true } },
  { name: 'minio', enabled: true, ports: [9000, 9001], fingerprintProducts: ['MinIO'], checks: { anonymous: true, weakPassword: true } },
  { name: 'nacos', enabled: true, ports: [8848], fingerprintProducts: ['Nacos'], checks: { anonymous: true, weakPassword: true } },
  { name: 'argocd', enabled: true, ports: [], fingerprintProducts: ['Argo CD'], checks: { anonymous: true, weakPassword: true } },
  { name: 'superset', enabled: true, ports: [8088], fingerprintProducts: ['Superset'], checks: { anonymous: true, weakPassword: true } },
  { name: 'flink', enabled: true, ports: [8081], fingerprintProducts: ['Apache Flink'], checks: { anonymous: true, weakPassword: true } },
  { name: 'prometheus', enabled: true, ports: [9090], fingerprintProducts: ['Prometheus'], checks: { anonymous: true, weakPassword: true } },
  { name: 'zabbix', enabled: true, ports: [], fingerprintProducts: ['Zabbix'], checks: { anonymous: false, weakPassword: true } },
  { name: 'kafka-connect', enabled: true, ports: [8083], fingerprintProducts: ['Kafka Connect'], checks: { anonymous: true, weakPassword: true } },
  {
    name: 'ftp',
    enabled: true,
    ports: [21],
    fingerprintProducts: ['FTP', 'vsftpd', 'ProFTPD', 'Pure-FTPd', 'FileZilla Server'],
    checks: { anonymous: true, plaintext: true, weakPassword: false },
  },
];

export const DEFAULT_USERNAMES: Record<string, string[]> = {
  mysql: ['root', 'mysql', 'admin', 'test'],
  mariadb: ['root', 'mysql', 'admin', 'test'],
  polardb: ['root', 'polardb', 'admin', 'test'],
  adb: ['root', 'admin', 'test'],
  starrocks: ['root', 'admin', 'starrocks'],
  tidb: ['root', 'admin', 'tidb'],
  oceanbase: ['root', 'admin', 'sys', 'oceanbase'],
  doris: ['root', 'admin', 'doris'],
  postgres: ['postgres', 'admin', 'root'],
  redis: ['', 'default', 'redis'],
  mongodb: ['', 'admin', 'root', 'mongo', 'mongodb'],
  cassandra: ['', 'cassandra', 'admin', 'root'],
  elasticsearch: ['elastic', 'kibana', 'admin', 'elasticsearch'],
  opensearch: ['admin', 'opensearch', 'elastic'],
  clickhouse: ['default', 'admin', 'clickhouse'],
  couchdb: ['admin', 'couchdb'],
  influxdb: ['admin', 'root', 'influxdb'],
  aerospike: [''],
  hbase: [''],
  memcached: [''],
  zookeeper: [''],
  etcd: [''],
  neo4j: ['neo4j', 'admin', 'root'],
  rabbitmq: ['guest', 'admin', 'rabbitmq', 'root'],
  kafka: [''],
  kubelet: [''],
  grafana: ['', 'admin'],
  minio: ['', 'minioadmin', 'admin'],
  nacos: ['', 'nacos'],
  argocd: ['', 'admin'],
  superset: ['', 'admin'],
  flink: [''],
  prometheus: [''],
  zabbix: ['Admin', 'admin'],
  'kafka-connect': [''],
  ftp: ['ftp', 'anonymous', 'admin', 'test'],
};

export const DEFAULT_PASSWORDS_MAP: Record<string, string[]> = {
  // 空字符串必须保留在第一位：表示无密码/空密码尝试。
  mysql:    ['', 'root', 'root123', 'root@123', 'mysql', 'mysql123', 'Mysql@123', '123456', '12345678', 'admin', 'admin123', 'password', 'P@ssw0rd'],
  mariadb:  ['', 'root', 'root123', 'root@123', 'mariadb', 'mariadb123', 'mysql', '123456', '12345678', 'admin', 'admin123', 'password'],
  polardb:  ['', 'root', 'root123', 'root@123', 'polardb', 'polardb123', 'mysql', '123456', 'admin', 'admin123', 'password'],
  adb:      ['', 'root', 'root123', 'adb', 'adb123', 'admin', 'admin123', '123456', 'password'],
  starrocks:['', 'root', 'root123', 'starrocks', 'starrocks123', 'StarRocks@123', 'admin', 'admin123', '123456'],
  tidb:     ['', 'root', 'root123', 'tidb', 'tidb123', 'admin', 'admin123', '123456', 'password'],
  oceanbase:['', 'root', 'root123', 'oceanbase', 'OceanBase@123', 'admin', 'admin123', '123456', 'password'],
  doris:    ['', 'root', 'root123', 'doris', 'doris123', 'Doris@123', 'admin', 'admin123', '123456'],
  postgres: ['', 'postgres', 'postgres123', 'Postgres@123', 'admin', 'admin123', 'root', '123456', '12345678', 'password', 'P@ssw0rd'],
  redis:    ['', 'redis', 'redis123', 'Redis@123', 'foobared', '123456', '12345678', 'admin', 'password'],
  mongodb:  ['', 'admin', 'mongo', 'mongodb', 'mongodb123', 'Mongo@123', 'root', 'root123', '123456', '12345678', 'password'],
  cassandra:['', 'cassandra', 'cassandra123', 'Cassandra@123', 'admin', 'admin123', '123456', 'password'],
  elasticsearch: ['', 'elastic', 'elastic123', 'Elastic@123', 'elasticsearch', 'changeme', 'admin', 'admin123', '123456', 'password'],
  opensearch: ['', 'admin', 'admin123', 'opensearch', 'OpenSearch@123', 'elastic', 'changeme', '123456', 'password'],
  clickhouse:   ['', 'default', 'clickhouse', 'clickhouse123', 'ClickHouse@123', 'admin', 'admin123', '123456', 'password'],
  couchdb:      ['', 'admin', 'admin123', 'couchdb', 'couchdb123', 'password', '123456'],
  influxdb:     ['', 'admin', 'admin123', 'influxdb', 'influxdb123', 'password', '123456'],
  aerospike:    [''],
  hbase:        [''],
  memcached:    [''],
  zookeeper:    [''],
  etcd:         [''],
  neo4j:        ['', 'neo4j', 'admin', 'neo4j123', 'Neo4j@123', 'password', '123456'],
  rabbitmq:     ['', 'guest', 'guest123', 'admin', 'admin123', 'rabbitmq', 'rabbitmq123', 'password', '123456'],
  kafka:        [''],
  kubelet:      [''],
  grafana:      ['', 'admin', 'password', 'admin123'],
  minio:        ['', 'minioadmin', 'admin', 'password'],
  nacos:        ['', 'nacos', 'admin', 'nacos123'],
  argocd:       ['', 'admin', 'password', 'argocd'],
  superset:     ['', 'admin', 'password', 'superset'],
  flink:        [''],
  prometheus:   [''],
  zabbix:       ['zabbix', 'admin', 'Admin', 'password'],
  'kafka-connect': [''],
  ftp:          ['', 'ftp', 'anonymous', 'anonymous@', 'admin', 'admin123', '123456', 'password'],
};
export const DEFAULT_EXTRA_PASSWORDS: string[] = [];

/** @deprecated 旧全局密码,仅用于兼容老 config */
export const DEFAULT_PASSWORDS = [
  '', 'root', 'root123', '123456', '12345678', 'admin', 'admin123', 'password', 'P@ssw0rd',
];

function mergeDefaultProfiles(profiles: typeof DEFAULT_DB_PROFILES): typeof DEFAULT_DB_PROFILES {
  const byName = new Map(profiles.map(p => [p.name, p]));
  return [
    ...profiles.map(p => {
      const defaults = DEFAULT_DB_PROFILES.find(d => d.name === p.name);
      return defaults ? { ...defaults, ...p, checks: { ...(defaults as any).checks, ...(p as any).checks } } : p;
    }),
    ...DEFAULT_DB_PROFILES.filter(p => !byName.has(p.name)),
  ];
}

export const DEFAULT_DIRSEARCH_WORDLIST = [
  'admin', 'administrator', 'login', 'manage', 'dashboard', 'console',
  'api', 'api/v1', 'swagger', 'swagger-ui', 'swagger-ui.html',
  'v2/api-docs', 'openapi.json', 'docs',
  '.env', '.git/config', '.git/HEAD', '.svn/entries', '.DS_Store',
  'backup.zip', 'db.sql', 'dump.sql', 'dump.rdb',
  'actuator', 'actuator/env', 'actuator/health', 'actuator/heapdump',
  'phpinfo.php', 'info.php',
  'phpmyadmin', 'pma', 'adminer.php',
  'wp-admin', 'wp-login.php',
  'grafana', 'kibana', 'metrics', 'health',
  'robots.txt', 'sitemap.xml',
];

// ─── 工具 ─────────────────────────────────────────────
function parseCsvInts(s: string): number[] {
  return s.split(/[\s,;]+/).map(x => parseInt(x)).filter(n => n > 0 && n < 65536);
}
function parseLines(s: string): string[] {
  return s.split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
}

// ─── port-discovery 配置 ──────────────────────────────
export function PortDiscoveryConfig({ cfg, onChange }: { cfg: any; onChange: (c: any) => void }) {
  return (
    <div className="module-cfg">
      <h4>端口发现 port-discovery</h4>
      <div className="row">
        <label style={{ margin: 0 }}>并发</label>
        <input type="number" style={{ width: '80px' }} value={cfg.workers ?? 500} min={1} max={5000}
          onChange={e => onChange({ ...cfg, workers: +e.target.value })} />
        <label style={{ margin: 0 }}>超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.timeoutMs ?? 2000} min={500} max={10000}
          onChange={e => onChange({ ...cfg, timeoutMs: +e.target.value })} />
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
        ports 来自左侧"端口列表",此处只配并发 / 超时
      </div>
    </div>
  );
}

// ─── db-endpoint-probe 配置 ───────────────────────────
export function DbEndpointProbeConfig({ cfg, onChange }: { cfg: any; onChange: (c: any) => void }) {
  return (
    <div className="module-cfg">
      <h4>云数据库端点探测 db-endpoint-probe</h4>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '0.5rem', lineHeight: 1.5 }}>
        面向 <b>host:port:protocol</b> 资产条目：先 DNS 解析，再连通性探测，并直接沉淀为端点/服务。
        适合 RDS、Redis、MongoDB、PostgreSQL 等云上域名型数据库。
      </div>
      <div className="row">
        <label style={{ margin: 0 }}>并发</label>
        <input type="number" style={{ width: '80px' }} value={cfg.workers ?? 80} min={1} max={300}
          onChange={e => onChange({ ...cfg, workers: +e.target.value })} />
        <label style={{ margin: 0 }}>超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.timeoutMs ?? 3000} min={500} max={15000}
          onChange={e => onChange({ ...cfg, timeoutMs: +e.target.value })} />
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.includeIpAssets ?? false}
            onChange={e => onChange({ ...cfg, includeIpAssets: e.target.checked })} /> 同时处理 IP 资产
        </label>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
        不依赖左侧端口列表，端口来自资产条目本身，例如 db.example.invalid:3306:mysql。
      </div>
    </div>
  );
}

// ─── fingerprint 配置 ─────────────────────────────────
export function FingerprintConfig({ cfg, onChange }: { cfg: any; onChange: (c: any) => void }) {
  return (
    <div className="module-cfg">
      <h4>指纹识别 fingerprint</h4>
      <div className="row">
        <label style={{ margin: 0 }}>并发</label>
        <input type="number" style={{ width: '80px' }} value={cfg.workers ?? 60} min={1} max={200}
          onChange={e => onChange({ ...cfg, workers: +e.target.value })} />
        <label style={{ margin: 0 }}>HTTP 超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.httpTimeoutMs ?? 3000} min={500} max={10000}
          onChange={e => onChange({ ...cfg, httpTimeoutMs: +e.target.value })} />
      </div>
      <div className="row">
        <label style={{ margin: 0 }}>TCP 超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.tcpTimeoutMs ?? 2000} min={500} max={10000}
          onChange={e => onChange({ ...cfg, tcpTimeoutMs: +e.target.value })} />
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.enableFavicon ?? true}
            onChange={e => onChange({ ...cfg, enableFavicon: e.target.checked })} /> 启用 favicon
        </label>
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.enableTls ?? true}
            onChange={e => onChange({ ...cfg, enableTls: e.target.checked })} /> 启用 TLS 证书
        </label>
      </div>
    </div>
  );
}

// ─── auth-audit/weak-password 配置 ─────────────────────
export function WeakPasswordConfig({ cfg, onChange }: { cfg: any; onChange: (c: any) => void }) {
  const dbs: typeof DEFAULT_DB_PROFILES = React.useMemo(
    () => mergeDefaultProfiles(cfg.dbs ?? DEFAULT_DB_PROFILES),
    [cfg.dbs],
  );
  const usernames: Record<string, string[]> = cfg.usernames ?? DEFAULT_USERNAMES;
  const passwordsMap: Record<string, string[]> = cfg.passwordsMap ?? DEFAULT_PASSWORDS_MAP;
  const extraPasswords: string[] = cfg.extraPasswords ?? DEFAULT_EXTRA_PASSWORDS;
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const updateDb = (idx: number, patch: any) => {
    const next = dbs.map((d, i) => i === idx ? { ...d, ...patch } : d);
    onChange({ ...cfg, dbs: next });
  };
  const updatePasswords = (name: string, list: string[]) => {
    onChange({ ...cfg, passwordsMap: { ...passwordsMap, [name]: list } });
  };

  // 统计:每个启用弱口令尝试的 tester × (usernames × passwords) 上限尝试数
  const totalAttempts = dbs.filter(d => d.enabled).reduce((sum, d) => {
    if ((d as any).checks?.weakPassword === false) return sum;
    const users = (usernames[d.name] || ['']).length || 1;
    const pws = (passwordsMap[d.name] ?? []).length || 0;
    const eff = pws > 0 ? pws : 0;
    const withExtra = eff + extraPasswords.length;
    return sum + users * withExtra;
  }, 0);

  return (
    <div className="module-cfg">
      <h4>认证面巡检 weak-password
        <span style={{ fontSize: '0.7rem', color: 'var(--warning)', marginLeft: '0.5rem' }}>⚠ intrusive</span>
      </h4>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '0.5rem', lineHeight: 1.5 }}>
        ℹ 只对<b>当前活端点</b>做认证巡检(已消失的不扫),不会重新探测端口。<br/>
        支持未授权/匿名登录/明文协议/弱口令；FTP 默认只做匿名与明文检查，不默认爆破。<br/>
        每个 tester 独立密码集 + 全局追加,避免把 foobared 扔给 MySQL 这种浪费。
      </div>

      <label>全局追加密码(每行一条,叠加到所有 tester)</label>
      <textarea style={{ width: '100%', minHeight: '50px', fontFamily: 'monospace', fontSize: '0.8rem' }}
        value={extraPasswords.join('\n')}
        onChange={e => onChange({ ...cfg, extraPasswords: parseLines(e.target.value) })}
        placeholder="例:企业内部统一的弱口令,不想分别复制到各 db 的话放这里" />

      <label style={{ marginTop: '0.6rem' }}>
        认证 tester 候选配置(端口 ∪ 指纹/协议 并集命中即测)
      </label>
      <table style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ width: '30px' }}>启</th>
            <th style={{ width: '80px' }}>tester</th>
            <th>端口(候选)</th>
            <th>指纹 products</th>
            <th style={{ width: '170px' }}>检查项</th>
            <th style={{ width: '140px' }}>用户名</th>
            <th style={{ width: '60px' }}>密码数</th>
          </tr>
        </thead>
        <tbody>
          {dbs.map((db, i) => {
            const pws = passwordsMap[db.name] ?? [];
            const isExpanded = expanded === db.name;
            const checks = (db as any).checks || {};
            return (
              <React.Fragment key={db.name}>
                <tr>
                  <td>
                    <input type="checkbox" checked={db.enabled}
                      onChange={e => updateDb(i, { enabled: e.target.checked })} />
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{db.name}</td>
                  <td>
                    <input value={db.ports.join(',')}
                      onChange={e => updateDb(i, { ports: parseCsvInts(e.target.value) })} />
                  </td>
                  <td>
                    <input value={db.fingerprintProducts.join(',')}
                      onChange={e => updateDb(i, { fingerprintProducts: e.target.value.split(/[,;]+/).map(s => s.trim()).filter(Boolean) })} />
                  </td>
                  <td style={{ fontSize: '0.7rem' }}>
                    {db.name === 'ftp' ? (
                      <>
                        <label style={{ marginRight: '0.4rem' }}>
                          <input type="checkbox" checked={checks.anonymous ?? true}
                            onChange={e => updateDb(i, { checks: { ...checks, anonymous: e.target.checked } })} /> 匿名
                        </label>
                        <label style={{ marginRight: '0.4rem' }}>
                          <input type="checkbox" checked={checks.plaintext ?? true}
                            onChange={e => updateDb(i, { checks: { ...checks, plaintext: e.target.checked } })} /> 明文
                        </label>
                        <label>
                          <input type="checkbox" checked={checks.weakPassword ?? false}
                            onChange={e => updateDb(i, { checks: { ...checks, weakPassword: e.target.checked } })} /> 弱口令
                        </label>
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>未授权/弱口令</span>
                    )}
                  </td>
                  <td>
                    <input value={(usernames[db.name] || []).join(',')}
                      onChange={e => onChange({
                        ...cfg,
                        usernames: { ...usernames, [db.name]: e.target.value.split(/[,;]+/).map(s => s.trim()) },
                      })} />
                  </td>
                  <td>
                    <button className="btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem' }}
                      onClick={e => { e.preventDefault(); setExpanded(isExpanded ? null : db.name); }}>
                      {pws.length} {isExpanded ? '▴' : '▾'}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--bg)', padding: '0.5rem' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '0.25rem' }}>
                        {db.name} 的密码(每行一条,空行=空密码)
                      </div>
                      <textarea style={{ width: '100%', minHeight: '80px', fontFamily: 'monospace', fontSize: '0.8rem' }}
                        value={pws.join('\n')}
                        onChange={e => updatePasswords(db.name, e.target.value.split(/\r?\n/))} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: '0.6rem' }}>
        <label style={{ margin: 0 }}>并发</label>
        <input type="number" style={{ width: '70px' }} value={cfg.workers ?? 20} min={1} max={100}
          onChange={e => onChange({ ...cfg, workers: +e.target.value })} />
        <label style={{ margin: 0 }}>每次超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.timeoutMs ?? 4000} min={1000} max={15000}
          onChange={e => onChange({ ...cfg, timeoutMs: +e.target.value })} />
        <label style={{ margin: 0 }}>尝试间隔 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.delayBetweenMs ?? 100} min={0} max={5000}
          onChange={e => onChange({ ...cfg, delayBetweenMs: +e.target.value })} />
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.stopOnFirstHit ?? true}
            onChange={e => onChange({ ...cfg, stopOnFirstHit: e.target.checked })} /> 命中即停
        </label>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.4rem' }}>
        ⚠ 仅在授权范围内使用。当前启用弱口令尝试的单目标尝试上限合计约 <b>{totalAttempts}</b> 次(user × password,命中即停可大幅减少)。
      </div>
    </div>
  );
}

// ─── dirsearch 配置 ──────────────────────────────────
const DEFAULT_EXCLUDE_KEYWORDS = [
  '认证失败', '请登录', '请先登录', '未登录', '无权访问', '无权限', '权限不足', '尚未登录',
  'unauthorized', 'please login', 'login required', 'authentication failed',
  'access denied', 'permission denied', 'not logged in', 'forbidden',
  'invalid token', 'token expired', 'session expired',
];

export function DirsearchConfig({ cfg, onChange }: { cfg: any; onChange: (c: any) => void }) {
  const wordlist: string[] = cfg.wordlist ?? [];
  const statusCodes: number[] = cfg.statusCodes ?? [200, 201, 204, 301, 302, 307, 401, 403];
  const extensions: string[] = cfg.extensions ?? [];
  const excludeKw: string[] = cfg.bodyExcludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS;
  return (
    <div className="module-cfg">
      <h4>目录扫描 dirsearch</h4>
      <label>自定义路径字典（每行一个，不带前缀 /；留空使用后端默认精简 dirsearch 字典）</label>
      <textarea style={{ width: '100%', minHeight: '100px', fontFamily: 'monospace' }}
        value={wordlist.join('\n')}
        placeholder={DEFAULT_DIRSEARCH_WORDLIST.join('\n')}
        onChange={e => {
          const next = parseLines(e.target.value);
          if (next.length > 0) onChange({ ...cfg, wordlist: next });
          else {
            const { wordlist: _wordlist, ...rest } = cfg;
            onChange(rest);
          }
        }} />

      <div className="row">
        <label style={{ margin: 0 }}>扩展名（逗号,可选）</label>
        <input style={{ flex: 1 }} placeholder="如 php,jsp,asp"
          value={extensions.join(',')}
          onChange={e => onChange({ ...cfg, extensions: e.target.value.split(/[,;]+/).map(s => s.trim().replace(/^\./, '')).filter(Boolean) })} />
      </div>
      <div className="row">
        <label style={{ margin: 0 }}>命中状态码</label>
        <input style={{ flex: 1 }} value={statusCodes.join(',')}
          onChange={e => onChange({ ...cfg, statusCodes: parseCsvInts(e.target.value) })} />
      </div>

      <label style={{ marginTop: '0.6rem' }}>
        真实性验证 — 过滤关键字（body/title 含任一即视为误报，逗号分隔）
      </label>
      <textarea style={{ width: '100%', minHeight: '60px', fontFamily: 'monospace', fontSize: '0.7rem' }}
        value={excludeKw.join(', ')}
        onChange={e => onChange({ ...cfg, bodyExcludeKeywords: e.target.value.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) })} />

      <div className="row">
        <label style={{ margin: 0 }}>baseline 探针数</label>
        <input type="number" style={{ width: '70px' }} value={cfg.baselineProbes ?? 3} min={0} max={10}
          onChange={e => onChange({ ...cfg, baselineProbes: +e.target.value })} />
        <label style={{ margin: 0 }}>最小 body 长度</label>
        <input type="number" style={{ width: '80px' }} value={cfg.minBodyLength ?? 0} min={0} max={10000}
          onChange={e => onChange({ ...cfg, minBodyLength: +e.target.value })} />
        <label style={{ margin: 0 }}>大小容差(字节)</label>
        <input type="number" style={{ width: '80px' }} value={cfg.sizeToleranceBytes ?? 64} min={0} max={10000}
          onChange={e => onChange({ ...cfg, sizeToleranceBytes: +e.target.value })} />
      </div>
      <div className="row">
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.reportSuspected ?? false}
            onChange={e => onChange({ ...cfg, reportSuspected: e.target.checked })} /> 同时输出可疑结果(标签 suspected)
        </label>
        <label style={{ margin: 0 }}>
          <input type="checkbox" checked={cfg.skipDatabasePorts ?? true}
            onChange={e => onChange({ ...cfg, skipDatabasePorts: e.target.checked })} /> 跳过数据库/数据中间件端口
        </label>
      </div>

      <div className="row">
        <label style={{ margin: 0 }}>并发</label>
        <input type="number" style={{ width: '80px' }} value={cfg.workers ?? 30} min={1} max={200}
          onChange={e => onChange({ ...cfg, workers: +e.target.value })} />
        <label style={{ margin: 0 }}>超时 ms</label>
        <input type="number" style={{ width: '90px' }} value={cfg.timeoutMs ?? 3000} min={500} max={10000}
          onChange={e => onChange({ ...cfg, timeoutMs: +e.target.value })} />
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
        真实性验证层级: baseline(随机路径对比) + 关键字 + 最小长度 + 重定向统一性,命中任一即过滤
      </div>
    </div>
  );
}

// ─── 总入口 ──────────────────────────────────────────
export function ModuleConfigPanel({
  moduleIds, configs, onChange,
}: {
  moduleIds: string[];
  configs: Record<string, any>;
  onChange: (moduleId: string, cfg: any) => void;
}) {
  if (moduleIds.length === 0) return null;
  return (
    <div>
      {moduleIds.map(id => {
        const cfg = configs[id] || {};
        if (id === 'port-discovery') return <PortDiscoveryConfig key={id} cfg={cfg} onChange={c => onChange(id, c)} />;
        if (id === 'db-endpoint-probe') return <DbEndpointProbeConfig key={id} cfg={cfg} onChange={c => onChange(id, c)} />;
        if (id === 'fingerprint') return <FingerprintConfig key={id} cfg={cfg} onChange={c => onChange(id, c)} />;
        if (id === 'weak-password') return <WeakPasswordConfig key={id} cfg={cfg} onChange={c => onChange(id, c)} />;
        if (id === 'dirsearch') return <DirsearchConfig key={id} cfg={cfg} onChange={c => onChange(id, c)} />;
        return (
          <div key={id} className="module-cfg">
            <h4>{id}</h4>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>该模块暂无专属配置</div>
          </div>
        );
      })}
    </div>
  );
}
