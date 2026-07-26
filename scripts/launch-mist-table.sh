#!/bin/bash

set -u

MIST_PROJECT_DIR="/Users/tom/Downloads/德州/ai-poker-trainer"
MIST_RUNTIME_DIR="${MIST_PROJECT_DIR}/.local-run"
MIST_PID_FILE="${MIST_RUNTIME_DIR}/mist-table.pid"
MIST_LOG_FILE="${MIST_RUNTIME_DIR}/mist-table.log"
MIST_URL="http://localhost:3000"

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

if server_is_ready; then
  open_table
  exit 0
fi

/bin/mkdir -p "${MIST_RUNTIME_DIR}"

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
