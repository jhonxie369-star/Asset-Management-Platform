# Auth Audit Refactor Log

Date: 2026-05-15

## Goal

把原 `weak-password` 从“数据库弱口令模块”改造成“认证面巡检模块”的内部架构，同时保留 `weak-password` module id 兼容已有任务和历史数据。

## Change 1: 新增认证巡检通用类型

- Files:
  - `backend/src/modules/weak-password/types.ts`
- What changed:
  - 新增 `AuthTesterDefinition`、`AuthProfile`、`AuthTarget`、`AuthFindingDraft`。
  - 新增认证风险类型语义：`weak_password`、`unauth`、`anonymous_login`、`plaintext_protocol`、`default_credential`、`auth_exposure`。
- Why:
  - 现有 `DbProfile` 只能描述数据库，无法统一承载 FTP/SSH/HTTP Basic 等协议。
  - 终局需要把“认证风险”抽象出来，而不是每种协议做成独立页面模块。
- Risk control:
  - 不删除旧 `DbProfile`，旧配置仍可通过 `dbs` 进入模块。

## Change 2: 新增 tester registry

- Files:
  - `backend/src/modules/weak-password/registry.ts`
- What changed:
  - 把现有数据库 tester 注册为 `AUTH_TESTERS`。
  - 新增 `DEFAULT_AUTH_PROFILES`，在现有 DB profile 基础上加入 `ftp`。
  - FTP 默认配置：`anonymous=true`、`plaintext=true`、`weakPassword=false`。
- Why:
  - 让 tester 元数据、默认端口、指纹、检查项集中维护。
  - FTP 默认只做低次数检查，避免默认进入弱口令爆破。
- Risk control:
  - 数据库 tester 仍复用原实现；没有改变 MySQL/Postgres/Redis/MongoDB 的协议连接代码。

## Change 3: 新增 target resolver

- Files:
  - `backend/src/modules/weak-password/resolver.ts`
- What changed:
  - 独立出 `resolveAuthTargets()`。
  - 支持端口、指纹 product、服务 protocol 三种匹配来源。
  - 如果已有明确 product/protocol 且不匹配当前 tester，则跳过，避免端口误判。
- Why:
  - 目标筛选逻辑从主模块拆出，后续加 SSH/Telnet/HTTP Basic 不需要改调度主体。
- Risk control:
  - 保留旧逻辑的核心原则：端口命中或指纹命中才会检测；明确指纹可以否决错误端口。

## Change 4: 新增 FTP tester

- Files:
  - `backend/src/modules/weak-password/testers/ftp.ts`
- What changed:
  - 新增 FTP banner 抓取。
  - 新增 anonymous 登录检测：`USER anonymous` + `PASS anonymous@`。
  - 新增可选 FTP 凭据测试函数 `testFtpCredential()`。
- Why:
  - 21 端口是典型认证面暴露，风险不属于数据库，但应该纳入认证巡检。
- Risk control:
  - 默认不启用 FTP 弱口令枚举，只检查匿名登录和明文协议暴露。
  - 单次 socket 有 timeout，命令只使用 `USER/PASS/QUIT`。

## Change 5: 重构 weak-password 主调度

- Files:
  - `backend/src/modules/weak-password/index.ts`
- What changed:
  - 模块显示名改为“认证面巡检”。
  - module id 保持 `weak-password`，兼容已有任务。
  - 支持新配置 `authProfiles`，同时兼容旧配置 `dbs`。
  - 生成 Finding 时密码改为脱敏字段 `passwordMasked`，不再把明文密码写入 finding 描述。
- Why:
  - 认证风险不只有弱口令，还包括匿名登录、未授权、明文认证协议。
  - 减少敏感凭据在结果表中长期明文沉淀。
- Risk control:
  - `config.dbs` 仍可用；老任务不会因为字段改名失效。
  - tester 执行异常只影响单次凭据，不中断整个任务。

## Change 6: 扩展 Finding 类型

- Files:
  - `shared/src/index.ts`
- What changed:
  - 新增 `anonymous_login`、`default_credential`、`plaintext_protocol`、`auth_exposure`。
- Why:
  - 让 Finding 层能表达认证面风险，而不是全部塞进 `weak_password`。
- Risk control:
  - 只扩展 union，不移除旧类型。

## Change 7: 前端配置适配

- Files:
  - `frontend/src/components/ModuleConfigs.tsx`
- What changed:
  - “弱口令”文案调整为“认证面巡检”。
  - 默认 profile 加入 FTP。
  - FTP 行新增检查项开关：匿名、明文、弱口令。
  - FTP 弱口令默认关闭。
- Why:
  - UI 需要表达 FTP 的“匿名/明文”检查，不应强行套 DB 弱口令语义。
- Risk control:
  - 原 DB 配置表仍保留，用户已有配置方式不变。

## Verification

1. Build verification

```bash
npm run build
```

Result: passed. Shared/backend/frontend all compiled successfully.

2. Resolver behavior verification

Command: used `node --import tsx` to call `resolveAuthTargets()` with mock endpoints.

Cases:

- `141.144.247.9:21` + service protocol `ftp`/product `vsftpd` matched FTP tester.
- `127.0.0.1:21` + service protocol `http`/product `Nginx` did not match FTP tester.
- `127.0.0.1:3306` still matched existing DB profiles by port.

Result: passed.

## Known Follow-ups

- `mysql` and `adb` both include port `3306`;无指纹时会各生成一个候选。这是历史配置行为，不是本次新增问题。后续可通过 profile priority 或 mutuallyExclusive group 优化。
- 模块 id 仍是 `weak-password`。等 UI/任务和历史数据迁移稳定后，可新增 `auth-audit` alias。
