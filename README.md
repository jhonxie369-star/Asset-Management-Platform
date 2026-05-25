# Asset Management Platform / SASP

SASP（Security Asset Scan Platform）是一个以资产为中心的安全资产管理与巡检平台。平台把云资产同步、端口发现、指纹识别、认证面巡检、Web 路径扫描、风险发现和报表下载串成统一流水线，用“当前态 + 历史证据”的方式沉淀资产暴露面。

> 本仓库只包含项目源码、示例配置和文档；运行数据、资产列表、扫描结果、日志、数据库文件不会提交到 Git。

## 核心能力

- **资产列表管理**：支持手工录入 IP、CIDR、IP 范围、域名、`host:port:protocol` 数据库 endpoint；支持从 CloudQuery PostgreSQL 同步云资产清单。
- **端口列表管理**：端口策略独立维护，任务可选择不同端口列表组合执行。
- **端口发现**：按资产 × 端口进行 TCP 探测，实时沉淀活端点 `LiveEndpoint`。
- **指纹识别**：综合 banner、协议探针、HTTP/HTTPS、favicon、TLS、Web 路径信号识别服务产品、版本、协议和标签。
- **认证面巡检**：保留模块 id `weak-password`，实际覆盖弱口令、匿名访问、未授权读取、默认凭据、明文协议等认证风险。
- **Web 路径扫描**：内置精简 dirsearch 字典，支持路径有效性过滤、危险路径规则、历史路径重新评估。
- **问题发现**：统一展示弱口令、未授权、危险路径等风险，支持公网/私网、数据服务/非数据服务、严重级别、状态筛选和报告导出。
- **指纹统计**：查看历史指纹、现存指纹、每日新增指纹，并下钻到具体 IP、端口、机器。
- **任务中心**：支持立即执行、定时任务、模块链路编排、并发/超时/字典等参数编辑、执行日志查看。
- **API Key / CLI**：支持 Web Session 和 Bearer API Key，`cli/sasp-cli` 作为自动化接入入口。

## 平台结构

```text
Asset
  └─ LiveEndpoint        # ip:port 当前是否存活，由 port-discovery 产出
       └─ Service        # 协议/产品/版本/Title/指纹，由 fingerprint 产出
            └─ WebPath   # URL/path/status/title/body 摘要，由 dirsearch 产出

Task -> Run -> Result    # 任务、执行批次、模块原始证据
Result -> Enrichment     # 统一归集管道
Enrichment -> Finding    # 当前问题/风险
```

目录说明：

```text
shared/                 共享类型定义
backend/                Node.js + TypeScript 后端
  src/config/           环境配置
  src/engine/           TaskEngine、Scheduler、模块接口
  src/http/             REST API 路由
  src/modules/          扫描模块
  src/pipeline/         结果归集、Web 路径风险规则
  src/storage/          SQLite/Store 封装
frontend/               React + Vite 前端
  src/pages/            页面：资产、端点、任务、问题、指纹统计等
  src/components/       模块配置、分页等组件
cli/                    SASP CLI 薄封装
docs/                   架构、部署、变更说明
```

## 模块说明

| 模块 | ID | 目标 | 说明 |
|---|---|---|---|
| 端口发现 | `port-discovery` | 资产 | 对 IP/域名按端口列表做 TCP 探测，产出活端点。 |
| 数据库 Endpoint 探测 | `db-endpoint-probe` | 资产 | 面向 `host:port:protocol` 资产，解析域名并沉淀端点/服务。 |
| 指纹识别 | `fingerprint` | 端点 | 识别 HTTP、数据库、中间件、运维平台、Web 应用等服务指纹。 |
| 认证面巡检 | `weak-password` | 端点 | 检查弱口令、匿名访问、未授权读取、默认凭据、明文 FTP 等。 |
| Web 路径扫描 | `dirsearch` | 服务 | 对 HTTP 服务做路径枚举，并通过内容确认降低误报。 |

### 指纹识别覆盖

指纹规则位于：

```text
backend/src/modules/fingerprints/rules/
  databases.ts     数据库/数据服务
  devops.ts        运维、监控、Kubernetes、CI/CD
  middleware.ts    中间件、队列、网关
  webapps.ts       Web 应用、CMS、后台系统
```

识别信号包括：

- TCP banner / 专用协议 probe
- Kafka、Redis、Memcached、ZooKeeper、Aerospike 等协议探针
- HTTP status、header、title、body
- favicon hash
- TLS 证书信息
- WebPath 结果反哺指纹识别

### 指纹库管理

指纹规则可以在前端 `指纹库` 页面维护，也可以通过 API/CLI 自动化管理。

