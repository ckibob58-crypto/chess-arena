#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/server"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then echo 'Для сервера нужен Node.js 22 LTS: https://nodejs.org/'; read -r -p 'Enter…'; exit 1; fi
if [ ! -d node_modules ]; then npm install; fi
export HOST="${HOST:-0.0.0.0}" PORT="${PORT:-8787}"
if [ -z "${CHESS_ARENA_SECRET:-}" ]; then CHESS_ARENA_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"; export CHESS_ARENA_SECRET; fi
echo "Chess Arena API: http://127.0.0.1:$PORT/api/health"
echo 'Для теста в одной Wi-Fi-сети укажи LAN-IP этого Mac и порт 8787.'
npm start
