import type { Tester } from './testers/types.js';
import {
  TESTERS, DEFAULT_DB_PROFILES, DEFAULT_USERNAMES,
  DEFAULT_PASSWORDS_MAP, DEFAULT_EXTRA_PASSWORDS, DEFAULT_PASSWORDS,
  type DbProfile,
} from './testers/index.js';
import { testFtpCredential } from './testers/ftp.js';
import type { AuthProfile, AuthTesterDefinition } from './types.js';

export const AUTH_TESTERS: Record<string, AuthTesterDefinition> = {
  ...Object.fromEntries(DEFAULT_DB_PROFILES.map(p => [p.name, {
    id: p.name,
    name: p.name,
    protocols: protocolAliases(p.name),
    defaultPorts: p.ports,
    fingerprintProducts: p.fingerprintProducts,
    defaultEnabled: p.enabled,
    credentialTester: TESTERS[p.name] as Tester | undefined,
    checks: { anonymous: true, plaintext: false, weakPassword: true, ...(p.checks || {}) },
  } satisfies AuthTesterDefinition])),
  ftp: {
    id: 'ftp',
    name: 'FTP',
    protocols: ['ftp'],
    defaultPorts: [21],
    fingerprintProducts: ['FTP', 'vsftpd', 'ProFTPD', 'Pure-FTPd', 'FileZilla Server'],
    defaultEnabled: true,
    credentialTester: testFtpCredential,
    checks: { anonymous: true, plaintext: true, weakPassword: false },
  },
};

export const DEFAULT_AUTH_PROFILES: AuthProfile[] = [
  ...DEFAULT_DB_PROFILES,
  {
    name: 'ftp',
    enabled: true,
    ports: [21],
    fingerprintProducts: ['FTP', 'vsftpd', 'ProFTPD', 'Pure-FTPd', 'FileZilla Server'],
    checks: { anonymous: true, plaintext: true, weakPassword: false },
  },
];

export const DEFAULT_AUTH_USERNAMES: Record<string, string[]> = {
  ...DEFAULT_USERNAMES,
  ftp: ['ftp', 'anonymous', 'admin', 'test'],
};

export const DEFAULT_AUTH_PASSWORDS_MAP: Record<string, string[]> = {
  ...DEFAULT_PASSWORDS_MAP,
  ftp: ['', 'ftp', 'anonymous', 'anonymous@', 'admin', 'admin123', '123456', 'password'],
};

export { DEFAULT_EXTRA_PASSWORDS, DEFAULT_PASSWORDS };
export type { DbProfile };

function protocolAliases(name: string): string[] {
  const aliases: Record<string, string[]> = {
    mysql: ['mysql'], mariadb: ['mysql'], polardb: ['mysql'], adb: ['mysql'], starrocks: ['mysql'],
    tidb: ['mysql', 'tidb'], oceanbase: ['mysql', 'oceanbase'], doris: ['mysql', 'doris'],
    postgres: ['postgres', 'postgresql'], redis: ['redis'], mongodb: ['mongodb'], cassandra: ['cassandra'],
    clickhouse: ['clickhouse'], elasticsearch: ['elasticsearch'], opensearch: ['opensearch', 'elasticsearch'], couchdb: ['couchdb'], influxdb: ['influxdb'],
    aerospike: ['aerospike'], hbase: ['hbase'], memcached: ['memcached'], zookeeper: ['zookeeper'],
    etcd: ['etcd'], neo4j: ['neo4j'], rabbitmq: ['rabbitmq'], kafka: ['kafka'],
    kubelet: ['kubelet'], grafana: ['grafana'], minio: ['minio'], nacos: ['nacos'],
    argocd: ['argocd', 'argo cd'], superset: ['superset'], flink: ['flink'],
    prometheus: ['prometheus'], zabbix: ['zabbix'], 'kafka-connect': ['kafka-connect', 'kafka connect'],
  };
  return aliases[name] || [name];
}
