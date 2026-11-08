'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { WebSocketServer, WebSocket } = require('ws');
const { Chess } = require('chess.js');

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_SECRET = process.env.CHESS_ARENA_SECRET || crypto.randomBytes(32).toString('hex');
const CORS_ORIGIN = process.env.CHESS_ARENA_CORS_ORIGIN || '*';
const DATA_DIR = process.env.CHESS_ARENA_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');
const BOT_RATINGS = new Set([500, 1000, 1500, 2000, 2500]);
const RATING_CALIBRATION_VERSION = 2;
const onlineTickets = new Map();
const waitingPlayers = [];
const activeMatches = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
let database = { users: [], resultIds: [] };
try {
  if (fs.existsSync(DATA_FILE)) database = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (error) {
  throw new Error(`Не удалось прочитать базу аккаунтов ${DATA_FILE}: ${error.message}`);
}

function saveDatabase() {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(database, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, DATA_FILE);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Слишком большой запрос.');
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw new Error('Некорректный JSON.'); }
}

function normalizeNick(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    rating: user.rating,
    games: user.games,
    ratingStageGames: Number.isInteger(user.ratingStageGames) ? user.ratingStageGames : 0,
    ratingCalibrationVersion: user.ratingCalibrationVersion || RATING_CALIBRATION_VERSION,
    wins: user.wins,
    draws: user.draws,
    losses: user.losses,
    lastRatingChange: user.lastRatingChange || 0,
    createdAt: user.createdAt,
  };
}

// One-time migration to the revised provisional Elo calibration.
// Preserve current rating and lifetime games; restart only the calibration window.
let migratedRatingStage = false;
for (const user of database.users) {
  if (user.ratingCalibrationVersion !== RATING_CALIBRATION_VERSION) {
    user.ratingStageGames = 0;
    user.ratingCalibrationVersion = RATING_CALIBRATION_VERSION;
    migratedRatingStage = true;
  } else if (!Number.isInteger(user.ratingStageGames) || user.ratingStageGames < 0) {
    user.ratingStageGames = 0;
    migratedRatingStage = true;
  }
}
if (migratedRatingStage) saveDatabase();

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function userFromToken(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.sub || decoded.exp < Date.now()) return null;
    return database.users.find((user) => user.id === decoded.sub) || null;
  } catch { return null; }
}