- 内置规则来自 `backend/src/modules/fingerprints/rules/`，启动时会同步到数据库。
- 内置规则支持启用/禁用；重启后会保留启用状态，同时跟随代码规则库升级。
- 自定义规则来源为 `user`，支持新增、编辑、删除。
- fingerprint 模块每次执行都会读取数据库中的启用规则，因此调整规则不需要重启服务。

常用 API：

```text
GET    /api/fingerprint-rules
POST   /api/fingerprint-rules
PUT    /api/fingerprint-rules/:id
DELETE /api/fingerprint-rules/:id
POST   /api/fingerprint-rules/reset-builtin
```

### 认证面巡检覆盖

认证 tester 位于：

```text
backend/src/modules/weak-password/testers/
```

当前覆盖：

- 数据库/数据服务：MySQL/MariaDB/PolarDB/ADB/StarRocks/TiDB/OceanBase/Doris、PostgreSQL、Redis、MongoDB、Cassandra、ClickHouse、Elasticsearch/OpenSearch、CouchDB、InfluxDB、Aerospike、HBase、Memcached、ZooKeeper、etcd、Neo4j、RabbitMQ、Kafka。
- Web 管理类：Kubelet、Grafana、MinIO、Nacos、Argo CD、Superset、Flink、Prometheus、Zabbix、Kafka Connect REST。
- FTP：匿名登录和明文协议暴露检查。

原则：

- 不能只因为端口开放就报问题，必须验证到可读能力、登录成功、数据/配置/列表读取等证据。
- Kafka 二进制协议和 Kafka Connect REST 分开检查。
- Kubelet 只做只读 GET；401/403 不报未授权。
- Web 路径风险需要内容确认，不是“看到路径就报警”。

## 任务与定时配置

任务由四部分组成：

```text
资产列表 + 端口列表 + 模块链路 + 模块参数
```

典型链路：

```text
公网暴露面巡检:
AssetList(public) × PortList(non-db-common)
  -> port-discovery -> fingerprint -> weak-password -> dirsearch

数据库认证面巡检:
AssetList(all-ip) × PortList(db-ports)
  -> port-discovery -> fingerprint -> weak-password

云数据库 Endpoint 巡检:
AssetList(db-endpoints)
  -> db-endpoint-probe -> weak-password
```

### 调度方式

Scheduler 每 30 秒检查一次任务和资产列表自动同步。时间按 `Asia/Shanghai`（北京时间）解释。

支持三类调度：

```json
{ "cron": "03:00" }
```

每日 03:00 执行。

```json
{ "cron": "18:00", "everyDays": 2 }
```

每 2 天 18:00 执行。

```json
{ "intervalMinutes": 60 }
```

每 60 分钟执行一次。

### 顺延和资源保护

- 同一时间多个定时任务到期时，Scheduler 会排序并串行执行。
- 如果已有任务运行，后续到期任务会等待并顺延，避免多个大任务同时抢占资源。
- `port-discovery`、`fingerprint`、`weak-password`、`dirsearch` 都支持独立 workers/timeout 配置。
- 大规模公网任务建议拆分端口策略，并避免数据库端口和 Web 目录扫描混跑。

### 常用参数建议

| 模块 | 参数 | 建议 |
|---|---|---|
| `port-discovery` | `workers` | 内网可较高，公网按目标质量谨慎上调。 |
| `fingerprint` | `workers` | HTTP/协议探针并发，注意响应缓冲带来的内存占用。 |
| `weak-password` | `workers` | 不宜过高，避免触发对端失败锁定、fail2ban 或连接错误。 |
| `dirsearch` | `workers` / `endpointParallel` / `perEndpointWorkers` | 路径扫描请求量大，优先控制总请求速率和单端点并发。 |

## 资产同步

CloudQuery 同步需要在 `.env` 中配置 PostgreSQL 连接信息：

```env
CLOUDQUERY_PG_URL=postgresql://user@db.example.invalid:5432/cloudquery
# 或拆分字段：
CLOUDQUERY_PG_HOST=db.example.invalid
CLOUDQUERY_PG_PORT=5432
CLOUDQUERY_PG_USER=cloudquery_user
CLOUDQUERY_PG_PASSWORD=change-me
CLOUDQUERY_PG_DATABASE=cloudquery
```

资产列表支持自动同步：

```json
{
  "strategy": "public",
  "cron": "03:00"
}
```

常见策略：

- `public`：公网 IP 资产。
- `private`：私网 IP 资产。
- `db-scan`：数据库认证面候选 IP。
- `db-endpoints`：云数据库/RDS endpoint。

## 数据与存储

默认数据目录：

```text
backend/data/
```

运行时会生成 SQLite 数据库、WAL、资产状态、扫描历史等文件。这些文件包含资产和扫描结果，必须留在运行环境中，不要提交到 Git。

`.gitignore` 默认排除：

