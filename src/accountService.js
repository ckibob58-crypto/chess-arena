const ACCOUNTS_KEY = 'chess-arena.accounts.v1';
const SESSION_KEY = 'chess-arena.session.v1';
const SERVER_URL_KEY = 'chess-arena.server-url.v1';

export function readServerUrl() {
  try { return (localStorage.getItem(SERVER_URL_KEY) || import.meta.env.VITE_API_URL || '').replace(/\/$/, ''); }
  catch { return (import.meta.env.VITE_API_URL || '').replace(/\/$/, ''); }
}

export function saveServerUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Адрес сервера должен начинаться с https:// или http://.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Укажи только адрес сервера без логина, пароля, параметров и #.');
  const base = parsed.origin.replace(/\/$/, '');
  localStorage.setItem(SERVER_URL_KEY, base);
  return base;
}

const RATING_CALIBRATION_VERSION = 2;

const normalizeNick = (value) => value.trim().normalize('NFKC').toLocaleLowerCase();
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

function cryptoApi() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Безопасное хранение пароля недоступно. Открой приложение через localhost или desktop-версию.');
  }
  return globalThis.crypto;
}

async function derivePassword(password, salt) {
  const crypto = cryptoApi();
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 180000, hash: 'SHA-256' }, material, 256);
  return encode(bits);
}

export function readLocalAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    // Start the new provisional K-factor calibration once for existing profiles.
    // Keep current Elo and lifetime games; only reset the calibration counter.
    let migrated = false;
    const accounts = parsed.map((user) => {
      if (user.ratingCalibrationVersion !== RATING_CALIBRATION_VERSION) {
        migrated = true;
        return { ...user, ratingStageGames: 0, ratingCalibrationVersion: RATING_CALIBRATION_VERSION };
      }
      if (!Number.isInteger(user.ratingStageGames) || user.ratingStageGames < 0) {
        migrated = true;
        return { ...user, ratingStageGames: 0, ratingCalibrationVersion: RATING_CALIBRATION_VERSION };
      }
      return user;
    });
    if (migrated) localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    return accounts;
  } catch {
    return [];
  }
}

export function saveLocalAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

export function saveSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

function publicUser(user) {
  const { passwordHash, passwordSalt, ...safe } = user;
  return safe;
}