function eloDelta(rating, opponentRating, score, ratingStageGames) {
  const expected = 1 / (1 + (10 ** ((opponentRating - rating) / 400)));
  const k = ratingStageGames < 10 ? 120 : ratingStageGames < 30 ? 80 : ratingStageGames < 60 ? 48 : 24;
  return Math.round(k * (score - expected));
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': CORS_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, name: 'Chess Arena Multiplayer API', version: '1.2.7', websocket: '/ws/match', matchmaking: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/match/ticket') {
    const user = userFromToken(req);
    if (!user) return send(res, 401, { error: 'Для сетевой игры войдите в серверный аккаунт.' });
    const ticket = crypto.randomBytes(24).toString('base64url');
    onlineTickets.set(ticket, { userId: user.id, expiresAt: Date.now() + 60_000 });
    return send(res, 201, { ticket, expiresIn: 60 });
  }

  if (req.method === 'POST' && url.pathname === '/api/register') {
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim().normalize('NFKC');
    const nicknameKey = normalizeNick(nickname);
    const password = String(body.password || '');
    if (!/^[\p{L}\p{N}_]{3,16}$/u.test(nickname)) return send(res, 400, { error: 'Ник должен содержать 3–16 букв, цифр или подчёркиваний.' });
    if (password.length < 8 || password.length > 128) return send(res, 400, { error: 'Пароль должен содержать от 8 до 128 символов.' });
    if (database.users.some((user) => user.nicknameKey === nicknameKey)) return send(res, 409, { error: 'Этот ник уже занят. Выберите другой.' });

    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    // Re-check after the asynchronous password hash to avoid duplicate races.
    if (database.users.some((item) => item.nicknameKey === nicknameKey)) return send(res, 409, { error: 'Этот ник уже занят. Выберите другой.' });
    const user = {
      id: crypto.randomUUID(), nickname, nicknameKey,
      salt: salt.toString('base64'), passwordHash: passwordHash.toString('base64'),
      rating: 1200, games: 0, ratingStageGames: 0, ratingCalibrationVersion: RATING_CALIBRATION_VERSION, wins: 0, draws: 0, losses: 0,
      lastRatingChange: 0, createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    saveDatabase();
    return send(res, 201, { token: issueToken(user), user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const user = database.users.find((item) => item.nicknameKey === normalizeNick(body.nickname));
    if (!user) return send(res, 401, { error: 'Неверный ник или пароль.' });
    const supplied = await scrypt(String(body.password || ''), Buffer.from(user.salt, 'base64'), 64);
    const expected = Buffer.from(user.passwordHash, 'base64');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return send(res, 401, { error: 'Неверный ник или пароль.' });
    }
    return send(res, 200, { token: issueToken(user), user: publicUser(user) });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = userFromToken(req);
    if (!user) return send(res, 401, { error: 'Сессия истекла. Войдите снова.' });
    return send(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/results/bot') {
    const user = userFromToken(req);
    if (!user) return send(res, 401, { error: 'Сначала войдите в аккаунт.' });
    const body = await readBody(req);
    const opponentRating = Number(body.opponentRating);
    const result = String(body.result || '');
    const matchId = String(body.matchId || '');
    if (!BOT_RATINGS.has(opponentRating)) return send(res, 400, { error: 'Неизвестный рейтинг бота.' });
    if (!['win', 'draw', 'loss'].includes(result)) return send(res, 400, { error: 'Некорректный результат партии.' });
    if (!/^[\w-]{8,80}$/.test(matchId)) return send(res, 400, { error: 'Некорректный идентификатор партии.' });
    const resultKey = `${user.id}:${matchId}`;
    if (database.resultIds.includes(resultKey)) return send(res, 409, { error: 'Результат этой партии уже был учтён.' });
    const score = result === 'win' ? 1 : result === 'draw' ? 0.5 : 0;
    const delta = eloDelta(user.rating, opponentRating, score, Number.isInteger(user.ratingStageGames) ? user.ratingStageGames : 0);
    user.rating = Math.max(100, user.rating + delta);
    user.games += 1;
    user.ratingStageGames = (Number.isInteger(user.ratingStageGames) ? user.ratingStageGames : 0) + 1;
    user.wins += result === 'win' ? 1 : 0;
    user.draws += result === 'draw' ? 1 : 0;
    user.losses += result === 'loss' ? 1 : 0;
    user.lastRatingChange = delta;
    database.resultIds.push(resultKey);
    database.resultIds = database.resultIds.slice(-20_000);
    saveDatabase();
    return send(res, 200, { user: publicUser(user), delta, opponentRating, result });
  }

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const users = [...database.users].sort((a, b) => b.rating - a.rating || a.games - b.games).slice(0, 50).map(publicUser);
    return send(res, 200, { users });
  }

  return send(res, 404, { error: 'Маршрут не найден.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка сервера.' });
    else res.destroy();
  });
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
function wsSend(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function removeFromQueue(socket) {
  const index = waitingPlayers.findIndex((entry) => entry.socket === socket);
  if (index >= 0) waitingPlayers.splice(index, 1);
}
function makePublicMatch(match, color) {
  const opponentColor = color === 'w' ? 'b' : 'w';
  const opponent = match.users[opponentColor];
  return {
    type: 'matched', matchId: match.id, color,
    opponent: { nickname: opponent.nickname, rating: opponent.rating },
    fen: match.game.fen(),
  };
}
function applyOnlineRating(user, opponent, score) {
  const delta = eloDelta(user.rating, opponent.rating, score, Number.isInteger(user.ratingStageGames) ? user.ratingStageGames : 0);
  user.rating = Math.max(100, user.rating + delta);
  user.games += 1;
  user.ratingStageGames = (Number.isInteger(user.ratingStageGames) ? user.ratingStageGames : 0) + 1;
  user.wins += score === 1 ? 1 : 0;
  user.draws += score === 0.5 ? 1 : 0;
  user.losses += score === 0 ? 1 : 0;
  user.lastRatingChange = delta;
  return delta;
}
function finishOnlineMatch(match, whiteScore, reason) {
  if (!match || match.finished) return;
  match.finished = true;
  const white = database.users.find((user) => user.id === match.users.w.id);
  const black = database.users.find((user) => user.id === match.users.b.id);
  if (!white || !black) {
    for (const socket of Object.values(match.sockets)) wsSend(socket, { type: 'error', message: 'Не удалось обновить рейтинги игроков.' });
    activeMatches.delete(match.id);
    return;
  }
  const whiteDelta = applyOnlineRating(white, black, whiteScore);
  const blackDelta = applyOnlineRating(black, white, 1 - whiteScore);
  saveDatabase();
  for (const color of ['w', 'b']) {
    const own = color === 'w' ? white : black;
    const opponent = color === 'w' ? black : white;
    const delta = color === 'w' ? whiteDelta : blackDelta;
    wsSend(match.sockets[color], {
      type: 'gameOver', reason, result: whiteScore === 0.5 ? 'draw' : (whiteScore === 1 ? 'white' : 'black'),
      user: publicUser(own), opponent: publicUser(opponent), delta,
    });
  }
  activeMatches.delete(match.id);
}
function createOnlineMatch(first, second) {
  removeFromQueue(first.socket);
  removeFromQueue(second.socket);
  const [whiteEntry, blackEntry] = crypto.randomInt(0, 2) === 0 ? [first, second] : [second, first];
  const match = {
    id: crypto.randomUUID(), game: new Chess(), finished: false,
    users: { w: whiteEntry.user, b: blackEntry.user },
    sockets: { w: whiteEntry.socket, b: blackEntry.socket },
    startedAt: Date.now(),
  };
  activeMatches.set(match.id, match);
  for (const color of ['w', 'b']) {
    const socket = match.sockets[color];
    socket.match = match;
    socket.color = color;
    wsSend(socket, makePublicMatch(match, color));
  }
}
function pairWaitingPlayers() {
  const now = Date.now();
  waitingPlayers.sort((a, b) => a.joinedAt - b.joinedAt);
  for (let i = 0; i < waitingPlayers.length; i += 1) {
    const first = waitingPlayers[i];
    if (first.socket.readyState !== WebSocket.OPEN) { waitingPlayers.splice(i--, 1); continue; }
    let bestIndex = -1;
    let bestDiff = Infinity;
    for (let j = i + 1; j < waitingPlayers.length; j += 1) {
      const second = waitingPlayers[j];
      if (second.socket.readyState !== WebSocket.OPEN || second.user.id === first.user.id) continue;
      const waitSeconds = Math.max(0, (now - Math.min(first.joinedAt, second.joinedAt)) / 1000);
      const allowedDiff = Math.min(800, 150 + waitSeconds * 20);
      const diff = Math.abs(first.user.rating - second.user.rating);
      if (diff <= allowedDiff && diff < bestDiff) { bestIndex = j; bestDiff = diff; }
    }
    if (bestIndex >= 0) {
      const second = waitingPlayers[bestIndex];
      waitingPlayers.splice(bestIndex, 1);
      waitingPlayers.splice(i, 1);
      i -= 1;
      createOnlineMatch(first, second);
    } else {
      wsSend(first.socket, { type: 'queued', rating: first.user.rating, waitingSeconds: Math.floor((now - first.joinedAt) / 1000) });
    }
  }
}
function finishFromBoard(match) {
  const game = match.game;
  if (!game.isGameOver()) return;
  if (game.isCheckmate()) finishOnlineMatch(match, game.turn() === 'b' ? 1 : 0, 'Мат');
  else finishOnlineMatch(match, 0.5, game.isStalemate() ? 'Пат' : 'Ничья');
}

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws/match') return socket.destroy();
    const ticket = url.searchParams.get('ticket') || '';
    const item = onlineTickets.get(ticket);
    onlineTickets.delete(ticket);
    if (!item || item.expiresAt < Date.now()) return socket.destroy();
    const user = database.users.find((candidate) => candidate.id === item.userId);
    if (!user) return socket.destroy();
    const origin = req.headers.origin;
    if (CORS_ORIGIN !== '*' && origin && origin !== CORS_ORIGIN) return socket.destroy();
    webSockets.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      webSockets.emit('connection', ws, req);
    });
  } catch { socket.destroy(); }
});

