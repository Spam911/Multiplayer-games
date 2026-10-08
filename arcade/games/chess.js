'use strict';
// Online chess with a challenge system. server.js calls start(wss) once.
// Rules are enforced here (chess.js); clients only send "from/to" and get the full state back.
const crypto = require('crypto');
const { Chess } = require('chess.js');

const CHALLENGE_TTL = 30 * 1000;   // a request expires if nobody answers
const GRACE_IN_GAME = 60 * 1000;   // time to come back after a disconnect mid-game
const GRACE_IDLE = 15 * 1000;      // same, when not in a game

const players = new Map();    // id -> player
const byToken = new Map();    // token -> player (lets a refreshed page resume)
const challenges = new Map(); // cid -> { cid, from, to, timer }
let nextPlayerId = 1, nextCid = 1, nextGid = 1;

const clean = n => String(n || '').replace(/[<>&"'\\]/g, '').trim().slice(0, 16) || 'Guest';
const send = (p, obj) => {
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
};

// ---------- player list ----------
let bcTimer = null;
function scheduleBroadcast() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    bcTimer = null;
    const list = [...players.values()].filter(p => p.ws)
      .map(p => ({ id: p.id, name: p.name, status: p.game ? 'playing' : 'idle' }));
    for (const p of players.values()) send(p, { t: 'players', list });
  }, 100);
}

// ---------- challenges ----------
function dropChallenge(cid, reason) {
  const c = challenges.get(cid);
  if (!c) return;
  clearTimeout(c.timer);
  challenges.delete(cid);
  if (c.from.out === cid) c.from.out = null;
  send(c.from, { t: 'outgoing_end', cid, reason, name: c.to.name });
  send(c.to, { t: 'incoming_end', cid });
}

function challenge(from, toId) {
  const to = players.get(+toId);
  if (!to || !to.ws || to === from) return send(from, { t: 'error', msg: 'Player not available' });
  if (from.game) return send(from, { t: 'error', msg: 'Finish your current game first' });
  if (from.out) dropChallenge(from.out, 'cancelled');
  if (to.game) return send(from, { t: 'outgoing_end', cid: 0, reason: 'busy', name: to.name });
  const cid = nextCid++;
  const c = { cid, from, to, timer: setTimeout(() => dropChallenge(cid, 'expired'), CHALLENGE_TTL) };
  challenges.set(cid, c);
  from.out = cid;
  send(from, { t: 'outgoing', cid, to: { id: to.id, name: to.name } });
  send(to, { t: 'incoming', cid, from: { id: from.id, name: from.name } });
}

function respond(p, cid, accept) {
  const c = challenges.get(+cid);
  if (!c || c.to !== p) return;
  if (!accept) return dropChallenge(c.cid, 'declined');
  if (p.game || c.from.game || !c.from.ws) {
    return dropChallenge(c.cid, c.from.ws ? 'busy' : 'offline');
  }
  clearTimeout(c.timer);
  challenges.delete(c.cid);
  c.from.out = null;
  startGame(c.from, p);
}

// ---------- games ----------
function stateFor(p, g) {
  const c = g.chess;
  const color = g.white === p ? 'w' : 'b';
  const opp = color === 'w' ? g.black : g.white;
  let legal = null;
  if (!g.over && c.turn() === color) {
    legal = {};
    for (const m of c.moves({ verbose: true })) {
      const list = legal[m.from] || (legal[m.from] = []);
      if (!list.includes(m.to)) list.push(m.to);
    }
  }
  return {
    t: 'state', gid: g.id, color, me: p.name, opp: opp.name, oppOnline: !!opp.ws,
    fen: c.fen(), turn: c.turn(), history: c.history(), last: g.last,
    check: c.inCheck(), legal, over: g.over, result: g.result, reason: g.reason,
  };
}
const sendState = g => { send(g.white, stateFor(g.white, g)); send(g.black, stateFor(g.black, g)); };

function startGame(a, b) {
  const [w, bl] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = { id: nextGid++, chess: new Chess(), white: w, black: bl, over: false, result: null, reason: null, last: null };
  for (const p of [a, b]) { p.game = g; p.lastGame = null; }
  // any other pending request involving these two is now void
  for (const c of [...challenges.values()]) {
    if (c.from === a || c.from === b) dropChallenge(c.cid, 'cancelled');
    else if (c.to === a || c.to === b) dropChallenge(c.cid, 'busy');
  }
  sendState(g);
  scheduleBroadcast();
}

