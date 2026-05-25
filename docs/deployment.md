# SASP 部署调优笔记

在 4 核 8G 及以上服务器上做正式部署前,做一次性系统层调优。本地开发可跳过。

## 1. 提 fd 上限

port-discovery workers 开到 500+ 时,**默认 1024 的 fd 上限会很快 EMFILE**。

```bash
# 当前 shell(临时)
ulimit -n 65536

# 永久生效 — 编辑 /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536

# systemd 启动的话,服务 unit 里加
[Service]
LimitNOFILE=65536
```

## 2. 放大 libuv 线程池

Node 的 DNS 解析、文件 I/O 走 libuv 线程池,默认 **4 个**。指纹模块批量 HTTP + DNS 场景下会被卡。

```bash
# 启动前 export
export UV_THREADPOOL_SIZE=16
```

或加到 `sasp.sh` 里 `cmd_start`:

```bash
UV_THREADPOOL_SIZE=16 PORT="$PORT" HOST="$HOST" nohup \
  "$SCRIPT_DIR/node_modules/.bin/tsx" backend/src/server.ts ...
```

## 3. TCP 层调优(只在做大规模公网扫描时才需要)

port-discovery workers ≥ 1000 且目标集中在同一网段时,TIME_WAIT 堆积到 28000 会卡住。

```bash
# 允许 TIME_WAIT 端口被新连接复用(安全,标准调优)
sudo sysctl -w net.ipv4.tcp_tw_reuse=1

# 扩大本地端口池(默认 32768-60999)
sudo sysctl -w net.ipv4.ip_local_port_range="10000 65535"

# 永久生效 — 写入 /etc/sysctl.conf
echo "net.ipv4.tcp_tw_reuse=1" >> /etc/sysctl.conf
echo "net.ipv4.ip_local_port_range=10000 65535" >> /etc/sysctl.conf
sysctl -p
```

## 4. 模块默认并发参考表

| 模块 | 默认 workers | 调整建议 |
|---|---|---|
| port-discovery | **500** | 内网扫可上到 1000;公网扫降到 200,防触发对端 IDS |
| fingerprint | **60** | 每 worker 峰值响应缓冲 ~5MB,60 个合计 300MB,8G 内存充裕 |
| dirsearch | **30** | 同 web 服务高并发易触发 WAF 429;需要时配合 `delayBetweenMs` |
| weak-password | **20** | 对端会记忆认证失败,高并发触发 `max_connect_errors`/fail2ban 反而变慢 |

性价比拐点:I/O 轻模块(port-discovery)可扩展性很好,**weak-password 过 50 基本无收益**,过高反被封 host。

## 5. 资源监控

跑 port-discovery 500 并发时,另开一个 shell:

```bash
# 看 TIME_WAIT 堆积
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c

# 看 SASP 进程的 fd 占用
ls /proc/$(cat /home/ubuntu/chaomeng/tools/Asset-Management-Platform/.sasp.pid)/fd | wc -l

# 看 CPU / 内存
top -p $(cat /home/ubuntu/chaomeng/tools/Asset-Management-Platform/.sasp.pid)
```

正常情况下稳态 TIME_WAIT 应该在 15000 以下;超过 20000 就要考虑上 tcp_tw_reuse。

## 6. 生产还要考虑

- **日志轮转**:`sasp.log` 不会自己轮转,加 logrotate
- **HTTPS 反代**:目前 HTTP 裸跑,正式环境前面挂 nginx/caddy 开 TLS,把 session cookie 改 `secure: true`
- **SASP_SESSION_SECRET**:`.env` 里一定要改成随机 64 字节串,别用默认 `change-this-*`
- **备份 `backend/data/store.json`**:定时 cron,资产列表和任务历史都在里面
- **CloudQuery PG 凭据**:正式部署别 `VAULT_SKIP_VERIFY=true`,配好 CA 证书