webSockets.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return wsSend(socket, { type: 'error', message: 'Некорректное сообщение.' }); }
    if (message.type === 'queue') {
      if (socket.match && !socket.match.finished) return wsSend(socket, { type: 'error', message: 'Вы уже находитесь в партии.' });
      if (!waitingPlayers.some((entry) => entry.socket === socket)) waitingPlayers.push({ socket, user: socket.user, joinedAt: Date.now() });
      pairWaitingPlayers();
      return;
    }
    if (message.type === 'cancelQueue') {
      removeFromQueue(socket);
      return wsSend(socket, { type: 'queueCancelled' });
    }
    const match = socket.match;
    if (!match || match.finished || !activeMatches.has(match.id)) return wsSend(socket, { type: 'error', message: 'Активная партия не найдена.' });
    if (message.type === 'move') {
      if (match.game.turn() !== socket.color) return wsSend(socket, { type: 'error', message: 'Сейчас ход соперника.' });
      const uci = String(message.uci || '');
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return wsSend(socket, { type: 'error', message: 'Некорректная запись хода.' });
      let played;
      try { played = match.game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined }); }
      catch { played = null; }
      if (!played) return wsSend(socket, { type: 'error', message: 'Недопустимый ход.' });
      const payload = { type: 'move', matchId: match.id, from: played.from, to: played.to, promotion: played.promotion, san: played.san, color: played.color, fen: match.game.fen(), turn: match.game.turn(), check: match.game.isCheck() };
      for (const recipient of Object.values(match.sockets)) wsSend(recipient, payload);
      finishFromBoard(match);
      return;
    }
    if (message.type === 'resign') {
      finishOnlineMatch(match, socket.color === 'w' ? 0 : 1, `${socket.user.nickname} сдался`);
      return;
    }
    if (message.type === 'offerDraw') {
      wsSend(match.sockets[socket.color === 'w' ? 'b' : 'w'], { type: 'drawOffered', from: socket.user.nickname });
      return;
    }
    if (message.type === 'acceptDraw') {
      finishOnlineMatch(match, 0.5, 'Ничья по соглашению');
      return;
    }
    wsSend(socket, { type: 'error', message: 'Неизвестная команда.' });
  });
  socket.on('close', () => {
    removeFromQueue(socket);
    const match = socket.match;
    if (match && !match.finished && activeMatches.has(match.id)) {
      const opponent = match.sockets[socket.color === 'w' ? 'b' : 'w'];
      wsSend(opponent, { type: 'opponentDisconnected', message: 'Соперник отключился. Партия не засчитана; рейтинг не изменён.' });
      activeMatches.delete(match.id);
      match.finished = true;
    }
  });
  wsSend(socket, { type: 'connected', nickname: socket.user.nickname, rating: socket.user.rating });
});

setInterval(pairWaitingPlayers, 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [ticket, item] of onlineTickets) if (item.expiresAt < now) onlineTickets.delete(ticket);
}, 15_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Chess Arena Multiplayer API: http://${HOST}:${PORT}`);
  console.log(`WebSocket matchmaking: ws://${HOST}:${PORT}/ws/match`);
  console.log(`База аккаунтов: ${DATA_FILE}`);
  if (!process.env.CHESS_ARENA_SECRET) console.warn('ВНИМАНИЕ: CHESS_ARENA_SECRET не задан. При перезапуске сессии станут недействительными. Задайте постоянный случайный секрет.');
});
