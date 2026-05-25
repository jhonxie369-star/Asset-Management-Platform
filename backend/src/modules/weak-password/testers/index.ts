import type { Tester } from './types.js';
import { testMysql } from './mysql.js';
import { testPostgres } from './postgres.js';
import { testRedis } from './redis.js';
import { testMongodb } from './mongodb.js';
import { testCassandra } from './cassandra.js';
import { testAerospike, testHbase } from './tcp-reachable.js';
import { testClickhouse, testElasticsearch, testCouchdb, testInfluxdb } from './http-basic.js';
import { testEtcd, testKafka, testMemcached, testNeo4j, testRabbitmq, testZookeeper } from './data-services.js';
import {
  testArgoCd, testFlink, testGrafana, testKafkaConnect, testKubelet,
  testMinio, testNacos, testPrometheus, testSuperset, testZabbix,
} from './web-management.js';

/**
 * 支持的数据库类型 → tester。key 是 dbs[].name，UI/配置层面对齐。
 * PolarDB / ADB / StarRocks 都走 MySQL 协议，复用 mysql tester。
 */
export const TESTERS: Record<string, Tester> = {
  mysql: testMysql,
  mariadb: testMysql,
  polardb: testMysql,
  adb: testMysql,
  starrocks: testMysql,
  tidb: testMysql,
  oceanbase: testMysql,
  doris: testMysql,

  postgres: testPostgres,

  redis: testRedis,

  mongodb: testMongodb,

  cassandra: testCassandra,

  clickhouse: testClickhouse,
  elasticsearch: testElasticsearch,
  opensearch: testElasticsearch,
  couchdb: testCouchdb,
  influxdb: testInfluxdb,

  aerospike: testAerospike,
  hbase: testHbase,
  memcached: testMemcached,
  zookeeper: testZookeeper,
  etcd: testEtcd,
  neo4j: testNeo4j,
  rabbitmq: testRabbitmq,
  kafka: testKafka,

  kubelet: testKubelet,
  grafana: testGrafana,
  minio: testMinio,
  nacos: testNacos,
  argocd: testArgoCd,
  superset: testSuperset,
  flink: testFlink,
  prometheus: testPrometheus,
  zabbix: testZabbix,
  'kafka-connect': testKafkaConnect,
};

/** 默认配置模板，用户可在 UI 编辑 */
export interface DbProfile {
  name: string;
  enabled: boolean;
  /** 默认端口白名单（用户扩充） */
  ports: number[];
  /** 命中以下指纹 product 的 endpoint 也会被测（并集） */
  fingerprintProducts: string[];
  checks?: { anonymous?: boolean; plaintext?: boolean; weakPassword?: boolean };
}

export const DEFAULT_DB_PROFILES: DbProfile[] = [
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
};

/**
 * 全局兜底(追加)。默认只放两条最通用,真正细分的交给 PASSWORDS_MAP。
 * 建议用户在"全局追加"里写企业内部的统一弱密码,不必每个 DB 复制。
 */
export const DEFAULT_EXTRA_PASSWORDS: string[] = [];

/**
 * 按 DB 独立的密码字典 — 核心目的是把无意义尝试砍掉
 * (例如把 'foobared' 喂给 MySQL 纯属浪费).
 * 顺序:把最可能命中的放前面,配合 stopOnFirstHit 能快速判掉大部分目标.
 */
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
};

/** @deprecated 保留以兼容旧 config.passwords (flat array),新逻辑走 PASSWORDS_MAP */
export const DEFAULT_PASSWORDS = [
  '', 'root', 'root123', '123456', '12345678', 'admin', 'admin123', 'password', 'P@ssw0rd',
];
