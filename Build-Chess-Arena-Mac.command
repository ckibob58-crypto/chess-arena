#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

printf '\n========================================\n'
printf '       CHESS ARENA — macOS arm64\n'
printf '========================================\n'
printf 'Этот скрипт создаёт dist/ и готовый .dmg в release/.\n'
printf 'Открытие preview.html само по себе ничего не собирает.\n\n'

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js не найден.'
  echo 'Установи Node.js 22 LTS с https://nodejs.org/ и запусти этот файл снова.'
  echo
  read -r -p 'Нажми Enter для выхода…'
  exit 1
fi

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(node -p 'Number(process.versions.node.split(".")[1])')"
SUPPORTED=0
if [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 19 ]; then SUPPORTED=1; fi
if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 12 ]; then SUPPORTED=1; fi
if [ "$SUPPORTED" -ne 1 ]; then
  echo "Нужен Node.js 20.19+ или 22.12+. Сейчас установлен: $NODE_VERSION"
  read -r -p 'Нажми Enter для выхода…'
  exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  echo "Предупреждение: текущая архитектура $ARCH, а целевая сборка — Apple Silicon arm64."
fi

echo "Node.js: $NODE_VERSION"
echo 'Устанавливаю зависимости и локальные файлы Stockfish…'
npm install

echo
echo 'Собираю Chess Arena для Apple Silicon (.dmg)…'
npm run dist:mac-arm64

if [ ! -d "$ROOT/dist" ]; then
  echo 'ОШИБКА: папка dist не создана — Vite-сборка не завершилась успешно.'
  exit 1
fi
if [ ! -d "$ROOT/release" ]; then
  echo 'ОШИБКА: папка release не создана — сборка DMG не завершилась успешно.'
  exit 1
fi
DMG_COUNT=$(find "$ROOT/release" -maxdepth 1 -type f -name '*.dmg' | wc -l | tr -d ' ')
if [ "$DMG_COUNT" -eq 0 ]; then
  echo 'ОШИБКА: сборка завершилась без DMG. Проверь вывод electron-builder выше.'
  exit 1
fi

echo
echo "Готово. dist/ содержит веб-сборку; найдено DMG: $DMG_COUNT в release/. Открываю папку с установщиком."
open "$ROOT/release"
echo 'Найди файл Chess-Arena-*.dmg, открой его и перетащи Chess Arena в Applications.'
echo
echo 'Если macOS покажет предупреждение о неподтверждённом разработчике, смотри раздел безопасности в BUILD_MAC_ARM64_RU.md.'
read -r -p 'Нажми Enter для закрытия…'
