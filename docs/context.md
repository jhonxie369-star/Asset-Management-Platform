# SASP 当前上下文

> 安全资产扫描平台（Security Asset Scan Platform）当前的架构、数据模型、模块契约、代码改动全景快照。
> 生成时间：2026-05-12

---

## 一、整体定位

**资产为核心 + 模块化能力 + 统一结果沉淀** 的全栈安全扫描平台。
**不做缝合怪**：所有能力（dirsearch、弱口令、指纹、AI 测试）都是可插拔模块，结果统一归集到资产/服务/发现/报告。

## 二、整体架构

```
                        ┌─────────────────────────────┐
                        │    安全资产扫描平台 (SASP)     │
                        └──────────────┬──────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
┌───────────────┐            ┌───────────────┐            ┌───────────────┐
│   数据层       │            │   引擎层       │            │   沉淀层       │
│  Data Core    │            │  Engine       │            │  Knowledge    │
└───────┬───────┘            └───────┬───────┘            └───────┬───────┘
        │                            │                            │
        ▼                            ▼                            ▼
  Asset → LiveEndpoint         Task → Run → Result          Rule / Module
         → Service → WebPath   (任务) (执行) (证据)         (指纹/风险/能力)
        │                            │                            │
        └────────────────────────────┼────────────────────────────┘
                                     ▼
                          ┌───────────────────┐
                          │ Enrichment Pipeline │
                          │  (统一归集管道)      │
                          └─────────┬─────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              Finding          Report          AI Copilot
              (问题)           (报告)           (智能)
```

---

## 三、数据层分层（关键设计）

### 严格分层，语义清晰

```
Asset          = ip               "有这台机"
LiveEndpoint   = ip + port + alive "这端口开着"              ← port-discovery 产出
Service        = LiveEndpoint + protocol/product/title "这端口有什么服务"  ← fingerprint 产出
WebPath        = Service + url/path/statusCode "这服务上有什么路径"       ← dirsearch 产出
```

**核心语义澄清**：
- "TCP 连接建立" ≠ "有服务"。LiveEndpoint 只表示端口活着，不代表有可识别的服务。
- Service 是 LiveEndpoint + HTTP 探测 + 规则匹配后的丰满对象。
- 每层都有自己的生命周期字段（firstSeenAt / lastSeenAt / disappearedAt）。

### 数据模型 ER

```
Asset (1) ──< (N) LiveEndpoint (1) ── (0..1) Service (1) ──< (N) WebPath
                                         │                      │
Asset ──< (N) Finding ──> (0..1) LiveEndpoint / Service / WebPath
```

### 落库表

```
assets          资产当前态 (ip)
liveEndpoints   活端点当前态 (ip+port+alive)
services        已识别服务当前态 (ip+port+protocol+product+指纹)
webPaths        Web 路径当前态

tasks           任务配置（含定时规则）
runs            任务执行历史
results         统一证据层（历史，不覆盖）

findings        问题发现当前态（dedupeKey 去重）
fingerprintRules 指纹规则库
modules          模块元数据

portLists       端口列表（用户创建）
assetLists      资产列表（用户创建，支持 CIDR / IP 范围粘贴）
```

---

## 四、模块契约（关键设计）

### 模块通过 targetType 声明输入

| targetType | 含义 | 典型模块 |
|------------|------|----------|
| `asset` | Asset (ip 层面) | port-discovery |
| `endpoint` | LiveEndpoint (活端点) | fingerprint、dirsearch、weak-password |
| `service` | Service (已识别服务) | 针对性审计模块 |
| `web_path` | WebPath | AI 测试 |

### 模块通过 Result.resultType 声明产出

| resultType | 语义 | Pipeline 归集目标 |
|------------|------|-------------------|
| `endpoint_alive` | 活端点 | liveEndpoints 表 |
| `service_identified` | 服务识别 | services 表 |
| `web_path` | 路径发现 | webPaths 表 |
| `finding` | 问题 | findings 表（dedupeKey 去重） |
| `change` | 变化 | 转为 Finding |
| `log` / `error` | 日志 | 只写 results |

**模块绝不直接写库**，全部通过 yield Result → Pipeline → reducer 更新。

### 串行链设计（关键）

`Task.modules` 数组按顺序串行：
- 每个模块是独立进程单元，有自己的 Run 记录
- 上游产出的 endpoint/service IDs 通过 `scopedEndpointIds` / `scopedServiceIds` 传给下游
- 下游默认只处理"本次 Run 新发现"的数据，不扫全表

**典型链**：
```
port-discovery → fingerprint → dirsearch → ...

port-discovery:
  输入: Asset (ip 列表)
  输出: endpoint_alive → LiveEndpoint 表

fingerprint:
  输入: LiveEndpoint (只看刚扫出来的 scopedEndpointIds)
  输出: service_identified → Service 表（可能命中多条规则）
```

### Worker Pool 并发

**每个模块有独立 Worker Pool**，互不干扰：
- `port-discovery.workers` 控制 TCP 连接并发
- `fingerprint.workers` 控制 HTTP 请求并发

模式：`任务队列 + N 个 worker，完成一个补一个`。

---

## 五、核心组件

### 1. Enrichment Pipeline (backend/src/pipeline/enrichment.ts)

统一归集入口：
```
Result → Dedup → Correlate → Enrich → Evaluate → Dispatch
       ↓        ↓            ↓         ↓           ↓
    去重      关联到 Asset  补上下文  触发 RiskRule  写入各当前态表
```

