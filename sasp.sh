#!/usr/bin/env bash
# SASP 启动脚本 — 支持 start / stop / restart / status / logs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.sasp.pid"
LOG_FILE="$SCRIPT_DIR/sasp.log"
PORT="${PORT:-3400}"
HOST="${HOST:-0.0.0.0}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[SASP]${NC} $*"; }
ok()    { echo -e "${GREEN}[SASP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[SASP]${NC} $*"; }
error() { echo -e "${RED}[SASP]${NC} $*" >&2; }

# ── 工具函数 ──────────────────────────────────────────────
is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

port_pid() {
  # 不依赖 lsof/fuser，使用 ss
  ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $NF}' | grep -oP 'pid=\K\d+' | head -1
}

ensure_deps() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    warn "未检测到 node_modules，开始 npm install..."
    npm install
  fi
  if [[ ! -d "$SCRIPT_DIR/frontend/dist" ]]; then
    warn "未检测到 frontend/dist，构建前端..."
    (cd "$SCRIPT_DIR/frontend" && npx vite build)
  fi
}

# ── 主命令 ────────────────────────────────────────────────
cmd_start() {
  if is_running; then
    warn "SASP 已在运行 (PID $(cat $PID_FILE))"
    return 0
  fi

  # 如果端口被其他进程占用，提示并清理
  local occupied
  occupied=$(port_pid || true)
  if [[ -n "$occupied" ]]; then
    warn "端口 $PORT 被进程 $occupied 占用，尝试清理..."
    kill -9 "$occupied" 2>/dev/null || true
    sleep 0.5
  fi

  ensure_deps

  info "启动 SASP (port=$PORT)..."
  PORT="$PORT" HOST="$HOST" setsid node --import tsx backend/src/server.ts \
    >"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待启动（最多 120 次 × 0.5s = 60s，给 tsx 冷启动 + seed 规则留够时间）
  for i in {1..120}; do
    if kill -0 "$pid" 2>/dev/null && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
      ok "启动成功 (PID $pid)"
      ok "访问: http://$HOST:$PORT/"
      ok "日志: tail -f $LOG_FILE"
      return 0
    fi
    sleep 0.5
  done

  error "启动超时或失败，查看日志: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 1
}

cmd_stop() {
  if ! is_running; then
    warn "SASP 未在运行"
    # 兜底清理端口
    local occupied
    occupied=$(port_pid || true)
    if [[ -n "$occupied" ]]; then
      warn "但端口 $PORT 被进程 $occupied 占用，清理中..."
      kill -9 "$occupied" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  info "停止 SASP (PID $pid)..."
  kill "$pid" 2>/dev/null || true

  for i in {1..10}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      ok "已停止"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 0.3
  done

  warn "优雅停止超时，强制 kill..."
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  ok "已强制停止"
}

cmd_restart() {
  cmd_stop
  sleep 0.5
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    ok "运行中 (PID $pid, port $PORT)"
    ss -ltnp 2>/dev/null | grep ":$PORT " || true
  else
    warn "未运行"
    local occupied
    occupied=$(port_pid || true)
    [[ -n "$occupied" ]] && warn "端口 $PORT 被其他进程 $occupied 占用"
  fi
}

cmd_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    warn "日志文件不存在: $LOG_FILE"
    return 1
  fi
  tail -f "$LOG_FILE"
}

cmd_rebuild() {
  info "重新构建前端..."
  (cd "$SCRIPT_DIR/frontend" && npx vite build)
  ok "构建完成"
  if is_running; then
    info "服务在运行，自动重启生效..."
    cmd_restart
  fi
}

# ── 入口 ──────────────────────────────────────────────────
case "${1:-}" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  rebuild)  cmd_rebuild ;;
  *)
    cat <<EOF
SASP 安全资产扫描平台控制脚本

用法: $0 {start|stop|restart|status|logs|rebuild}

  start    启动服务（自动检测依赖、前端构建）
  stop     停止服务
  restart  重启服务
  status   查看运行状态
  logs     实时查看日志 (tail -f)
  rebuild  重新构建前端并自动热更新

环境变量:
  PORT    监听端口 (默认 3400)
  HOST    监听地址 (默认 0.0.0.0)
EOF
    exit 1
    ;;
esac
