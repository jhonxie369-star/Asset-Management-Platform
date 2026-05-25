import type { FindingSeverity, LiveEndpoint, Service } from '@sasp/shared';
import type { Tester } from './testers/types.js';

export type AuthCheckKind = 'weak_password' | 'unauth' | 'anonymous_login' | 'plaintext_protocol' | 'default_credential' | 'auth_exposure';

export interface AuthChecksConfig {
  /** 匿名/未授权类检查，通常请求次数很少，默认可开 */
  anonymous?: boolean;
  /** 明文认证协议暴露检查，不做爆破，只基于服务属性输出风险 */
  plaintext?: boolean;
  /** 真正的用户名/密码枚举，默认应谨慎开启 */
  weakPassword?: boolean;
}

export interface AuthProfile {
  name: string;
  enabled: boolean;
  ports: number[];
  fingerprintProducts: string[];
  checks?: AuthChecksConfig;
}

export interface AuthTesterDefinition {
  id: string;
  name: string;
  protocols: string[];
  defaultPorts: number[];
  fingerprintProducts: string[];
  defaultEnabled: boolean;
  credentialTester?: Tester;
  checks: Required<AuthChecksConfig>;
}

export interface AuthTarget {
  endpoint: LiveEndpoint;
  service?: Service;
  profile: AuthProfile;
  tester: AuthTesterDefinition;
  matchedBy: 'port' | 'fingerprint' | 'protocol' | 'both';
  selectionReason?: string;
}

export interface AuthFindingDraft {
  type: AuthCheckKind;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidence?: string;
  recommendation: string;
  dedupeKey: string;
  credentials?: { username: string; password?: string; passwordMasked?: string; passwordEmpty?: boolean };
}
