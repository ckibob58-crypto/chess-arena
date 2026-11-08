#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT=8174
URL="http://127.0.0.1:${PORT}/preview.html"
if ! command -v python3 >/dev/null 2>&1; then echo 'Python 3 не найден.'; read -r -p 'Enter…'; exit 1; fi
python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/chess-arena-limited-preview.log 2>&1 &
PID=$!
cleanup(){ kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
for n in {1..30}; do if curl -fsS "$URL" >/dev/null 2>&1; then break; fi; sleep 0.2; done
open "$URL"
echo 'Это только ограниченный Preview без сетевой игры и серверных аккаунтов. Для полного приложения запусти Open-Chess-Arena.command.'
wait "$PID"