`handleEndpointAlive`：写 liveEndpoints，回填 endpointId 到 Result，触发 `new_endpoint` Finding。
`handleServiceIdentified`：按 endpointId 找/建 Service，合并指纹，触发 `new_service` Finding。

### 2. TaskEngine (backend/src/engine/task-engine.ts)

- 串行执行 modules 链
- 每个模块独立 Run 记录
- 跨模块通过 scopedEndpointIds/scopedServiceIds 传递
- resolveTargets 根据 targetType 过滤

### 3. Scheduler (backend/src/engine/scheduler.ts)

- 每 30 秒 tick 一次
- 支持 `cron: "HH:mm"` 每日定时
- 支持 `intervalMinutes` 间隔执行
- 同一分钟不重复触发

### 4. Module (backend/src/modules/)

- `port-discovery.ts` — TCP connect 扫描，输出活端点
- `fingerprint.ts` — HTTP 探测 + 规则匹配，输出已识别服务

### 5. Store (backend/src/storage/store.ts)

- JSON 持久化（backend/data/store.json）
- 泛型 CRUD：`getAll / getById / insert / update / upsert / delete / query`
- `init()` 时合并 EMPTY 默认结构，兼容老数据

---

## 六、前端结构

**页面**：
- `/` 总览 Dashboard
- `/assets` 资产清单
- `/endpoints` 活端点（新）
- `/services` 服务清单
- `/tasks` 任务中心（两栏布局：配置 + 执行日志/定时任务）
- `/findings` 问题发现（两视图：按问题 / 按扫描报告）
- `/asset-lists` 资产列表管理
- `/port-lists` 端口列表管理

**关键 UI 设计**：
- 任务中心左右两栏：左侧扫描配置，右侧执行日志+保存为定时任务
- 模块选择显示按勾选顺序的序号，体现串行链
- 模块卡片显示 `(资产 / 端点 / 服务)` 目标类型
- 预览框实时显示总任务数 + 预估耗时
- 服务/端点清单有 "showGone" 筛选，消失态半透明

---

## 七、启停脚本

```bash
./sasp.sh start    # 启动（自动检 node_modules + frontend/dist）
./sasp.sh stop     # 停止（PID 优雅停 → 超时 kill -9 → 兜底清端口）
./sasp.sh restart  # 重启
./sasp.sh status   # 状态
./sasp.sh logs     # tail -f 日志
./sasp.sh rebuild  # 重建前端 + 自动热重启
```

`PORT=8080 ./sasp.sh start` 支持自定义端口。
PID 存 `.sasp.pid`，日志存 `sasp.log`。

---

## 八、重要改动历史

1. **v0 → v0.1 重写** — 从 scanner-centric 重构为 asset-centric 架构
2. **端口列表 / 资产列表引入** — 规则引擎风格，配置和策略解耦
3. **Worker Pool 替代循环并发** — 完成一个补一个，避免会话打爆
4. **模块重命名** — service-discovery → port-discovery（更准确）
5. **数据分层** — 引入 LiveEndpoint，区分"端口活着" vs "有服务"
6. **串行链 + scopedIds** — 模块间松耦合但数据可传递
7. **SPA fallback / dataDir 统一** — 修复刷新 404 和双 data 目录问题

---

## 九、待办 / 未完成

- 服务消失检测的自动 sweep（每次 Run 结束后标记 disappearedAt）
- dirsearch 模块（targetType=endpoint，输出 web_path）
- 数据库弱口令模块（mysql/redis/postgres，intrusive 风险等级）
- AI Copilot 基础能力
- Finding 的按条确认/忽略 UI
- Schedule 的启用/暂停开关（目前只能删除）

---

## 十、技术栈

- **shared**: TypeScript 类型定义
- **backend**: Node.js + Express + tsx（直接跑 TS，无 build）
- **frontend**: React 18 + Vite + React Router 6
- **持久化**: JSON 文件（前期简单，后期替换 SQLite/Postgres）

---

## 十一、关键文件索引

```
shared/src/index.ts                  所有数据类型定义
backend/src/server.ts                启动入口
backend/src/storage/store.ts         JSON 存储 + 泛型 CRUD
backend/src/pipeline/enrichment.ts   归集管道
backend/src/engine/task-engine.ts    任务执行引擎
backend/src/engine/scheduler.ts      定时调度
backend/src/engine/module-interface.ts  模块接口契约
backend/src/modules/port-discovery.ts   端口发现模块
backend/src/modules/fingerprint.ts      指纹识别模块
backend/src/http/*.ts                RESTful API 路由
frontend/src/App.tsx                 路由
frontend/src/pages/*.tsx             各页面
sasp.sh                              启停脚本
```

---

## 十二、设计原则（始终遵守）

1. **资产是核心，不是扫描器是核心**
2. **所有能力都模块化，但输出统一 Result**
3. **Result 是历史证据，Service/Endpoint/WebPath/Finding 是当前沉淀**
4. **Pipeline 统一归集，模块不关心如何更新资产**
5. **模块声明式配置（ModuleDefinition），加新模块不改核心代码**
6. **外部工具通过 Adapter 接入（未来的 dirsearch），可替换不耦合**
7. **命名反映语义**：模块名说"做什么"，数据层名说"是什么"
