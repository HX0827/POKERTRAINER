#!/bin/bash

set -u

MIST_PROJECT_DIR="/Users/tom/Downloads/德州/ai-poker-trainer"
MIST_RUNTIME_DIR="${MIST_PROJECT_DIR}/.local-run"
MIST_PID_FILE="${MIST_RUNTIME_DIR}/mist-table.pid"
MIST_LOG_FILE="${MIST_RUNTIME_DIR}/mist-table.log"
# 存在这个标记文件 = 有人(通常是 Claude 改完代码后)请求干净重启:
# 先杀掉旧服务和所有占着 3000 的进程,再按全新启动走。标记用完即焚。
MIST_RESTART_MARKER="${MIST_RUNTIME_DIR}/restart-requested"
MIST_URL="http://localhost:3000"
# 思考中继:workerd 直连 DeepSeek 拿思考回复会挂死,由这个 Node 小进程代转。
MIST_RELAY_PID_FILE="${MIST_RUNTIME_DIR}/think-relay.pid"
MIST_RELAY_LOG_FILE="${MIST_RUNTIME_DIR}/think-relay.log"
MIST_RELAY_URL="http://127.0.0.1:3210"
MIST_RELAY_SCRIPT="${MIST_PROJECT_DIR}/scripts/think-relay.mjs"

open_table() {
  /usr/bin/open "${MIST_URL}"
}

server_is_ready() {
  /usr/bin/curl -fsS "${MIST_URL}" 2>/dev/null | /usr/bin/grep -q "黑雾训练桌"
}

server_is_running() {
  if [ ! -f "${MIST_PID_FILE}" ]; then
    return 1
  fi

  MIST_SERVER_PID="$(/bin/cat "${MIST_PID_FILE}")"
  [ -n "${MIST_SERVER_PID}" ] && /bin/kill -0 "${MIST_SERVER_PID}" >/dev/null 2>&1
}

relay_is_ready() {
  /usr/bin/curl -fsS "${MIST_RELAY_URL}" 2>/dev/null | /usr/bin/grep -q "mist-think-relay"
}

ensure_relay() {
  if relay_is_ready; then
    return 0
  fi
  /usr/bin/nohup /bin/zsh -lc \
    "exec node '${MIST_RELAY_SCRIPT}'" \
    >"${MIST_RELAY_LOG_FILE}" 2>&1 </dev/null &
  /bin/echo "$!" >"${MIST_RELAY_PID_FILE}"
}

if [ -f "${MIST_RESTART_MARKER}" ]; then
  /bin/rm -f "${MIST_RESTART_MARKER}"
  if [ -f "${MIST_PID_FILE}" ]; then
    MIST_OLD_PID="$(/bin/cat "${MIST_PID_FILE}")"
    [ -n "${MIST_OLD_PID}" ] && /bin/kill "${MIST_OLD_PID}" >/dev/null 2>&1
  fi
  # 手动起的 dev、残留的 workerd、旧中继——凡是占着端口的一并请走,端口必须干净。
  /usr/sbin/lsof -ti :3000 2>/dev/null | /usr/bin/xargs /bin/kill -9 2>/dev/null
  /usr/sbin/lsof -ti :3210 2>/dev/null | /usr/bin/xargs /bin/kill -9 2>/dev/null
  /bin/rm -f "${MIST_PID_FILE}" "${MIST_RELAY_PID_FILE}"
  /bin/sleep 1
fi

/bin/mkdir -p "${MIST_RUNTIME_DIR}"
ensure_relay

if server_is_ready; then
  open_table
  exit 0
fi

if ! server_is_running; then
  /bin/rm -f "${MIST_PID_FILE}"
  /usr/bin/nohup /bin/zsh -lc \
    "cd '${MIST_PROJECT_DIR}' && exec /opt/homebrew/bin/npm run dev" \
    >"${MIST_LOG_FILE}" 2>&1 </dev/null &
  MIST_NEW_PID=$!
  /bin/echo "${MIST_NEW_PID}" >"${MIST_PID_FILE}"
fi

MIST_ATTEMPT=0
while [ "${MIST_ATTEMPT}" -lt 40 ]; do
  if server_is_ready; then
    open_table
    exit 0
  fi

  if ! server_is_running; then
    break
  fi

  /bin/sleep 0.5
  MIST_ATTEMPT=$((MIST_ATTEMPT + 1))
done

/usr/bin/osascript -e 'display alert "Mist Table 暂时无法启动" message "请稍后再试；如果仍然失败，请回到 Codex 告诉我。" as critical'
exit 1