async function apiRequest(path, options = {}) {
  const base = readServerUrl();
  if (!base) throw new Error('Сервер аккаунтов не настроен.');
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Ошибка сервера (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function isServerConfigured() { return Boolean(readServerUrl()); }

export async function registerAccount(nickname, password) {
  const nick = nickname.trim().normalize('NFKC');
  if (!/^[\p{L}\p{N}_]{3,16}$/u.test(nick)) {
    throw new Error('Ник должен содержать 3–16 букв, цифр или символов подчёркивания.');
  }
  if (password.length < 8) throw new Error('Пароль должен содержать минимум 8 символов.');

  if (readServerUrl()) {
    const payload = await apiRequest('/api/register', { method: 'POST', body: JSON.stringify({ nickname: nick, password }) });
    return { session: { scope: 'server', token: payload.token, user: payload.user }, localAccounts: readLocalAccounts() };
  }

  const accounts = readLocalAccounts();
  const nickKey = normalizeNick(nick);
  if (accounts.some((item) => item.nickKey === nickKey)) throw new Error('Этот ник уже занят на данном устройстве. Выберите другой.');
  const crypto = cryptoApi();
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const user = {
    id: crypto.randomUUID(), nickname: nick, nickKey, passwordSalt: encode(salt),
    passwordHash: await derivePassword(password, salt), rating: 1200,
    games: 0, ratingStageGames: 0, ratingCalibrationVersion: RATING_CALIBRATION_VERSION, wins: 0, draws: 0, losses: 0, ratingHistory: [], createdAt: new Date().toISOString(),
  };
  const next = [...accounts, user];
  saveLocalAccounts(next);
  return { session: { scope: 'local', user: publicUser(user) }, localAccounts: next };
}

export async function loginAccount(nickname, password) {
  const nickKey = normalizeNick(nickname);
  if (readServerUrl()) {
    const payload = await apiRequest('/api/login', { method: 'POST', body: JSON.stringify({ nickname: nickname.trim(), password }) });
    return { session: { scope: 'server', token: payload.token, user: payload.user }, localAccounts: readLocalAccounts() };
  }
  const accounts = readLocalAccounts();
  const user = accounts.find((item) => item.nickKey === nickKey);
  if (!user) throw new Error('Аккаунт с таким ником не найден на этом устройстве.');
  const digest = await derivePassword(password, decode(user.passwordSalt));
  const a = decode(digest), b = decode(user.passwordHash);
  if (a.length !== b.length || a.some((byte, index) => byte !== b[index])) throw new Error('Неверный пароль.');
  return { session: { scope: 'local', user: publicUser(user) }, localAccounts: accounts };
}

export async function restoreServerSession(session) {
  if (!readServerUrl() || session?.scope !== 'server' || !session.token) return null;
  try {
    const payload = await apiRequest('/api/me', { headers: { Authorization: `Bearer ${session.token}` } });
    return { ...session, user: payload.user };
  } catch (error) {
    // Keep the saved session during a temporary network outage. Only clear it
    // when the server explicitly rejects the token as unauthorized.
    if (error.status === 401 || error.status === 403) return null;
    return session;
  }
}

export function getRatingDelta(rating, opponentRating, score, gamesPlayed) {
  const expected = 1 / (1 + (10 ** ((opponentRating - rating) / 400)));
  // Provisional rating: larger K-factor at the start, then a gradual taper.
  const k = gamesPlayed < 10 ? 120 : gamesPlayed < 30 ? 80 : gamesPlayed < 60 ? 48 : 24;
  return Math.round(k * (score - expected));
}

function updatedPlayer(player, opponentRating, score) {
  const change = getRatingDelta(player.rating, opponentRating, score, Number.isInteger(player.ratingStageGames) ? player.ratingStageGames : 0);
  const isWin = score === 1, isDraw = score === 0.5;
  return {
    ...player,
    rating: Math.max(100, player.rating + change),
    games: (player.games || 0) + 1,
    ratingStageGames: (Number.isInteger(player.ratingStageGames) ? player.ratingStageGames : 0) + 1,
    wins: (player.wins || 0) + (isWin ? 1 : 0),
    draws: (player.draws || 0) + (isDraw ? 1 : 0),
    losses: (player.losses || 0) + (!isWin && !isDraw ? 1 : 0),
    lastRatingChange: change,
    ratingHistory: [...(player.ratingHistory || []), { rating: Math.max(100, player.rating + change), change, at: new Date().toISOString() }].slice(-30),
  };
}

export function applyBotResult(accounts, userId, opponentRating, score) {
  let delta = 0;
  const next = accounts.map((player) => {
    if (player.id !== userId) return player;
    const updated = updatedPlayer(player, opponentRating, score);
    delta = updated.lastRatingChange;
    return updated;
  });
  saveLocalAccounts(next);
  return { accounts: next, delta };
}

export function applyLocalFriendResult(accounts, whiteId, blackId, whiteScore) {
  if (!whiteId || !blackId || whiteId === blackId) return { accounts, changes: null };
  const white = accounts.find((item) => item.id === whiteId);
  const black = accounts.find((item) => item.id === blackId);
  if (!white || !black) return { accounts, changes: null };
  const nextWhite = updatedPlayer(white, black.rating, whiteScore);
  const nextBlack = updatedPlayer(black, white.rating, 1 - whiteScore);
  const next = accounts.map((item) => item.id === whiteId ? nextWhite : item.id === blackId ? nextBlack : item);
  saveLocalAccounts(next);
  return { accounts: next, changes: { white: nextWhite.lastRatingChange, black: nextBlack.lastRatingChange } };
}

export async function reportServerBotResult(session, opponentRating, score, matchId) {
  const result = score === 1 ? 'win' : score === 0.5 ? 'draw' : 'loss';
  const payload = await apiRequest('/api/results/bot', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ opponentRating, result, matchId }),
  });
  return payload.user;
}

export async function openOnlineSocket(session) {
  const base = readServerUrl();
  if (!base) throw new Error('Сетевой режим не настроен: сначала укажи адрес опубликованного сервера.');
  if (session?.scope !== 'server' || !session?.token) throw new Error('Для игры по сети нужен аккаунт, зарегистрированный на общем сервере.');
  const payload = await apiRequest('/api/match/ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({}),
  });
  const socketBase = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return new WebSocket(`${socketBase}/ws/match?ticket=${encodeURIComponent(payload.ticket)}`);
}
