import type { Result, Run, ModuleDefinition, Asset, LiveEndpoint, Service } from '@sasp/shared';

/**
 * Module 接口：所有能力模块实现此接口
 *
 * ─── 数据契约 ─────────────────────────────
 * targetType 声明输入：
 *   asset     → Asset (ip 层面)              [port-discovery]
 *   endpoint  → LiveEndpoint (ip+port+alive) [fingerprint / dirsearch / weak-password]
 *   service   → Service (已识别服务)          [针对性审计模块]
 *   web_path  → WebPath                       [AI 测试]
 *
 * Result.resultType 声明产出：
 *   endpoint_alive     → 活端点 (port-discovery 输出)
 *   service_identified → 服务识别结果 (fingerprint 输出)
 *   web_path / finding / change / log
 *
 * Pipeline 负责把 Result 写到 LiveEndpoint/Service/WebPath/Finding 表。
 *
 * ─── 串行链 ───────────────────────────────
 * Task.modules 按顺序串行，上游产出的 endpoint/service 会传给下游：
 *   port-discovery → fingerprint → dirsearch → ...
 */
export interface IModule {
  definition: ModuleDefinition;
  execute(context: ModuleContext): AsyncGenerator<Result>;
}

export interface ModuleContext {
  run: Run;
  /** targetType=asset 时可用 */
  assets: Asset[];
  /** targetType=endpoint 时可用（活端点） */
  endpoints: LiveEndpoint[];
  /** targetType=service 时可用（已识别服务） */
  services: Service[];
  /** 模块配置 */
  config: Record<string, unknown>;
  /** 链式 Scope：上游本次 Run 产出的 endpoint IDs */
  scopedEndpointIds?: Set<string>;
  /** 链式 Scope：上游本次 Run 产出的 service IDs */
  scopedServiceIds?: Set<string>;
}
