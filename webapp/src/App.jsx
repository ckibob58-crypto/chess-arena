import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  applyBotResult, applyLocalFriendResult, isServerConfigured, loginAccount,
  readLocalAccounts, readSession, registerAccount, reportServerBotResult,
  restoreServerSession, saveSession, openOnlineSocket, readServerUrl, saveServerUrl,
} from './accountService';

const PIECES = {
  // Используем разные стандартные шахматные глифы: белые фигуры (U+2654–U+2659)
  // и чёрные фигуры (U+265A–U+265F). CSS отдельно задаёт белую и тёмную заливку.
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

const LEVELS = [
  { elo: 500, skill: 0, depth: 3, analysisDepth: 16, botTimeMs: 240, title: 'Новичок' },
  { elo: 1000, skill: 0, depth: 4, analysisDepth: 18, botTimeMs: 320, title: 'Любитель' },
  { elo: 1500, skill: 6, depth: 6, analysisDepth: 20, botTimeMs: 420, title: 'Клубный' },
  { elo: 2000, skill: 14, depth: 9, analysisDepth: 22, botTimeMs: 560, title: 'Эксперт' },
  { elo: 2500, skill: 20, depth: 12, analysisDepth: 24, botTimeMs: 720, title: 'Мастер' },
  { elo: 2800, display: 'MAX', skill: 20, depth: 26, analysisDepth: 28, botTimeMs: 1200, title: 'Адаптивный максимум' },
];

function getAdaptiveMaxBotTime(positionFen) {
  // MAX spends little time on quiet forced positions and more on checks,
  // tactical captures and endgames where precise calculation matters.
  const position = new Chess(positionFen);
  const legal = position.moves({ verbose: true });
  const board = position.board();
  const pieces = board.flat().filter(Boolean).length;
  const forcing = legal.filter((move) => move.captured || move.promotion || move.san.includes('+') || move.san.includes('#')).length;
  if (position.isCheck()) return 2200;
  if (pieces <= 10) return forcing >= 2 ? 2200 : 1600;
  if (forcing >= 4) return 1900;
  if (legal.length <= 7 && forcing === 0) return 520;
  if (legal.length >= 30) return 900;
  if (forcing >= 1) return 1350;
  return 1050;
}

const QUALITY = {
  brilliant: { label: 'Бриллиантовый', icon: '◆', points: 10, color: 'violet' },
  best: { label: 'Лучший ход', icon: '★', points: 6, color: 'green' },
  excellent: { label: 'Отличный ход', icon: '✦', points: 4, color: 'teal' },
  good: { label: 'Хороший ход', icon: '✓', points: 2, color: 'blue' },
  inaccuracy: { label: 'Неточность', icon: '?!', points: 0, color: 'yellow' },
  mistake: { label: 'Ошибка', icon: '?', points: -1, color: 'orange' },
  blunder: { label: 'Зевок', icon: '??', points: -2, color: 'red' },
};

const FILES = 'abcdefgh';
const RANKS = '87654321';

function formatEval(scoreWhite) {
  if (scoreWhite == null || Number.isNaN(scoreWhite)) return '—';
  if (Math.abs(scoreWhite) > 90000) return scoreWhite > 0 ? 'Мат белым' : 'Мат чёрным';
  const pawns = scoreWhite / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

function fromUci(uci) {
  if (!uci || uci === '(none)' || uci === '0000') return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, nickKey, ...safe } = user;
  return safe;
}

function classifyMove(lossCp, matchesBest) {
  if (matchesBest) return 'best';
  // More forgiving than strict tournament labels: normal positional choices
  // are called excellent/good; negative labels are reserved for large losses.
  if (lossCp <= 120) return 'best';
  if (lossCp <= 500) return 'excellent';
  if (lossCp <= 850) return 'good';
  if (lossCp <= 1350) return 'inaccuracy';
  if (lossCp <= 2000) return 'mistake';
  return 'blunder';
}

function compareMoveEvaluation(bestPosition, playedMovePosition, move) {
  // Compare the best root line and a forced played move from exactly the same
  // root FEN. Require reliable, completed searches with similar depths.
  if (!bestPosition?.hasScore || !playedMovePosition?.hasScore
      || bestPosition.engine !== true || playedMovePosition.engine !== true
      || bestPosition.depth < 8 || playedMovePosition.depth < 8
      || Math.abs(bestPosition.depth - playedMovePosition.depth) > 2) return null;
  const sign = move.color === 'w' ? 1 : -1;
  const rawLossCp = sign * (bestPosition.scoreWhite - playedMovePosition.scoreWhite);
  // A one-and-a-half-pawn safety margin absorbs horizon and MultiPV volatility.
  // This is intentionally forgiving: uncertain/close moves should not be marked as errors.
  const lossCp = Math.max(0, rawLossCp - 200);
  const uci = `${move.from}${move.to}${move.promotion || ''}`;
  return { quality: classifyMove(lossCp, bestPosition.bestMove === uci), lossCp };
}

function formatEngineLine(fen, pv = []) {
  try {
    const position = new Chess(fen);
    const sans = [];
    for (const token of pv) {
      const parsed = fromUci(token);
      if (!parsed) break;
      const made = position.move(parsed);
      if (!made) break;
      sans.push(made.san);
    }
    return sans.join(' ');
  } catch { return ''; }
}


// A transparent local fallback keeps evaluations and hints responsive when
// Stockfish cannot start. It is a bounded two-ply heuristic, not a replacement
// for deeper Stockfish analysis.
const MATERIAL = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluatePosition(position) {
  let score = 0;
  const board = position.board();
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank][file];
      if (!piece) continue;
      const sign = piece.color === 'w' ? 1 : -1;
      const center = 3.5 - (Math.abs(3.5 - file) + Math.abs(3.5 - rank)) / 2;
      let positional = 0;
      if (piece.type === 'n' || piece.type === 'b') positional = center * 9;
      if (piece.type === 'p') positional = (piece.color === 'w' ? 6 - rank : rank - 1) * 5 + center * 2;
      if (piece.type === 'q') positional = center * 2;
      score += sign * (MATERIAL[piece.type] + positional);
    }
  }
  if (position.isCheckmate()) return position.turn() === 'w' ? -100000 : 100000;
  return Math.round(score);
}
function fallbackAnalysis(fen, randomize = 0, forcedMove = '') {
  // Responsive two-ply fallback with bounded branching. Future lines are not
  // exposed in the UI; this only chooses a legal move / approximate score.
  const fallbackDepth = 2;
  const orderMoves = (position, moves) => [...moves].sort((a, b) => {
    const value = (move) => (move.captured ? MATERIAL[move.captured] * 10 - MATERIAL[move.piece] : 0)
      + (move.promotion ? MATERIAL[move.promotion] : 0) + (move.san?.includes('+') ? 35 : 0);
    return value(b) - value(a);
  });
  const minimax = (position, depth, alpha, beta, ply = 0) => {
    if (position.isCheckmate()) return position.turn() === 'w' ? -100000 + ply : 100000 - ply;
    if (position.isDraw() || position.isStalemate() || position.isInsufficientMaterial()) return 0;
    if (depth <= 0) return evaluatePosition(position);
    const maximize = position.turn() === 'w';
    let best = maximize ? -Infinity : Infinity;
    for (const move of orderMoves(position, position.moves({ verbose: true })).slice(0, 10)) {
      const next = new Chess(position.fen());
      const played = next.move({ from: move.from, to: move.to, promotion: move.promotion });
      if (!played) continue;
      const score = minimax(next, depth - 1, alpha, beta, ply + 1);
      if ((maximize && score > best) || (!maximize && score < best)) best = score;
      if (maximize) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return Number.isFinite(best) ? best : evaluatePosition(position);
  };
  const position = new Chess(fen);
  const legalRoots = orderMoves(position, position.moves({ verbose: true }));
  const selectedRoots = forcedMove
    ? legalRoots.filter((move) => `${move.from}${move.to}${move.promotion || ''}` === forcedMove)
    : legalRoots.slice(0, 16);
  const roots = selectedRoots.map((move) => {
    const next = new Chess(fen);
    next.move({ from: move.from, to: move.to, promotion: move.promotion });
    const scoreWhite = minimax(next, fallbackDepth - 1, -Infinity, Infinity, 1);
    const noise = randomize ? (Math.random() - 0.5) * randomize : 0;
    return { bestMove: `${move.from}${move.to}${move.promotion || ''}`, scoreWhite: scoreWhite + (position.turn() === 'w' ? noise : -noise) };
  });
  roots.sort((a, b) => position.turn() === 'w' ? b.scoreWhite - a.scoreWhite : a.scoreWhite - b.scoreWhite);
  return {
    bestMove: roots[0]?.bestMove || null,
    scoreWhite: roots[0]?.scoreWhite ?? evaluatePosition(position),
    depth: fallbackDepth,
    engine: false,
    hasScore: true,
  };
}

function getStatus(chess) {
  if (chess.isCheckmate()) return `Мат! Победили ${chess.turn() === 'w' ? 'чёрные' : 'белые'}.`;
  if (chess.isStalemate()) return 'Пат. Ничья.';
  if (chess.isThreefoldRepetition()) return 'Ничья: троекратное повторение позиции.';
  if (chess.isInsufficientMaterial()) return 'Ничья: недостаточно материала.';
  if (chess.isDraw()) return 'Ничья.';
  if (chess.isCheck()) return `${chess.turn() === 'w' ? 'Белым' : 'Чёрным'} шах.`;
  return `${chess.turn() === 'w' ? 'Ход белых' : 'Ход чёрных'}`;
}

export default function App() {
  const gameRef = useRef(new Chess());
  const workerRef = useRef(null);
  const botWorkerRef = useRef(null);
  const botPendingRef = useRef(null);
  const botReadyRef = useRef(false);
  const pendingRef = useRef(null);
  const queueRef = useRef(Promise.resolve());
  const readyPromiseRef = useRef(null);
  const readyResolveRef = useRef(null);
  const readyRef = useRef(false);
  const analysisCacheRef = useRef(null);
  const pendingMoveGradesRef = useRef(new Map());
  const boardRef = useRef(null);
  const serialRef = useRef(0);
  const botBusyRef = useRef(false);
  const analysisPaidRef = useRef(false);
  const analysisEnabledRef = useRef(false);
  const ratingUpdatedRef = useRef(false);
  const moveSerialRef = useRef(0);
  const moveLockRef = useRef(false);
  const lastBotReplyFenRef = useRef(null);
  const onlineSocketRef = useRef(null);
  const onlineColorRef = useRef(null);
  const onlineMatchRef = useRef(null);

  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState('bot');
  const [levelIndex, setLevelIndex] = useState(2);
  const [engineReady, setEngineReady] = useState(false);
  const [botEngineReady, setBotEngineReady] = useState(false);
  const [engineError, setEngineError] = useState('');
  const [selected, setSelected] = useState(null);
  const [lastMove, setLastMove] = useState(null);
  const [hintMove, setHintMove] = useState(null);
  const [stars, setStars] = useState(3);
  const [analysisEnabled, setAnalysisEnabled] = useState(false);
  const [analysisPaid, setAnalysisPaid] = useState(false);
  const [points, setPoints] = useState(0);
  const [moveRows, setMoveRows] = useState([]);
  const [lastMoveQuality, setLastMoveQuality] = useState(null);
  const [lastMoveQualityApprox, setLastMoveQualityApprox] = useState(false);
  const [evalWhite, setEvalWhite] = useState(null);
  const [evalDepth, setEvalDepth] = useState(0);
  const [analysisText, setAnalysisText] = useState('Подготовка движка…');
  const [localAccounts, setLocalAccounts] = useState(() => readLocalAccounts());
  const [session, setSession] = useState(() => readSession());
  const [authMode, setAuthMode] = useState('register');
  const [authNickname, setAuthNickname] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [ratingNotice, setRatingNotice] = useState('');
  const [localWhiteId, setLocalWhiteId] = useState('');
  const [localBlackId, setLocalBlackId] = useState('');
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promotion, setPromotion] = useState(null);
  const [animation, setAnimation] = useState(null);
  const [onlineNotice, setOnlineNotice] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState('idle');
  const [onlineMessage, setOnlineMessage] = useState('');
  const [serverAddress, setServerAddress] = useState(() => readServerUrl());
  const [serverAddressStatus, setServerAddressStatus] = useState('');
  const [onlineOpponent, setOnlineOpponent] = useState(null);
  const [onlineMatch, setOnlineMatch] = useState(null);
  const [showEngineVariations, setShowEngineVariations] = useState(false);
  const [engineLines, setEngineLines] = useState([]);

  const chess = gameRef.current;
  const level = LEVELS[levelIndex];
  const fen = chess.fen();
  const isOver = chess.isGameOver();
  const humanTurn = mode === 'bot' ? chess.turn() === 'w' : mode === 'online' ? onlineStatus === 'playing' && chess.turn() === onlineColorRef.current : true;
  analysisEnabledRef.current = analysisEnabled;
  const profile = session?.user || null;
  const activeLocalProfile = session?.scope === 'local'
    ? localAccounts.find((item) => item.id === session.user?.id) || profile
    : profile;

  const boardSquares = useMemo(() => {
    const rows = flipped ? [...RANKS].reverse() : [...RANKS];
    const cols = flipped ? [...FILES].reverse() : [...FILES];
    return rows.flatMap((rank, rowIndex) => cols.map((file, colIndex) => ({
      square: `${file}${rank}`,
      rowIndex,
      colIndex,
      isLight: (FILES.indexOf(file) + Number(rank)) % 2 === 1,
    })));
  }, [flipped]);

  const forceRender = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    readyPromiseRef.current = new Promise((resolve) => { readyResolveRef.current = resolve; });
    let worker;
    let initTimer;
    try {
      const url = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;
      worker = new Worker(url);
      workerRef.current = worker;
      initTimer = window.setTimeout(() => {
        if (!readyRef.current) {
          setEngineError('Stockfish не ответил при запуске. Используется резервная оценка; проверьте public/engine/ и npm install.');
          setAnalysisText('Резервная оценка · движок не загрузился');
          readyResolveRef.current?.();
        }
      }, 12000);
      worker.onmessage = (event) => {
        const line = String(event.data ?? '').trim();
        if (line === 'uciok') {
          worker.postMessage('setoption name Threads value 1');
          worker.postMessage('setoption name Hash value 128');
          worker.postMessage('setoption name MultiPV value 3');
          worker.postMessage('setoption name UCI_AnalyseMode value true');
          worker.postMessage('isready');
          return;
        }
        if (line === 'readyok') {
          readyRef.current = true;
          window.clearTimeout(initTimer);
          setEngineReady(true);
          setEngineError('');
          setAnalysisText('Stockfish 19 готов · выполняю анализ');
          readyResolveRef.current?.();
          return;
        }
        const pending = pendingRef.current;
        if (!pending) return;
        // A cancelled search stays attached until Stockfish confirms `bestmove`.
        // This prevents a late result from an old search being mistaken for the
        // next bot search (a source of delayed / duplicate replies).
        if (pending.cancelled) {
          if (line.startsWith('bestmove ')) {
            window.clearTimeout(pending.timer);
            pendingRef.current = null;
            pending.resolve({ cancelled: true, bestMove: null, scoreWhite: null, depth: 0, engine: true, hasScore: false });
          }
          return;
        }
        if (line.startsWith('info ') && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
          const depthMatch = line.match(/\bdepth (\d+)/);
          const cpMatch = line.match(/\bscore cp (-?\d+)/);
          const mateMatch = line.match(/\bscore mate (-?\d+)/);
          const multiMatch = line.match(/\bmultipv (\d+)/);
          if (depthMatch) pending.depth = Math.max(pending.depth, Number(depthMatch[1]));
          if (cpMatch || mateMatch) {
            const score = cpMatch ? Number(cpMatch[1]) : (Number(mateMatch[1]) > 0
              ? 100000 - Math.abs(Number(mateMatch[1])) * 100
              : -100000 + Math.abs(Number(mateMatch[1])) * 100);
            const index = multiMatch ? Number(multiMatch[1]) : 1;
            const pvMatch = line.match(/\bpv (.+)$/);
            pending.lines[index] = { score, depth: Number(depthMatch?.[1] || pending.depth), pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [] };
            if (index === 1) { pending.score = score; pending.hasScore = true; }
          }
          if (pending.score != null && analysisEnabledRef.current && gameRef.current.fen() === pending.fen) {
            const side = pending.fen.split(' ')[1];
            setEvalWhite(side === 'w' ? pending.score : -pending.score);
            setEvalDepth(pending.depth || 0);
            const sideToMove = pending.fen.split(' ')[1];
            const streamedLines = Object.entries(pending.lines).sort(([a], [b]) => Number(a) - Number(b)).map(([index, item]) => ({
              multipv: Number(index), scoreWhite: sideToMove === 'w' ? item.score : -item.score,
              depth: item.depth, pv: item.pv || [],
            }));
            setEngineLines(streamedLines);
            if (pending.depth >= 8 && pending.lines[1]?.pv?.[0]) {
              analysisCacheRef.current = {
                fen: pending.fen, bestMove: pending.lines[1].pv[0],
                scoreWhite: sideToMove === 'w' ? pending.score : -pending.score,
                depth: pending.depth, engine: true, hasScore: true, lines: streamedLines,
              };
            }
          }
        }
        if (line.startsWith('bestmove ')) {
          window.clearTimeout(pending.timer);
          const bestMove = line.split(/\s+/)[1];
          const sideToMove = pending.fen.split(' ')[1];
          const bestLine = pending.lines[1];
          const rawScore = bestLine?.score ?? pending.score;
          const scoreWhite = rawScore == null
            ? evaluatePosition(new Chess(pending.fen))
            : (sideToMove === 'w' ? rawScore : -rawScore);
          const normalizedLines = Object.entries(pending.lines).sort(([a], [b]) => Number(a) - Number(b)).map(([index, item]) => ({
            multipv: Number(index), scoreWhite: sideToMove === 'w' ? item.score : -item.score,
            depth: item.depth, pv: item.pv || [],
          }));
          pending.resolve({ bestMove, scoreWhite, depth: bestLine?.depth ?? pending.depth ?? 0, engine: true, hasScore: pending.hasScore === true, lines: normalizedLines });
          pendingRef.current = null;
        }
      };
      worker.onerror = () => {
        window.clearTimeout(initTimer);
        readyRef.current = false;
        setEngineReady(false);
        setEngineError('Не удалось загрузить Stockfish. Проверьте, что оба файла движка находятся в public/engine/. Включена резервная оценка.');
        setAnalysisText('Резервная оценка · Stockfish недоступен');
        const pending = pendingRef.current;
        if (pending) {
          window.clearTimeout(pending.timer);
          pending.resolve(fallbackAnalysis(pending.fen, 0, pending.searchMove));
          pendingRef.current = null;
        }
        readyResolveRef.current?.();
      };
      worker.postMessage('uci');

      // A dedicated Stockfish worker chooses the bot's reply. Position analysis
      // can no longer hold the bot behind a long search or a cancellation queue.
      const botWorker = new Worker(url);
      botWorkerRef.current = botWorker;
      botWorker.onmessage = (event) => {
        const line = String(event.data ?? '').trim();
        if (line === 'uciok') {
          botWorker.postMessage('setoption name Threads value 1');
          botWorker.postMessage('setoption name Hash value 48');
          botWorker.postMessage('setoption name MultiPV value 1');
          botWorker.postMessage('isready');
          return;
        }
        if (line === 'readyok') {
          botReadyRef.current = true;
          setBotEngineReady(true);
          return;
        }
        const job = botPendingRef.current;
        if (!job) return;
        if (line.startsWith('info ')) {
          const depth = line.match(/\bdepth (\d+)/);
          const cp = line.match(/\bscore cp (-?\d+)/);
          const mate = line.match(/\bscore mate (-?\d+)/);
          if (depth) job.depth = Number(depth[1]);
          if (cp || mate) {
            const sideScore = cp ? Number(cp[1]) : (Number(mate[1]) > 0 ? 100000 - Number(mate[1]) * 100 : -100000 + Math.abs(Number(mate[1])) * 100);
            job.scoreWhite = job.fen.split(' ')[1] === 'w' ? sideScore : -sideScore;
            job.hasScore = true;
          }
        }
        if (line.startsWith('bestmove ')) {
          window.clearTimeout(job.timer);
          const bestMove = line.split(/\s+/)[1];
          botPendingRef.current = null;
          job.resolve({ bestMove, scoreWhite: job.scoreWhite ?? evaluatePosition(new Chess(job.fen)), depth: job.depth, engine: true, hasScore: job.hasScore });
        }
      };
      botWorker.onerror = () => {
        botReadyRef.current = false;
        setBotEngineReady(false);
        const job = botPendingRef.current;
        if (job) {
          window.clearTimeout(job.timer);
          botPendingRef.current = null;
          job.resolve(fallbackAnalysis(job.fen, 0));
        }
      };
      botWorker.postMessage('uci');
    } catch (error) {
      window.clearTimeout(initTimer);
      readyRef.current = false;
      setEngineError(`Ошибка запуска Stockfish: ${error.message}. Включена резервная оценка.`);
      setAnalysisText('Резервная оценка · Stockfish недоступен');
      readyResolveRef.current?.();
    }
    return () => {
      window.clearTimeout(initTimer);
      worker?.terminate();
      try { botWorkerRef.current?.terminate(); } catch { /* worker already closed */ }
      botWorkerRef.current = null;
      botReadyRef.current = false;
      workerRef.current = null;
      readyRef.current = false;
    };
  }, []);

  const requestEngine = useCallback(async (positionFen, depth, skill, options = {}) => {
    const timeMs = Math.max(0, Number(options.timeMs) || 0);
    const multiPV = Math.max(1, Math.min(3, Number(options.multiPV) || 1));
    const kind = options.kind || 'move';
    const searchMove = typeof options.searchMove === 'string' ? options.searchMove : '';
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : null;
    const cancelledResult = { bestMove: null, scoreWhite: null, depth: 0, engine: false, hasScore: false, cancelled: true };
    if (isCurrent && !isCurrent()) return Promise.resolve(cancelledResult);
    // If WebAssembly has not started (or failed), use a bounded shallow search.
    if (!workerRef.current || !readyRef.current) return Promise.resolve(fallbackAnalysis(positionFen, 0, searchMove));
    const task = queueRef.current.then(() => new Promise((resolve) => {
      if (isCurrent && !isCurrent()) return resolve(cancelledResult);
      const worker = workerRef.current;
      if (!worker || !readyRef.current) return resolve(fallbackAnalysis(positionFen, 0, searchMove));
      const budgetMs = timeMs || Math.max(1800, depth * 300);
      const job = {
        resolve,
        fen: positionFen,
        kind,
        searchMove,
        score: null,
        hasScore: false,
        depth: 0,
        lines: {},
        timer: window.setTimeout(() => {
          if (pendingRef.current !== job) return;
          // Stop a stalled worker so its late bestmove cannot poison the next request.
          pendingRef.current = null;
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          readyRef.current = false;
          setEngineReady(false);
          setEngineError('Stockfish превысил лимит времени. Для этой сессии включён быстрый резервный поиск.');
          setAnalysisText('Резервная оценка · Stockfish остановлен по тайм-ауту');
          resolve(fallbackAnalysis(positionFen, 0, searchMove));
        }, Math.max(kind === 'bot' ? 1500 : kind === 'hint' ? 2200 : 2600, budgetMs * 2 + 700)),
      };
      pendingRef.current = job;
      worker.postMessage(`setoption name MultiPV value ${multiPV}`);
      worker.postMessage(`setoption name Skill Level value ${skill}`);
      worker.postMessage(`position fen ${positionFen}`);
      worker.postMessage(timeMs > 0
        ? `go ${searchMove ? `searchmoves ${searchMove} ` : ''}movetime ${Math.round(timeMs)}`
        : `go ${searchMove ? `searchmoves ${searchMove} ` : ''}depth ${depth}`);
    }));
    queueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, []);

  const requestBotMove = useCallback((positionFen, depth, skill, timeMs) => {
    const worker = botWorkerRef.current;
    if (!worker || !botReadyRef.current || botPendingRef.current) {
      return Promise.resolve(fallbackAnalysis(positionFen, 0));
    }
    return new Promise((resolve) => {
      const job = { fen: positionFen, resolve, depth: 0, scoreWhite: null, hasScore: false, timer: null };
      job.timer = window.setTimeout(() => {
        if (botPendingRef.current !== job) return;
        botPendingRef.current = null;
        try { worker.terminate(); } catch { /* already closed */ }
        if (botWorkerRef.current === worker) botWorkerRef.current = null;
        botReadyRef.current = false;
        setBotEngineReady(false);
        setEngineError('Отдельный движок бота превысил лимит времени. Ответ сделан быстрым резервным поиском.');
        resolve(fallbackAnalysis(positionFen, 0));
      }, Math.max(900, timeMs + 950));
      botPendingRef.current = job;
      try {
        worker.postMessage(`setoption name Skill Level value ${skill}`);
        worker.postMessage(`position fen ${positionFen}`);
        worker.postMessage(`go movetime ${Math.max(120, Math.round(timeMs))}`);
      } catch {
        window.clearTimeout(job.timer);
        botPendingRef.current = null;
        resolve(fallbackAnalysis(positionFen, 0));
      }
    });
  }, []);

  useEffect(() => {
    if (busy || isOver || mode === 'online' || !analysisEnabled) return;
    const currentFen = chess.fen();
    let cancelled = false;
    const runAnalysis = async () => {
      // In a friend game, compare the best root score with this exact played
      // move restricted at the same root, depth and side-to-move.
      const gradeTarget = pendingMoveGradesRef.current.get(currentFen);
      if (gradeTarget) {
        pendingMoveGradesRef.current.delete(currentFen);
        const playedUci = `${gradeTarget.move.from}${gradeTarget.move.to}${gradeTarget.move.promotion || ''}`;
        // Reuse the real pre-move analysis already shown to the player. Only
        // one extra search is needed: force the played move from that same root.
        const baseline = gradeTarget.before;
        if (!baseline?.engine || !baseline.hasScore || baseline.depth < 8) {
          setAnalysisText('Нужно дождаться готового анализа позиции. Штраф не начислен.');
        } else {
          const afterMovePosition = await requestEngine(gradeTarget.beforeFen, baseline.depth, 20, {
            multiPV: 1, searchMove: playedUci, kind: 'grade-played-move',
            isCurrent: () => !cancelled && gameRef.current.fen() === currentFen && analysisEnabledRef.current,
          });
          if (cancelled || gameRef.current.fen() !== currentFen) return;
          const compared = compareMoveEvaluation(baseline, afterMovePosition, gradeTarget.move);
          if (compared) {
            const { quality } = compared;
            setLastMoveQuality(quality);
            setLastMoveQualityApprox(false);
            setMoveRows((rows) => rows.map((row) => row.ply === gradeTarget.ply ? { ...row, quality, qualityApprox: false } : row));
            setPoints((value) => value + QUALITY[quality].points);
            setAnalysisText(`${QUALITY[quality].label} · Stockfish · одинаковая глубина`);
          } else {
            setAnalysisText('Недостаточно надёжных данных. Оценка пропущена, очки не изменены.');
          }
        }
      }
      if (cancelled || gameRef.current.fen() !== currentFen) return;
      const result = await requestEngine(currentFen, level.analysisDepth, 20, { timeMs: 1500, multiPV: 3, kind: 'analysis', isCurrent: () => !cancelled && gameRef.current.fen() === currentFen && analysisEnabledRef.current });
      if (cancelled || gameRef.current.fen() !== currentFen) return;
      analysisCacheRef.current = { fen: currentFen, ...result };
      setEngineLines(result.lines || []);
      setEvalWhite(result.scoreWhite);
      setEvalDepth(result.depth);
      setAnalysisText(result.engine === false
        ? 'Приблизительная оценка · быстрый резервный minimax на 2 полухода'
        : `Stockfish · глубина ${result.depth} полуходов`);
    };
    runAnalysis().catch((error) => {
      if (!cancelled) setAnalysisText(error.message);
    });
    return () => { cancelled = true; };
  }, [analysisEnabled, busy, engineReady, fen, isOver, level, mode, requestEngine, chess]);


  const addFlight = useCallback((move) => {
    const piece = move.piece;
    const color = move.color;
    const id = ++serialRef.current;
    setAnimation({ id, from: move.from, to: move.to, piece, color });
    return new Promise((resolve) => {
      // Let React paint the moving piece before the next side is allowed to move.
      window.setTimeout(() => {
        setAnimation((current) => current?.id === id ? null : current);
        resolve();
      }, 185);
    });
  }, []);

  const applyMove = useCallback((game, from, to, promotionPiece = 'q') => {
    const moves = game.moves({ square: from, verbose: true });
    const candidate = moves.find((item) => item.to === to);
    if (!candidate) return null;
    const move = game.move({ from, to, promotion: candidate.promotion ? promotionPiece : undefined });
    if (move) move.flightPromise = addFlight(move);
    return move;
  }, [addFlight]);

  const updateAfterMove = useCallback((move, qualityKey = null) => {
    if (!move) return;
    setLastMove({ from: move.from, to: move.to });
    setHintMove(null);
    setSelected(null);
    setMoveRows((rows) => [...rows, {
      ply: rows.length,
      san: move.san,
      color: move.color,
      quality: qualityKey,
    }]);
    forceRender();
  }, [forceRender]);

  const finishBotTurn = useCallback(async () => {
    const replyFen = gameRef.current.fen();
    if (mode !== 'bot' || gameRef.current.isGameOver() || gameRef.current.turn() !== 'b'
        || botBusyRef.current || lastBotReplyFenRef.current === replyFen) return;
    botBusyRef.current = true;
    lastBotReplyFenRef.current = replyFen;
    let replyCommitted = false;
    setAnalysisText('Компьютер думает…');
    try {
      const thinkStartedAt = performance.now();
      const adaptiveMaxMs = levelIndex === 5 ? getAdaptiveMaxBotTime(replyFen) : level.botTimeMs;
      const result = levelIndex === 0
        ? fallbackAnalysis(replyFen, 230)
        : await requestBotMove(replyFen, level.depth, level.skill, adaptiveMaxMs);
      // The board stays fully bright while the bot thinks. MAX uses adaptive
      // time: quick quiet moves, longer searches for checks/tactics/endgames.
      const minThinkMs = levelIndex === 0 ? 420 : levelIndex === 5 ? 260 : 520;
      const remainingThinkMs = minThinkMs - (performance.now() - thinkStartedAt);
      if (remainingThinkMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingThinkMs));
      if (gameRef.current.fen() !== replyFen || gameRef.current.turn() !== 'b' || gameRef.current.isGameOver()) return;
      let candidate = fromUci(result?.bestMove);
      let legal = gameRef.current.moves({ verbose: true });
      if (!candidate || !legal.some((move) => move.from === candidate.from && move.to === candidate.to && (move.promotion || undefined) === (candidate.promotion || undefined))) {
        candidate = fromUci(fallbackAnalysis(replyFen, levelIndex === 0 ? 230 : 0).bestMove);
      }
      if (!candidate || gameRef.current.fen() !== replyFen) return;
      const played = gameRef.current.move(candidate);
      if (!played) return;
      replyCommitted = true;
      const botFlight = addFlight(played);
      setLastMove({ from: played.from, to: played.to });
      setMoveRows((rows) => [...rows, { ply: rows.length, san: played.san, color: played.color, quality: null }]);
      setSelected(null);
      setHintMove(null);
      forceRender();
      setAnalysisText(result?.engine === true ? `Stockfish сделал один ход · глубина ${result.depth || '—'}` : 'Компьютер сделал один резервный ход');
      await botFlight;
    } catch (error) {
      // The fallback is used only if no bot reply has been committed yet.
      if (!replyCommitted && gameRef.current.fen() === replyFen && !gameRef.current.isGameOver()) {
        const legal = gameRef.current.moves({ verbose: true });
        const fallback = legal[Math.floor(Math.random() * legal.length)];
        if (fallback) {
          const played = gameRef.current.move({ from: fallback.from, to: fallback.to, promotion: fallback.promotion });
          if (played) {
            replyCommitted = true;
            const fallbackFlight = addFlight(played);
            setLastMove({ from: played.from, to: played.to });
            setMoveRows((rows) => [...rows, { ply: rows.length, san: played.san, color: played.color, quality: null }]);
            forceRender();
            await fallbackFlight;
          }
        }
      }
      setAnalysisText(`Движок не ответил: ${error.message}. Выполнен не более чем один резервный ход.`);
    } finally {
      botBusyRef.current = false;
    }
  }, [addFlight, forceRender, level, levelIndex, mode, requestBotMove]);

  const cancelNonBotSearch = useCallback(() => {
    const pending = pendingRef.current;
    const worker = workerRef.current;
    if (!pending || pending.kind === 'bot' || !worker) return;
    // Keep the request in the queue until Stockfish acknowledges `stop` with
    // its old bestmove. Resolving early lets the next search start too soon and
    // can cause the old bestmove to be consumed as the bot's answer.
    if (pending.cancelled) return;
    pending.cancelled = true;
    window.clearTimeout(pending.timer);
    // A cancelled analysis must not hold the human->bot handoff for seconds.
    // Stockfish normally acknowledges stop almost immediately; if it does not,
    // retire this worker after 450 ms and let the bot use the legal fallback.
    pending.timer = window.setTimeout(() => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      const activeWorker = workerRef.current;
      if (activeWorker) {
        try { activeWorker.terminate(); } catch { /* already terminated */ }
        workerRef.current = null;
      }
      readyRef.current = false;
      setEngineReady(false);
      setEngineError('Stockfish не остановил старый анализ вовремя. Текущий ход продолжится резервным способом. Перезапустите игру, чтобы повторно загрузить движок.');
      pending.resolve({ cancelled: true, bestMove: null, scoreWhite: null, depth: 0, engine: false, hasScore: false });
    }, 450);
    try { worker.postMessage('stop'); } catch { /* the 450 ms recovery handles it */ }
  }, []);

  const commitMove = useCallback(async (from, to, promotionPiece = 'q') => {
    if (moveLockRef.current || busy || isOver || (mode === 'bot' && chess.turn() !== 'w')) return;
    if (mode === 'online') {
      const socket = onlineSocketRef.current;
      if (onlineStatus !== 'playing' || !onlineMatchRef.current || chess.turn() !== onlineColorRef.current || socket?.readyState !== WebSocket.OPEN) return;
      const legalMove = chess.moves({ square: from, verbose: true }).find((item) => item.to === to);
      if (!legalMove) return;
      moveLockRef.current = true;
      setBusy(true);
      setSelected(null);
      try {
        const uci = `${from}${to}${legalMove.promotion ? promotionPiece : ''}`;
        socket.send(JSON.stringify({ type: 'move', matchId: onlineMatchRef.current.matchId, uci }));
        setOnlineMessage('Отправляем ход серверу…');
      } catch {
        moveLockRef.current = false;
        setBusy(false);
        setOnlineMessage('Не удалось отправить ход. Проверь соединение.');
      }
      return;
    }
    moveLockRef.current = true;

    const taskId = ++moveSerialRef.current;
    // Keep the analysis worker alive across moves. The bot has its own worker,
    // so stopping the analysis search here is unnecessary and could terminate
    // Stockfish after the short stop-acknowledgement timeout.

    const previousFen = chess.fen();
    const cachedAnalysis = analysisCacheRef.current?.fen === previousFen ? analysisCacheRef.current : null;
    const analyzeThisMove = analysisEnabledRef.current && mode !== 'online';
    const move = applyMove(chess, from, to, promotionPiece);
    if (!move) { moveLockRef.current = false; return; }

    const moveFen = chess.fen();
    lastBotReplyFenRef.current = null;
    const movePly = moveRows.length;
    // No brilliant label from a simple hanging-piece test: a sacrifice must
    // be confirmed by deeper tactical analysis, not merely by an attacked square.
    const gradedMove = { ...move, brilliantCandidate: false };
    analysisCacheRef.current = null;
    setLastMove({ from: move.from, to: move.to });
    setHintMove(null);
    setLastMoveQuality(null);
    setLastMoveQualityApprox(false);
    setSelected(null);
    setPromotion(null);
    setMoveRows((rows) => [...rows, { ply: movePly, san: move.san, color: move.color, quality: null }]);
    setBusy(mode === 'bot');
    setAnalysisText(mode === 'bot' ? 'Ход принят · фигура перемещается…' : 'Ход принят · обновляю оценку…');
    forceRender();

    const gradeMoveInBackground = async (finalFen) => {
      if (!analyzeThisMove || !analysisEnabledRef.current) return;
      try {
        // Use the pre-move analysis that was already calculated for the panel.
        // This avoids repeating a full root search after the bot has replied.
        const baseline = cachedAnalysis;
        if (!baseline?.engine || !baseline.hasScore || baseline.depth < 8) {
          setAnalysisText('Недостаточная глубина анализа до хода · штраф не начислен.');
          return;
        }
        const playedUci = `${move.from}${move.to}${move.promotion || ''}`;
        const afterMovePosition = await requestEngine(previousFen, baseline.depth, 20, {
          multiPV: 1, searchMove: playedUci, kind: 'grade-played-move',
          isCurrent: () => moveSerialRef.current === taskId && analysisEnabledRef.current,
        });
        if (moveSerialRef.current !== taskId || !analysisEnabledRef.current || gameRef.current.fen() !== finalFen) return;
        const compared = compareMoveEvaluation(baseline, afterMovePosition, gradedMove);
        if (compared) {
          setLastMoveQuality(compared.quality);
          setLastMoveQualityApprox(false);
          setMoveRows((rows) => rows.map((row) => row.ply === movePly ? { ...row, quality: compared.quality, qualityApprox: false } : row));
          setPoints((value) => value + QUALITY[compared.quality].points);
          setAnalysisText(`${QUALITY[compared.quality].label} · Stockfish · одинаковая глубина`);
        } else {
          setAnalysisText('Не хватило сопоставимых данных Stockfish на глубине 10+. Очки не изменены.');
        }
      } catch (error) {
        if (moveSerialRef.current === taskId) setAnalysisText(`Оценка хода не завершена: ${error.message}`);
      }
    };

    try {
      if (mode === 'bot' && !chess.isGameOver()) {
        // Wait for the player's move animation to finish before starting the bot.
        // This guarantees two visibly separate moves instead of one combined board update.
        await (move.flightPromise || new Promise((resolve) => window.setTimeout(resolve, 185))); 
        if (moveSerialRef.current !== taskId) return;
        setAnalysisText(analyzeThisMove ? 'Твой ход принят · компьютер думает…' : 'Компьютер думает…');
        if (moveSerialRef.current !== taskId) return;
        // finishBotTurn reserves the black-to-move FEN before searching, so one
        // player move can trigger exactly one engine request and one bot reply.
        await finishBotTurn();
        const finalFen = chess.fen();
        // Unlock immediately after the bot's piece has landed. Move grading is
        // a background task and must never make the next player move wait.
        setBusy(false);
        forceRender();
        if (analyzeThisMove) void gradeMoveInBackground(finalFen);
        return;
      }
      if (mode === 'local' && analyzeThisMove) {
        pendingMoveGradesRef.current.set(moveFen, { before: cachedAnalysis, beforeFen: previousFen, move: gradedMove, ply: movePly });
      }
    } catch (error) {
      if (analyzeThisMove) setAnalysisText(`Анализ недоступен: ${error.message}`);
      if (mode === 'bot' && !chess.isGameOver() && moveSerialRef.current === taskId) await finishBotTurn();
    } finally {
      if (moveSerialRef.current === taskId) {
        setBusy(false);
        moveLockRef.current = false;
        forceRender();
      }
    }
  }, [analysisEnabled, applyMove, busy, chess, finishBotTurn, forceRender, isOver, level, levelIndex, mode, moveRows.length, onlineStatus, requestEngine]);


  const handleSquareClick = (square) => {
    if (busy || isOver || !humanTurn) return;
    if (mode === 'online' && (onlineStatus !== 'playing' || !onlineMatchRef.current || chess.turn() !== onlineColorRef.current)) return;
    const piece = chess.get(square);
    if (selected) {
      if (selected === square) {
        setSelected(null);
        return;
      }
      const legal = chess.moves({ square: selected, verbose: true });
      const target = legal.find((move) => move.to === square);
      if (target) {
        if (target.promotion) setPromotion({ from: selected, to: square });
        else commitMove(selected, square);
        return;
      }
    }
    if (piece && piece.color === chess.turn()) setSelected(square);
    else setSelected(null);
  };

  const resetGame = (nextMode = mode) => {
    moveSerialRef.current += 1;
    try { onlineSocketRef.current?.close(); } catch { /* already closed */ }
    onlineSocketRef.current = null;
    onlineMatchRef.current = null;
    onlineColorRef.current = null;
    setOnlineStatus('idle');
    setOnlineMessage('');
    setOnlineOpponent(null);
    setOnlineMatch(null);
    if (pendingRef.current && workerRef.current && !pendingRef.current.cancelled) {
      pendingRef.current.cancelled = true;
      try { workerRef.current.postMessage('stop'); } catch { /* worker may already be closing */ }
    }
    gameRef.current = new Chess();
    analysisCacheRef.current = null;
    pendingMoveGradesRef.current.clear();
    botBusyRef.current = false;
    moveLockRef.current = false;
    lastBotReplyFenRef.current = null;
    setSelected(null);
    setLastMove(null);
    setHintMove(null);
    setStars(3);
    setAnalysisPaid(false);
    analysisPaidRef.current = false;
    ratingUpdatedRef.current = false;
    setRatingNotice('');
    setAnalysisEnabled(nextMode === 'local');
    setPoints(0);
    setMoveRows([]);
    setLastMoveQuality(null);
    setLastMoveQualityApprox(false);
    setEvalWhite(nextMode === 'local' ? evaluatePosition(gameRef.current) : null);
    setEvalDepth(0);
    setEngineLines([]);
    setPromotion(null);
    setAnimation(null);
    setBusy(false);
    setAnalysisText(nextMode === 'local' ? (engineReady ? 'Анализ новой партии' : 'Подготовка движка…') : 'Оценка позиции выключена');
    forceRender();
  };

  const toggleAnalysis = () => {
    if (mode === 'online') return;
    if (analysisEnabled) {
      setAnalysisEnabled(false);
      analysisCacheRef.current = null;
      setEvalWhite(null);
      setEvalDepth(0);
      setAnalysisText('Оценка позиции выключена');
      return;
    }
    if (mode === 'bot' && !analysisPaidRef.current) {
      if (stars <= 0) return;
      setStars((value) => Math.max(0, value - 1));
      setAnalysisPaid(true);
      analysisPaidRef.current = true;
    }
    setAnalysisEnabled(true);
    setAnalysisText(busy ? 'Оценка включена · запустится после ответа бота' : 'Запускаю анализ позиции…');
  };

  const configureOnlineServer = async () => {
    try {
      const candidate = new URL(String(serverAddress || '').trim());
      if (!['https:', 'http:'].includes(candidate.protocol)) throw new Error('Нужен адрес https:// или http://.');
      const base = candidate.origin;
      setServerAddressStatus('Проверяем подключение…');
      const response = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Сервер ответил HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok || !payload.matchmaking) throw new Error('Сервер доступен, но матчмейкинг не включён.');
      saveServerUrl(base);
      setServerAddress(base);
      setServerAddressStatus('Сервер доступен · матчмейкинг включён. Теперь выйди из локального аккаунта и войди/зарегистрируй серверный аккаунт.');
      setOnlineMessage('Сервер проверен и сохранён.');
    } catch (error) {
      setServerAddressStatus(`Не удалось проверить сервер: ${error.message}`);
    }
  };

  const findOnlineMatch = async () => {
    if (!isServerConfigured()) {
      setOnlineMessage('Сервер не настроен. После публикации API укажи его HTTPS-адрес в VITE_API_URL и пересобери приложение.');
      setOnlineStatus('error');
      return;
    }
    if (session?.scope !== 'server' || !session?.token) {
      setOnlineMessage('Для сетевой игры нужен аккаунт, созданный на общем сервере. Войди в серверный аккаунт.');
      setOnlineStatus('error');
      return;
    }
    if (onlineSocketRef.current) {
      try { onlineSocketRef.current.close(); } catch { /* already closed */ }
      onlineSocketRef.current = null;
    }
    setOnlineMessage('Подключаемся к серверу…');
    setOnlineStatus('connecting');
    setOnlineOpponent(null);
    setOnlineMatch(null);
    try {
      const socket = await openOnlineSocket(session);
      onlineSocketRef.current = socket;
      socket.onopen = () => {
        if (onlineSocketRef.current !== socket) return;
        socket.send(JSON.stringify({ type: 'queue' }));
        setOnlineStatus('queued');
        setOnlineMessage('Ищем соперника с близким рейтингом…');
      };
      socket.onmessage = (event) => {
        if (onlineSocketRef.current !== socket) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'connected') {
          setOnlineMessage(`Подключено как ${message.nickname} · рейтинг ${message.rating}`);
        } else if (message.type === 'queued') {
          setOnlineStatus('queued');
          setOnlineMessage(`Поиск соперника · твой рейтинг ${message.rating} · ожидание ${message.waitingSeconds || 0} сек.`);
        } else if (message.type === 'matched') {
          onlineMatchRef.current = message;
          onlineColorRef.current = message.color;
          setOnlineMatch(message);
          setOnlineOpponent(message.opponent);
          gameRef.current = new Chess(message.fen);
          setMoveRows([]);
          setLastMove(null);
          setSelected(null);
          setHintMove(null);
          setBusy(false);
          moveLockRef.current = false;
          setOnlineStatus('playing');
          setOnlineMessage(`Матч найден! Ты играешь ${message.color === 'w' ? 'белыми' : 'чёрными'}.`);
          forceRender();
        } else if (message.type === 'move') {
          if (onlineMatchRef.current?.matchId !== message.matchId) return;
          try {
            const played = gameRef.current.move({ from: message.from, to: message.to, promotion: message.promotion || undefined });
            if (!played) throw new Error('Получен недопустимый ход');
            const fallbackFlight = addFlight(played);
            setLastMove({ from: played.from, to: played.to });
            setMoveRows((rows) => [...rows, { ply: rows.length, san: played.san, color: played.color, quality: null }]);
            setBusy(false);
            moveLockRef.current = false;
            setSelected(null);
            forceRender();
            setOnlineMessage(played.color === onlineColorRef.current ? 'Твой ход принят сервером.' : `Ход соперника: ${played.san}`);
          } catch {
            // Server FEN is authoritative if a client missed a packet.
            if (message.fen) gameRef.current = new Chess(message.fen);
            setBusy(false);
            moveLockRef.current = false;
            forceRender();
            setOnlineMessage('Позиция синхронизирована с сервером.');
          }
        } else if (message.type === 'gameOver') {
          setOnlineStatus('finished');
          setBusy(false);
          moveLockRef.current = false;
          if (session?.scope === 'server' && message.user) {
            const updatedSession = { ...session, user: message.user };
            saveSession(updatedSession);
            setSession(updatedSession);
          }
          setRatingNotice(`Онлайн-результат: ${message.reason}. Рейтинг ${message.user?.rating ?? '—'} (${message.delta >= 0 ? '+' : ''}${message.delta ?? 0}).`);
          setOnlineMessage(`Партия завершена: ${message.reason}.`);
          onlineMatchRef.current = null;
          setOnlineMatch(null);
        } else if (message.type === 'drawOffered') {
          setOnlineMessage(`${message.from} предлагает ничью.`);
        } else if (message.type === 'opponentDisconnected') {
          setOnlineStatus('disconnected');
          setOnlineMessage(message.message);
          setBusy(false);
          moveLockRef.current = false;
        } else if (message.type === 'error') {
          setOnlineMessage(message.message || 'Ошибка онлайн-соединения.');
          setBusy(false);
          moveLockRef.current = false;
        }
      };
      socket.onerror = () => {
        setOnlineStatus('error');
        setOnlineMessage('Не удалось подключиться к серверу. Проверь URL, HTTPS/WSS и доступность сервера.');
        setBusy(false);
        moveLockRef.current = false;
      };
      socket.onclose = () => {
        if (onlineSocketRef.current !== socket) return;
        onlineSocketRef.current = null;
        setOnlineStatus('disconnected');
        setOnlineMessage('Соединение закрыто. Можно попробовать найти соперника снова.');
        setBusy(false);
        moveLockRef.current = false;
      };
    } catch (error) {
      setOnlineStatus('error');
      setOnlineMessage(error.message || 'Не удалось открыть онлайн-соединение.');
    }
  };

  const cancelOnlineSearch = () => {
    const socket = onlineSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'cancelQueue' })); } catch { /* connection closing */ }
    }
    try { socket?.close(); } catch { /* already closed */ }
    onlineSocketRef.current = null;
    onlineMatchRef.current = null;
    onlineColorRef.current = null;
    setOnlineMatch(null);
    setOnlineOpponent(null);
    setOnlineStatus('idle');
    setOnlineMessage('Поиск отменён.');
    setBusy(false);
    moveLockRef.current = false;
  };

  const resignOnlineMatch = () => {
    const socket = onlineSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resign' }));
  };

  const submitAccountForm = async (event) => {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthMessage('');
    try {
      const result = authMode === 'register'
        ? await registerAccount(authNickname, authPassword)
        : await loginAccount(authNickname, authPassword);
      setLocalAccounts(result.localAccounts);
      saveSession(result.session);
      setSession(result.session);
      setAuthPassword('');
      const actionWord = authMode === 'register' ? 'Аккаунт создан' : 'Вход выполнен';
      setAuthMessage(result.session.scope === 'server'
        ? `${actionWord}. Профиль подключён к серверу, ник уникален глобально.`
        : `${actionWord}. Профиль сохранён на этом устройстве.`);
      if (!localWhiteId) setLocalWhiteId(result.session.user.id);
      else if (!localBlackId && localWhiteId !== result.session.user.id && result.session.scope === 'local') setLocalBlackId(result.session.user.id);
    } catch (error) {
      setAuthMessage(error.message || 'Не удалось выполнить вход.');
    } finally {
      setAuthBusy(false);
    }
  };

  const logoutAccount = () => {
    saveSession(null);
    setSession(null);
    setAuthMessage('');
  };

  useEffect(() => {
    let cancelled = false;
    if (session?.scope === 'server') {
      restoreServerSession(session).then((restored) => {
        if (cancelled) return;
        if (restored) { setSession(restored); saveSession(restored); }
        else { setSession(null); saveSession(null); }
      });
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isOver || mode === 'online' || ratingUpdatedRef.current) return;
    ratingUpdatedRef.current = true;
    const whiteScore = chess.isCheckmate() ? (chess.turn() === 'b' ? 1 : 0) : 0.5;
    const matchId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    if (mode === 'bot') {
      if (!profile) {
        setRatingNotice('Войдите в аккаунт, чтобы сохранять изменения рейтинга.');
        return;
      }
      if (session?.scope === 'server' && session.token && isServerConfigured()) {
        reportServerBotResult(session, level.elo, whiteScore, matchId).then((user) => {
          const updatedSession = { ...session, user };
          saveSession(updatedSession);
          setSession(updatedSession);
          setRatingNotice(`Рейтинг ${user.rating} (${user.lastRatingChange >= 0 ? '+' : ''}${user.lastRatingChange ?? 0}) · соперник ${level.elo} · калибровка K=${user.ratingStageGames <= 10 ? 120 : user.ratingStageGames <= 30 ? 80 : user.ratingStageGames <= 60 ? 48 : 24}.`);
        }).catch((error) => setRatingNotice(`Не удалось сохранить рейтинг на сервере: ${error.message}`));
      } else if (session?.scope === 'local') {
        const result = applyBotResult(localAccounts, profile.id, level.elo, whiteScore);
        setLocalAccounts(result.accounts);
        const updated = result.accounts.find((item) => item.id === profile.id);
        if (updated) {
          const updatedSession = { ...session, user: publicProfile(updated) };
          saveSession(updatedSession);
          setSession(updatedSession);
        }
        setRatingNotice(`Рейтинг ${updated?.rating ?? profile.rating} (${result.delta >= 0 ? '+' : ''}${result.delta}) · соперник ${level.elo} · калибровка K=${updated?.ratingStageGames <= 10 ? 120 : updated?.ratingStageGames <= 30 ? 80 : updated?.ratingStageGames <= 60 ? 48 : 24}.`);
      }
      return;
    }
    const result = applyLocalFriendResult(localAccounts, localWhiteId, localBlackId, whiteScore);
    if (!result.changes) {
      setRatingNotice('Для рейтинговой игры с другом выберите два разных локальных аккаунта.');
      return;
    }
    setLocalAccounts(result.accounts);
    const activeUpdated = result.accounts.find((item) => item.id === profile?.id);
    if (activeUpdated && session?.scope === 'local') {
      const updatedSession = { ...session, user: publicProfile(activeUpdated) };
      saveSession(updatedSession);
      setSession(updatedSession);
    }
    setRatingNotice(`Рейтинг обновлён: белые ${result.changes.white >= 0 ? '+' : ''}${result.changes.white}, чёрные ${result.changes.black >= 0 ? '+' : ''}${result.changes.black}.`);
  }, [isOver, fen, mode, session, profile, level.elo, localAccounts, localWhiteId, localBlackId, chess]);

  const useHint = async () => {
    if (stars <= 0 || mode !== 'bot' || busy || isOver || chess.turn() !== 'w') return;
    setStars((value) => value - 1);
    setBusy(true);
    setAnalysisText('Ищем сильнейший ход…');
    try {
      const hintFen = chess.fen();
      const hintTask = moveSerialRef.current;
      const result = await requestEngine(hintFen, Math.max(level.analysisDepth, 14), 20, { timeMs: 900, multiPV: 1, kind: 'hint', isCurrent: () => moveSerialRef.current === hintTask && gameRef.current.fen() === hintFen });
      if (moveSerialRef.current !== hintTask || gameRef.current.fen() !== hintFen) return;
      const move = fromUci(result.bestMove);
      setHintMove(move ? { from: move.from, to: move.to } : null);
      setAnalysisText(move ? `${result.engine === false ? 'Подсказка (резервная стратегия)' : 'Подсказка Stockfish'}: ${move.from} → ${move.to}` : 'Подсказка недоступна');
    } catch (error) {
      setAnalysisText(`Подсказка недоступна: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const undoMove = () => {
    if (busy || mode === 'online') return;
    moveSerialRef.current += 1;
    if (pendingRef.current && workerRef.current) { try { workerRef.current.postMessage('stop'); } catch {} }
    let nextRows;
    if (mode === 'bot') {
      chess.undo();
      if (chess.turn() === 'b') chess.undo();
      nextRows = moveRows.slice(0, -Math.min(2, moveRows.length));
    } else {
      chess.undo();
      nextRows = moveRows.slice(0, -1);
    }
    setMoveRows(nextRows);
    const lastGradedRow = [...nextRows].reverse().find((row) => row.quality);
    setLastMoveQuality(lastGradedRow?.quality || null);
    setLastMoveQualityApprox(lastGradedRow?.qualityApprox === true);
    analysisCacheRef.current = null;
    pendingMoveGradesRef.current.clear();
    setLastMove(null);
    setSelected(null);
    setHintMove(null);
    setPoints(0);
    setEvalWhite(null);
    setEvalDepth(0);
    forceRender();
  };

  const legalTargets = selected ? chess.moves({ square: selected, verbose: true }) : [];
  const legalTargetSquares = new Set(legalTargets.map((move) => move.to));
  const status = getStatus(chess);
  const progress = Math.max(4, Math.min(96, 50 + (evalWhite || 0) / 18));
  const displayRows = moveRows.reduce((acc, row) => {
    const moveNo = Math.floor(row.ply / 2) + 1;
    if (!acc[acc.length - 1] || acc[acc.length - 1].number !== moveNo) acc.push({ number: moveNo, white: null, black: null });
    acc[acc.length - 1][row.color === 'w' ? 'white' : 'black'] = row;
    return acc;
  }, []);

  const pieceCoords = (square) => {
    const file = FILES.indexOf(square[0]);
    const rank = 8 - Number(square[1]);
    const orientedFile = flipped ? 7 - file : file;
    const orientedRank = flipped ? 7 - rank : rank;
    return { left: `${orientedFile * 12.5}%`, top: `${orientedRank * 12.5}%` };
  };

  const renderSquare = ({ square, rowIndex, colIndex, isLight }) => {
    const piece = chess.get(square);
    const isSelected = selected === square;
    const isLast = lastMove?.from === square || lastMove?.to === square;
    const isHint = hintMove?.from === square || hintMove?.to === square;
    const isCheckKing = piece?.type === 'k' && piece.color === chess.turn() && chess.isCheck();
    const hideForFlight = animation?.to === square && animation?.piece === piece?.type && animation?.color === piece?.color;
    return (
      <button
        type="button"
        key={square}
        className={`square ${isLight ? 'light' : 'dark'} ${isSelected ? 'selected' : ''} ${isLast ? 'last-move' : ''} ${isHint ? 'hint-square' : ''} ${isCheckKing ? 'king-check' : ''}`}
        onClick={() => handleSquareClick(square)}
        aria-label={square}
      >
        {colIndex === 0 && <span className={`coord rank ${isLight ? 'coord-dark' : 'coord-light'}`}>{square[1]}</span>}
        {rowIndex === 7 && <span className={`coord file ${isLight ? 'coord-dark' : 'coord-light'}`}>{square[0]}</span>}
        {piece && <span className={`piece ${piece.color} ${hideForFlight ? 'piece-hidden' : ''}`}>
          {PIECES[piece.color][piece.type]}
        </span>}
        {legalTargetSquares.has(square) && <span className={piece ? 'legal-capture' : 'legal-dot'} />}
      </button>
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-mark">♞</div>
          <div>
            <div className="brand-name">CHESS ARENA</div>
            <div className="brand-subtitle">Твоя шахматная лаборатория</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`engine-pill ${engineReady && botEngineReady ? 'ready' : engineError ? 'fallback' : 'loading'}`}>
            <span className="status-dot" />{engineReady && botEngineReady ? 'Stockfish 19 готов' : (engineReady || botEngineReady) ? 'Stockfish частично готов' : engineError ? 'Резервный режим' : 'Загрузка движков'}
          </span>
          <button className="icon-button" onClick={() => setFlipped((v) => !v)} title="Перевернуть доску">⇅</button>
        </div>
      </header>

      <main className="main-layout">
        <section className="board-column">
          <div className="game-heading">
            <div>
              <div className="eyebrow">ПАРТИЯ · {mode === 'bot' ? 'ПРОТИВ КОМПЬЮТЕРА' : mode === 'local' ? 'ДВА ИГРОКА' : 'ОНЛАЙН'}</div>
              <h1>{mode === 'bot' ? `Stockfish · ${level.display || `${level.elo} ELO`}` : mode === 'local' ? 'Локальная партия' : 'Игроки онлайн'}</h1>
            </div>
            <div className="game-state-area">
              <div className="game-state"><span className={chess.isCheck() ? 'check-dot' : 'turn-dot'} />{mode === 'bot' && busy && chess.turn() === 'b' ? 'Компьютер думает…' : mode === 'online' ? (onlineMessage || status) : status}</div>
              {analysisEnabled && lastMoveQuality && <div className="move-grade-row" aria-live="polite">
                <span className="move-grade-label">{QUALITY[lastMoveQuality].label}{lastMoveQualityApprox ? ' · приблизительно' : ''}</span>
                <span className={`move-grade-badge ${QUALITY[lastMoveQuality].color} ${lastMoveQualityApprox ? 'approx' : ''}`} title={`${lastMoveQualityApprox ? 'Приблизительно · ' : ''}${QUALITY[lastMoveQuality].label}`} aria-label={`${lastMoveQualityApprox ? 'Приблизительно · ' : ''}${QUALITY[lastMoveQuality].label}`}>{QUALITY[lastMoveQuality].icon}</span>
              </div>}
            </div>
          </div>

          <div className={`board-wrap ${analysisEnabled && mode !== 'online' ? 'with-eval' : 'no-eval'}`}>
            {analysisEnabled && mode !== 'online' && <div className="eval-rail" aria-label={`Оценка позиции ${formatEval(evalWhite)}`}>
              <div className="eval-black" style={{ height: `${100 - progress}%` }} />
              <div className="eval-white" style={{ height: `${progress}%` }} />
              <span className="eval-label">{formatEval(evalWhite)}</span>
            </div>}
            <div className="board-frame" ref={boardRef}>
              <div className="chessboard">
                {boardSquares.map(renderSquare)}
                {animation && (() => {
                  const from = pieceCoords(animation.from);
                  const to = pieceCoords(animation.to);
                  const dx = parseFloat(to.left) - parseFloat(from.left);
                  const dy = parseFloat(to.top) - parseFloat(from.top);
                  return <div
                    key={animation.id}
                    className={`flight-piece ${animation.color}`}
                    style={{ left: from.left, top: from.top, '--dx': `${dx * 8}%`, '--dy': `${dy * 8}%` }}
                  >{PIECES[animation.color][animation.piece]}</div>;
                })()}
              </div>
            </div>
          </div>

          <div className="board-footer">
            <div className="footer-legend"><span className="legend-swatch yellow" /> Последний ход <span className="legend-swatch green" /> Возможный ход <span className="legend-swatch purple" /> Подсказка</div>
            <div className="turn-caption">{chess.turn() === 'w' ? '♙ Белые' : '♟ Чёрные'} · ход {chess.moveNumber()}</div>
          </div>
        </section>

        <aside className="side-column">
          <section className="panel account-panel">
            <div className="panel-head"><h2>Аккаунт и рейтинг</h2><span className="panel-kicker">ELO</span></div>
            {profile ? (
              <>
                <div className="profile-card">
                  <div className="profile-avatar">{profile.nickname?.slice(0, 1)?.toUpperCase() || '♟'}</div>
                  <div className="profile-main"><strong>{profile.nickname}</strong><small>{session.scope === 'server' ? 'Серверный аккаунт' : 'Локальный аккаунт'}</small></div>
                  <div className="profile-rating"><b>{activeLocalProfile?.rating ?? profile.rating ?? 1200}</b><small>RATING</small></div>
                </div>
                <div className="profile-stats"><span>Игр <b>{activeLocalProfile?.games ?? profile.games ?? 0}</b></span><span>Побед <b>{activeLocalProfile?.wins ?? profile.wins ?? 0}</b></span><span>Ничьих <b>{activeLocalProfile?.draws ?? profile.draws ?? 0}</b></span><span>Поражений <b>{activeLocalProfile?.losses ?? profile.losses ?? 0}</b></span></div>
                {authMessage && <p className="account-message">{authMessage}</p>}
                <button className="account-secondary" type="button" onClick={logoutAccount}>Выйти из аккаунта</button>
              </>
            ) : (
              <form className="account-form" onSubmit={submitAccountForm}>
                <div className="account-tabs"><button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => { setAuthMode('register'); setAuthMessage(''); }}>Создать аккаунт</button><button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => { setAuthMode('login'); setAuthMessage(''); }}>Войти</button></div>
                <label>НИК<input value={authNickname} onChange={(event) => setAuthNickname(event.target.value)} autoComplete="username" minLength={3} maxLength={16} placeholder="Например, ChessFan" required /></label>
                <label>ПАРОЛЬ<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} minLength={8} maxLength={128} placeholder="Минимум 8 символов" required /></label>
                <button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Подождите…' : authMode === 'register' ? 'Создать аккаунт' : 'Войти в аккаунт'}</button>
                {authMessage && <p className="account-message">{authMessage}</p>}
              </form>
            )}
            <p className="account-scope">{isServerConfigured() ? 'Подключён сервер: ники уникальны для всех пользователей сервера.' : 'Локальный режим: ник уникален на этом устройстве. Для общей базы аккаунтов настройте сервер.'}</p>
            {mode === 'local' && (
              <div className="local-rating-players">
                <strong>Участники рейтинговой партии</strong>
                <label>Белые<select value={localWhiteId} onChange={(event) => setLocalWhiteId(event.target.value)}><option value="">Выберите аккаунт</option>{localAccounts.map((item) => <option key={item.id} value={item.id}>{item.nickname} · {item.rating}</option>)}</select></label>
                <label>Чёрные<select value={localBlackId} onChange={(event) => setLocalBlackId(event.target.value)}><option value="">Выберите аккаунт</option>{localAccounts.map((item) => <option key={item.id} value={item.id}>{item.nickname} · {item.rating}</option>)}</select></label>
                <small>Создайте два аккаунта на этом устройстве, чтобы обновлять рейтинг обоих игроков.</small>
              </div>
            )}
            {ratingNotice && <p className="rating-notice">{ratingNotice}</p>}
          </section>

          <section className="panel mode-panel">
            <div className="panel-head"><h2>Режим игры</h2><span className="panel-kicker">PLAY</span></div>
            <div className="mode-tabs">
              <button className={mode === 'bot' ? 'active' : ''} onClick={() => { setMode('bot'); resetGame('bot'); }}>С ботом</button>
              <button className={mode === 'local' ? 'active' : ''} onClick={() => { setMode('local'); resetGame('local'); }}>Вдвоём</button>
              <button className={mode === 'online' ? 'active' : ''} onClick={() => { setMode('online'); resetGame('online'); }}>Онлайн</button>
            </div>
            {mode === 'bot' ? (
              <>
                <div className="setting-label">СИЛА СОПЕРНИКА</div>
                <div className="level-list">
                  {LEVELS.map((item, index) => (
                    <button key={item.elo} className={`level-option ${levelIndex === index ? 'chosen' : ''}`} onClick={() => { setLevelIndex(index); resetGame(); }}>
                      <span className="level-num">0{index + 1}</span>
                      <span className="level-desc"><strong>{item.display || item.elo}</strong><small>{item.title}</small></span>
                      <span className="level-check">{levelIndex === index ? '✓' : ''}</span>
                    </button>
                  ))}
                </div>
                {levelIndex === 5 && <p className="micro-note">MAX: адаптивный поиск Stockfish 19 до глубины 26 — обычно быстрее в тихих позициях и дольше в тактических.</p>}
                <div className="hint-row">
                  <div className="hint-stars"><span>✦</span><strong>{stars}</strong><small>/ 3</small></div>
                  <button className="hint-button" onClick={useHint} disabled={stars <= 0 || busy || isOver || chess.turn() !== 'w'}>
                    ✧ Подсказка <span>−1 ✦</span>
                  </button>
                </div>
                <p className="micro-note">Три подсказки на партию. В игре с людьми подсказки отключены.</p>
              </>
            ) : mode === 'local' ? (
              <div className="local-info"><span className="local-icon">♟</span><div><strong>Одна доска — два игрока</strong><p>Передавайте ход друг другу. Подсказки отключены.</p></div></div>
            ) : (
              <div className="online-info">
                <strong>Сетевая рейтинговая игра</strong>
                <details className="online-server-settings">
                  <summary>{isServerConfigured() ? 'Настройки сервера' : 'Подключить опубликованный сервер'}</summary>
                  <div className="online-server-config">
                    <label>Адрес сервера<input type="url" value={serverAddress} onChange={(event) => setServerAddress(event.target.value)} placeholder="https://chess-arena.example.com" /></label>
                    <button className="account-secondary" onClick={configureOnlineServer}>Проверить и сохранить сервер</button>
                    {serverAddressStatus && <p className="online-status">{serverAddressStatus}</p>}
                    <small>Сначала сервер нужно развернуть в интернете. Локальный адрес localhost виден только на этом компьютере.</small>
                  </div>
                </details>
                <p>{onlineStatus === 'playing' && onlineOpponent ? `Соперник: ${onlineOpponent.nickname} · ${onlineOpponent.rating} Elo. Ты играешь ${onlineMatch?.color === 'w' ? 'белыми' : 'чёрными'}.` : 'Поиск соперника с близким рейтингом. Нужен серверный аккаунт.'}</p>
                <p className={`online-status ${onlineStatus}`}>{onlineMessage || 'Готово к поиску соперника.'}</p>
                {onlineStatus === 'playing'
                  ? <button className="account-secondary" onClick={resignOnlineMatch}>Сдаться</button>
                  : onlineStatus === 'queued' || onlineStatus === 'connecting'
                    ? <button className="account-secondary" onClick={cancelOnlineSearch}>Отменить поиск</button>
                    : <button className="primary-button online-search-button" onClick={findOnlineMatch}>Найти соперника</button>}
              </div>
            )}
            {mode !== 'online' && <div className="analysis-access">
              <div><strong>Оценка позиции</strong><small>{mode === 'bot' && !analysisPaid ? (stars <= 0 ? 'Нет звёзд — новая партия выдаёт 3' : 'Включение стоит 1 звезду за партию') : mode === 'bot' ? 'Звезда уже оплачена для этой партии' : 'Бесплатно в игре с другом'}</small></div>
              <button className={`analysis-toggle ${analysisEnabled ? 'enabled' : ''}`} onClick={toggleAnalysis} disabled={!analysisEnabled && mode === 'bot' && !analysisPaid && stars <= 0}>
                {analysisEnabled ? 'Выключить' : mode === 'bot' && !analysisPaid ? 'Включить · −1 ✦' : 'Включить'}
              </button>
            </div>}
            <div className="action-row">
              <button className="primary-button" onClick={resetGame}>＋ Новая партия</button>
              <button className="secondary-button" onClick={undoMove} disabled={busy || isOver || moveRows.length === 0 || mode === 'online'} title="Отменить ход">↶</button>
            </div>
          </section>

          {analysisEnabled && mode !== 'online' && <section className="panel analysis-panel">
            <div className="panel-head"><h2>Компьютерный анализ</h2><span className="analysis-live"><i /> LIVE</span></div>
            <div className="eval-number-row">
              <div><span className="big-eval">{formatEval(evalWhite)}</span><span className="eval-caption">оценка позиции</span></div>
              <div className="depth-box"><strong>{evalDepth || '—'}</strong><small>ГЛУБИНА</small></div>
            </div>
            <div className="eval-track"><span style={{ width: `${progress}%` }} /></div>
            <p className="analysis-message">{analysisText}</p>
            <details className="engine-settings">
              <summary>Настройки движка</summary>
              <label className="engine-variation-toggle"><input type="checkbox" checked={showEngineVariations} onChange={(event) => setShowEngineVariations(event.target.checked)} /> Показывать лучшие ходы (только в настройках)</label>
              {showEngineVariations && <div className="engine-variation-list">
                {(engineLines || []).slice(0, 3).map((line, index) => <div key={`${line.multipv}-${index}`}><b>{index + 1}.</b> {formatEngineLine(fen, line.pv)} <small>{formatEval(line.scoreWhite)}</small></div>)}
                {(!engineLines || engineLines.length === 0) && <small>Варианты появятся после завершения поиска Stockfish.</small>}
              </div>}
            </details>
            <div className="score-card"><div><span>Очки за качество</span><strong className={points >= 0 ? 'positive' : 'negative'}>{points > 0 ? '+' : ''}{points}</strong></div><small>Начисляются за каждый ход по оценке движка</small></div>
            {engineError && <p className="error-message">{engineError}</p>}
          </section>}

          <section className="panel moves-panel">
            <div className="panel-head"><h2>Ходы партии</h2><span className="panel-kicker">{moveRows.length} PLY</span></div>
            <div className="moves-list">
              {displayRows.length === 0 ? <div className="empty-moves"><span>♙</span><p>Сделайте первый ход,<br />чтобы начать партию</p></div> : displayRows.map((row) => (
                <div className="move-line" key={row.number}>
                  <span className="move-number">{row.number}.</span>
                  <span className="move-san">{row.white?.san || '…'}{row.white?.quality && <em className={`quality-tag ${QUALITY[row.white.quality].color}`}>{QUALITY[row.white.quality].icon} {QUALITY[row.white.quality].label}{row.white.qualityApprox ? ' ≈' : ''}</em>}</span>
                  <span className="move-san">{row.black?.san || ''}{row.black?.quality && <em className={`quality-tag ${QUALITY[row.black.quality].color}`}>{QUALITY[row.black.quality].icon} {QUALITY[row.black.quality].label}{row.black.qualityApprox ? ' ≈' : ''}</em>}</span>
                </div>
              ))}
            </div>
            <div className="moves-legend"><span>◆ Бриллиантовый</span><span>★ Лучший</span><span>?! Неточность</span><span>?? Зевок</span></div>
          </section>
        </aside>
      </main>

      <footer className="app-footer"><span>CHESS ARENA</span><span>Правила: шах · мат · пат · рокировка · взятие на проходе · превращение пешки</span><span>STOCKFISH 19</span></footer>

      {promotion && <div className="modal-backdrop"><div className="promotion-modal"><h3>Превращение пешки</h3><p>Выберите фигуру</p><div className="promotion-options">{['q', 'r', 'b', 'n'].map((type) => <button key={type} onClick={() => commitMove(promotion.from, promotion.to, type)}>{PIECES.w[type]}</button>)}</div></div></div>}
      {onlineNotice && mode === 'online' && <div className="toast">Онлайн-матчмейкинг требует серверной части. Локальная игра работает.</div>}
    </div>
  );
}
