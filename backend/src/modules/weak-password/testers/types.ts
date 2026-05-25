export interface TesterResult {
  success: boolean;
  username?: string;
  password?: string;
  message?: string;
  /** 服务器版本/握手信息（可选） */
  banner?: string;
}

export interface TesterContext {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

/**
 * 数据库 tester 约定：
 *   - 只测试一组凭据。命中 → success=true。
 *   - 连接失败（TCP 级错误）→ 返回 success=false + message，不抛异常。
 *   - 认证失败 → success=false。
 */
export type Tester = (ctx: TesterContext) => Promise<TesterResult>;

/** 空凭据（未授权访问）时约定用户名/密码都传空字符串 */
export const UNAUTH = { username: '', password: '' };
