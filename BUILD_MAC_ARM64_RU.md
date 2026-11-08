# Chess Arena 1.2.7 — Mac Apple Silicon (M1–M5)

## Сборка готового DMG

Требуются macOS на Apple Silicon, Node.js 20.19+ или 22.12+ и интернет для установки npm-зависимостей.

1. Распакуй комплект.
2. Открой папку `Chess-Arena-Mac`.
3. Запусти `Build-Chess-Arena-Mac.command`.
4. Дождись завершения `npm install`, Vite build и electron-builder.
5. Готовый `.dmg` ищи в папке `release/`.

Вручную:

```bash
npm install
npm run dist:mac-arm64
```

`dist/` — веб-сборка приложения. `release/` — macOS DMG. Preview-файл сам по себе не создаёт установщик.

## Браузерный Preview

Запусти `Open-Limited-Preview.command`. Он установит зависимости, убедится, что ресурсы Stockfish скопированы, запустит Vite и откроет `http://127.0.0.1:8173/preview.html`.

Не открывай `preview.html` двойным щелчком через `file://` и не используй простой Python static server: приложению нужны Vite-модули React и WebAssembly Worker.

## Stockfish

После `npm install` должны существовать:

- `public/engine/stockfish-19-lite-single.js`
- `public/engine/stockfish-19-lite-single.wasm`

При необходимости запусти `npm run copy:engine`. В приложении два отдельных Worker: один выбирает ответ бота, другой выполняет оценку позиции и варианты. При недоступности Stockfish отображается резервный режим.

## Сетевая игра

Для онлайна разверни `server/server.cjs` на публичном Node.js-хостинге. Серверный хост должен поддерживать постоянное хранилище и WebSocket Upgrade.

На сервере:

```bash
CHESS_ARENA_SECRET="длинный-постоянный-секрет" \
CHESS_ARENA_CORS_ORIGIN="https://твой-клиент.example" \
PORT=8787 npm run server
```

Настрой HTTPS/WSS reverse proxy на `/ws/match`. До сборки клиента укажи в `.env`:

```env
VITE_API_URL=https://твой-сервер.example
```

Затем пересобери приложение. Пользователи должны войти в серверные аккаунты. После этого вкладка «Онлайн» сможет искать соперника по рейтингу. Сервер проверяет ходы и обновляет рейтинг после результата партии.

Онлайн-сервер в этом архиве подготовлен, но не опубликован; без реального публичного домена сетевые матчи между удалёнными пользователями недоступны.

## Безопасность macOS

DMG в этой инструкции будет неподписанным, если ты отдельно не настроишь Developer ID и notarization. При первом запуске macOS может показать предупреждение Gatekeeper. Для публичного распространения рекомендуется подписать приложение и пройти notarization через Apple Developer ID.


### Preview 1.2.7 без Node.js

Для быстрого просмотра интерфейса запустите `Open-Limited-Preview.command`. Он поднимает локальный HTTP-сервер через Python 3 и открывает `preview.html`; Node.js для этого не нужен. Для создания настоящего установщика `.dmg` требуется Node.js 22 LTS и `Build-Chess-Arena-Mac.command`.


Для запуска полной браузерной версии с онлайном используй `Open-Chess-Arena.command`; она запускает Vite-клиент из `src/App.jsx`. `preview.html` — отдельный упрощённый файл. Сетевой сервер должен быть опубликован отдельно через Render; см. `START-HERE-RU.md`.