```text
backend/data/*
.env
*.log
.sasp.pid
node_modules/
frontend/dist/
backend/dist/
```

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
npm start
```

默认访问：

```text
http://localhost:3400/
```

脚本方式：

```bash
./sasp.sh start
./sasp.sh status
./sasp.sh logs
./sasp.sh restart
./sasp.sh stop
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口，默认 `3400`。 |
| `HOST` | 监听地址，默认 `0.0.0.0`。 |
| `DATA_DIR` | 数据目录，默认 `./backend/data`。 |
| `SASP_USERNAME` / `SASP_PASSWORD` | Web 登录账号。 |
| `SASP_USERS` | 多用户配置，格式 `user:pass;user2:pass2`。 |
| `SASP_SESSION_SECRET` | Session 密钥，生产环境必须修改。 |
| `CLOUDQUERY_PG_*` | CloudQuery PostgreSQL 连接配置。 |
| `RETENTION_DAYS` | 资产状态/历史保留天数，默认按配置执行。 |

## 前端页面

- `资产列表管理`：创建、编辑、同步、导出资产列表。
- `端口列表管理`：维护常见端口、数据库端口、公网非数据库端口等策略。
- `任务中心`：配置任务链路、定时规则、模块参数、查看日志。
- `活端点与服务`：查看当前 ip:port、协议、产品、版本、Title、Web 路径、机器、公私网。
- `问题发现`：查看弱口令/未授权/危险路径，支持筛选、状态流转、下载报告。
- `指纹统计`：查看历史指纹、现存指纹、每日新增指纹和明细。
- `指纹库`：查看内置/自定义指纹规则，支持筛选、启用/禁用、复制和新增自定义规则。
- `风险路径规则`：配置 WebPath 风险检测规则并重评估历史路径。

## 开发命令

```bash
npm --workspace backend run typecheck
npm --workspace frontend run typecheck
npm --workspace backend run build
npm --workspace frontend run build
npm run build
npm start
```

## 安全注意事项

- 只在授权范围内使用扫描、认证巡检和路径扫描能力。
- 不要提交 `.env`、数据库文件、扫描结果、资产列表、日志或 API Key。
- 弱口令和未授权检测会对目标产生真实连接请求，生产环境请控制并发、超时和执行窗口。
- Web 路径扫描请求量大，公网扫描建议分批执行，并按端口/服务类型排除数据库端口。

## CLI 自动化入口

项目内置 `cli/sasp-cli`，用于 AI/CI/运维脚本通过稳定命令访问平台 API，避免直接改数据库或手写 curl。

### 认证方式

推荐使用 API Key：

```bash
export SASP_URL=http://127.0.0.1:3400
export SASP_API_KEY=sasp_xxx.yyy
cli/sasp-cli status
```

也可以用 Web 账号临时登录：

```bash
export SASP_USER=admin
export SASP_PASS=change-me
cli/sasp-cli modules
```

### 常用读取命令

```bash
cli/sasp-cli dashboard
cli/sasp-cli asset-lists
cli/sasp-cli port-lists
cli/sasp-cli endpoints --scope public --has-service true --with-service true --page-size 100
cli/sasp-cli findings kind=security lifecycle=current severity=critical scope=public
cli/sasp-cli findings-stats kind=security scope=public dataCategory=database
cli/sasp-cli fingerprint-daily days=14
cli/sasp-cli task-runs --page-size 20
cli/sasp-cli task-run-report <task_run_id>
cli/sasp-cli ai-context <ip_or_instance_or_keyword>
```

### 常用写入命令

```bash
cli/sasp-cli asset-list-create asset-list.json
cli/sasp-cli port-list-create port-list.json
cli/sasp-cli task-create task.json
cli/sasp-cli task-run <task_id>
cli/sasp-cli finding-status <finding_id> confirmed
cli/sasp-cli web-path-rules-reevaluate
```

JSON 支持文件或 stdin：

```bash
cat task.json | cli/sasp-cli task-create -
```

### CloudQuery 同步

```bash
cli/sasp-cli cloudquery-status
cli/sasp-cli cloudquery-preview public
cli/sasp-cli cloudquery-sync sync-public.json
cli/sasp-cli cloudquery-sync-batch sync-batch.json
```

### 导出报告

```bash
cli/sasp-cli --out db-report.json task-run-export <task_run_id> full json
cli/sasp-cli --out services.csv task-run-export <task_run_id> services csv
cli/sasp-cli --out assets.csv asset-list-export <asset_list_id> csv
```

### 通用 API 命令

新增 API 尚未封装成专用命令时，可以直接调用：

```bash
cli/sasp-cli api GET /modules
cli/sasp-cli api POST /tasks task.json
cli/sasp-cli api PUT /findings/<finding_id>/status status.json
```

查看完整命令：

```bash
cli/sasp-cli --help
cli/sasp-cli manifest
```