function endGame(g, result, reason) {
  if (g.over) return;
  g.over = true; g.result = result; g.reason = reason;
  for (const p of [g.white, g.black]) {
    if (p.game === g) p.game = null;
    p.lastGame = g;
  }
  sendState(g);
  scheduleBroadcast();
}

function move(p, m) {
  const g = p.game;
  if (!g || g.over) return;
  const color = g.white === p ? 'w' : 'b';
  if (g.chess.turn() !== color) return send(p, { t: 'error', msg: 'Not your turn' });
  if (!/^[a-h][1-8]$/.test(m.from) || !/^[a-h][1-8]$/.test(m.to)) return;
  const promotion = /^[qrbn]$/.test(m.promotion) ? m.promotion : undefined;
  let mv;
  try { mv = g.chess.move({ from: m.from, to: m.to, promotion }); }
  catch { return send(p, { t: 'error', msg: 'Illegal move' }); }
  g.last = { from: mv.from, to: mv.to };
  const c = g.chess;
  if (c.isCheckmate()) return endGame(g, color === 'w' ? '1-0' : '0-1', 'checkmate');
  if (c.isStalemate()) return endGame(g, '1/2-1/2', 'stalemate');
  if (c.isInsufficientMaterial()) return endGame(g, '1/2-1/2', 'insufficient material');
  if (c.isThreefoldRepetition()) return endGame(g, '1/2-1/2', 'threefold repetition');
  if (c.isDraw()) return endGame(g, '1/2-1/2', 'fifty-move rule');
  sendState(g);
}

// ---------- connections ----------
function removePlayer(p) {
  players.delete(p.id);
  byToken.delete(p.token);
  scheduleBroadcast();
}

function goOffline(p) {
  p.ws = null;
  for (const c of [...challenges.values()]) {
    if (c.from === p || c.to === p) dropChallenge(c.cid, 'offline');
  }
  if (p.game) {
    const g = p.game;
    sendState(g); // tells the opponent
    p.timer = setTimeout(() => {
      if (!p.ws && p.game === g) endGame(g, g.white === p ? '0-1' : '1-0', 'disconnect');
      if (!p.ws) removePlayer(p);
    }, GRACE_IN_GAME);
  } else {
    p.timer = setTimeout(() => { if (!p.ws) removePlayer(p); }, GRACE_IDLE);
  }
  scheduleBroadcast();
}

module.exports = function start(wss) {
  wss.on('connection', ws => {
    ws.player = null;

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'hello') {
        if (ws.player) return;
        let p = m.token ? byToken.get(String(m.token)) : null;
        if (p) {                                   // resume after refresh / reconnect
          if (p.ws && p.ws !== ws) { const old = p.ws; old.player = null; try { old.close(); } catch {} }
          clearTimeout(p.timer);
          p.ws = ws;
        } else {
          p = { id: nextPlayerId++, token: crypto.randomBytes(12).toString('hex'), name: clean(m.name),
                ws, game: null, lastGame: null, out: null, timer: null };
          players.set(p.id, p);
          byToken.set(p.token, p);
        }
        ws.player = p;
        send(p, { t: 'welcome', id: p.id, name: p.name, token: p.token });
        for (const c of challenges.values()) {
          if (c.to === p) send(p, { t: 'incoming', cid: c.cid, from: { id: c.from.id, name: c.from.name } });
        }
        const g = p.game || p.lastGame;
        if (g) { send(p, stateFor(p, g)); if (p.game) sendState(g); }
        scheduleBroadcast();
        return;
      }

      const p = ws.player;
      if (!p) return;
      switch (m.t) {
        case 'challenge': challenge(p, m.to); break;
        case 'cancel': if (p.out) dropChallenge(p.out, 'cancelled'); break;
        case 'respond': respond(p, m.cid, !!m.accept); break;
        case 'move': move(p, m); break;
        case 'resign':
          if (p.game && !p.game.over) endGame(p.game, p.game.white === p ? '0-1' : '1-0', 'resignation');
          break;
        case 'leave': if (!p.game) p.lastGame = null; break;
      }
    });

    ws.on('close', () => {
      const p = ws.player;
      if (!p || p.ws !== ws) return;
      goOffline(p);
    });
    ws.on('error', () => {});
  });
};
