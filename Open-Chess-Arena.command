#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/webapp"
echo 'Chess Arena 1.2.7 — полное приложение'
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Для полной версии нужен Node.js 22 LTS: https://nodejs.org/'
  read -r -p 'Нажми Enter для выхода…'
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then echo 'Нужен Node.js 20.19+ или 22 LTS.'; read -r -p 'Enter…'; exit 1; fi
if [ ! -d node_modules ]; then echo 'Устанавливаю React, Vite и Stockfish (первый запуск)…'; npm install; fi
if [ ! -f public/engine/stockfish-19-lite-single.wasm ]; then npm run copy:engine; fi
URL='http://127.0.0.1:8173/'
npm run dev &
PID=$!
cleanup(){ kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
for n in {1..60}; do if curl -fsS "$URL" >/dev/null 2>&1; then break; fi; sleep 0.5; done
open "$URL"
echo 'Оставь это окно открытым во время игры.'
wait "$PID"
