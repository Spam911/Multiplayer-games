'use strict';
// Storm Royale - authoritative battle royale server.
// server.js calls start(wss) once with this game's WebSocketServer.
//
// Unlike a drop-in-and-queue arena, this runs on explicit rooms: someone
// creates a game, picks how many players it holds, others join that room, and
// whoever is ready launches it. Missing slots are filled with bots, and a match
// ends the moment the last human is eliminated so nobody is ever left watching
// bots grind out a result on their own.
//
// Each room owns its own match state, so several games run at once and a slow
// one never blocks anybody else.

const { reward } = require('../lib/progress');

const CFG = {
  TICK: 30,            // simulation steps per second
  SEND_EVERY: 2,       // snapshot every N ticks (= 15 Hz)
  WORLD: 3200,         // the island is centred in a WORLD x WORLD box
  MIN_LOBBY: 2,        // smallest game anyone can create
  DEFAULT_LOBBY: 8,
  MAX_LOBBY: 12,       // hard ceiling on players in one match
  VIEW_X: 1050,        // area of interest: half-extent around a player
  VIEW_Y: 800,
  SPEED: 200,          // human px/s
  BOT_SPEED: 150,
  MAX_SPLATS: 260,
  SPAWN_GRACE: 5,      // seconds of invulnerability at the start of a match
  IDLE_OUT: 30,        // drop a human whose client has gone quiet for this long
  RESULTS_MS: 12000,   // how long the final standings stay up
  LIST_EVERY: 1500,    // room-list refresh cadence for idle clients
};

// Weapons. len/x0 are muzzle offset, spr is spread, pel is pellets per shot.
const WP = [
  { n: 'Pistol', g: 'P', len: 30, x0: 10, c: '#9ca3af', d: 14, rate: .35, spd: 950, rng: 620, spr: .04, pel: 1 },
  { n: 'Assault Rifle', g: 'R', len: 46, x0: 2, c: '#3b82f6', d: 11, rate: .11, spd: 1050, rng: 720, spr: .06, pel: 1 },
  { n: 'Shotgun', g: 'G', len: 49, x0: 2, c: '#f97316', d: 10, rate: .85, spd: 900, rng: 380, spr: .2, pel: 6 },
  { n: 'Sniper', g: 'N', len: 59, x0: 0, c: '#a855f7', d: 75, rate: 1.3, spd: 1900, rng: 1300, spr: .004, pel: 1 },
];
// Bot weapon preference: a bot only bothers to pick up a gun that outranks its own.
const RK = [0, 3, 2, 1];
// Storm phases: hold still, then shrink to r. dps is damage per second outside.
const PH = [
  { r: 1500, hold: 18, shr: 20, dps: 1 },
  { r: 950, hold: 16, shr: 16, dps: 2 },
  { r: 550, hold: 14, shr: 14, dps: 4 },
  { r: 280, hold: 12, shr: 12, dps: 6 },
  { r: 100, hold: 10, shr: 10, dps: 9 },
  { r: 0, hold: 4, shr: 8, dps: 12 },
];
const BOT_NAMES = 'Rex Nova Blaze Ghost Pixel Viper Echo Zed Mav Luna Atlas Fang Jinx Riot Sage Onyx Drift Kilo Moxie Pyro Quill Rook Tango Wraith'.split(' ');
const COLS = ['#ef4444', '#f97316', '#a3e635', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#e5e7eb'];

const W = CFG.WORLD;
const DT = 1 / CFG.TICK;
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ad = (t, a) => ((t - a + Math.PI * 3) % TAU) - Math.PI;
const colIdx = c => { const i = COLS.indexOf(c); return i < 0 ? 0 : i; };

// ---------- island ----------
// A wobbly radial island: one radius function sampled at several angles,
// reused for every layer of the beach -> grass ring stack.
const isL = a => 1330 + 90 * Math.sin(3 * a + 1.3) + 55 * Math.sin(5 * a + .4)
  + 40 * Math.sin(7 * a + 2.1) + 22 * Math.sin(11 * a + .9);
const inIsl = (x, y, m) => {
  const dx = x - 1600, dy = y - 1600;
  return Math.hypot(dx, dy) < isL(Math.atan2(dy, dx)) - m;
};
// Clamp a point so it stays m px inside the shoreline.
const toIsl = (x, y, m) => {
  const dx = x - 1600, dy = y - 1600, d = Math.hypot(dx, dy) || 1;
  const l = isL(Math.atan2(dy, dx)) - m;
  return d <= l ? [x, y] : [1600 + dx / d * l, 1600 + dy / d * l];
};
const islPt = m => {
  const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * (isL(a) - m);
  return [1600 + Math.cos(a) * r, 1600 + Math.sin(a) * r];
};
const ISN = 150;
const isPts = (off, wob) => {
  const a = [];
  for (let i = 0; i < ISN; i++) {
    const t = i / ISN * TAU;
    const r = isL(t) + off + (wob ? wob * Math.sin(9 * t + 2) + wob * .6 * Math.sin(15 * t + 1) : 0);
    a.push([Math.round(1600 + Math.cos(t) * r), Math.round(1600 + Math.sin(t) * r)]);
  }
  return a;
};
// The shoreline is fixed geometry, not world generation, so it is published
// once at boot. Clients draw it as the backdrop behind the menus, which means
// there is an island to look at even before any match has been created.
const BACKDROP = isPts(120);

// ---------- ray casts (shared with the bullet sweep) ----------
function segRect(x1, y1, x2, y2, w) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q, mn, mx] of [[x1, dx, w.x, w.x + w.w], [y1, dy, w.y, w.y + w.h]]) {
    if (Math.abs(q) < 1e-9) { if (p < mn || p > mx) return Infinity; }
    else {
      let a = (mn - p) / q, b = (mx - p) / q;
      if (a > b) { const t = a; a = b; b = t; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}
function segCirc(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1, fx = x1 - cx, fy = y1 - cy;
  const a = dx * dx + dy * dy, c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  if (a < 1e-9) return Infinity;
  const bq = fx * dx + fy * dy, disc = bq * bq - a * c;
  if (disc < 0) return Infinity;
  const t = (-bq - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : Infinity;
}

// ---------- state ----------
let nextEntId = 1;
let nextRoomId = 1;
let nextMemberId = 1;
const rooms = new Map();   // roomId -> room
const sockets = new Set(); // every live connection

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// ---------- world generation ----------
function randLoot(x, y, good) {
  if (Math.random() < (good ? .7 : .4)) {
    const q = Math.random();
    return { x: Math.round(x), y: Math.round(y), k: 'w', i: q < .45 ? 1 : q < .75 ? 2 : 3 };
  }
  const q = Math.random();
  return { x: Math.round(x), y: Math.round(y), k: q < .4 ? 'h' : q < .75 ? 's' : 'o', i: 0 };
}

function genWorld() {
  const houses = [], permWalls = [], trees = [], bushes = [], loot = [];

  // Hubs: a hollow box with two door gaps, always fully on the island.
  for (let i = 0; i < 14; i++) {
    const w = 170, h = 140, t = 14;
    let x, y, n = 0;
    do {
      x = rnd(250, W - 450); y = rnd(250, W - 400); n++;
    } while (n < 400 && (houses.some(o => x < o[0] + o[2] + 60 && x + w + 60 > o[0]
      && y < o[1] + o[3] + 60 && y + h + 60 > o[1])
      || ![[x, y], [x + w, y], [x, y + h], [x + w, y + h]].every(q => inIsl(q[0], q[1], 260))));
    if (n >= 400) continue;
    houses.push([Math.round(x), Math.round(y), w, h]);
    permWalls.push({ x, y, w, h: t }, { x, y, w: t, h }, { x: x + w - t, y, w: t, h });
    permWalls.push({ x, y: y + h - t, w: 60, h: t }, { x: x + 110, y: y + h - t, w: 60, h: t });
    loot.push({ x: Math.round(x + 85), y: Math.round(y + 70), k: 'c', i: 0 });
    loot.push(randLoot(x + 40, y + 50, 1));
  }
  // Trees are the main cover. Sample generously: at human lobby sizes the
  // island reads emptier than it did against a screen full of bots.
  for (let i = 0; i < 520; i++) {
    const x = rnd(60, W - 60), y = rnd(60, W - 60);
    if (inIsl(x, y, 170) && !houses.some(h => x > h[0] - 50 && x < h[0] + h[2] + 50 && y > h[1] - 50 && y < h[1] + h[3] + 50))
      trees.push([Math.round(x), Math.round(y), Math.round(rnd(18, 28))]);
  }
  // Shared "is this spot free" test for loot and bushes.
  const free = (x, y, m, r) => inIsl(x, y, m)
    && !houses.some(h => x > h[0] - r - 30 && x < h[0] + h[2] + r + 30 && y > h[1] - r - 30 && y < h[1] + h[3] + r + 30)
    && !trees.some(t => (x - t[0]) ** 2 + (y - t[1]) ** 2 < (t[2] + r + 6) ** 2)
    && !loot.some(k => (x - k.x) ** 2 + (y - k.y) ** 2 < (r + 20) ** 2);
  const scatter = (n, margin) => {
    for (let i = 0; i < n; i++) {
      let x, y, k = 0;
      do { x = rnd(margin, W - margin); y = rnd(margin, W - margin); k++; } while (k < 150 && !free(x, y, 130, 0));
      loot.push(randLoot(x, y, 0));
    }
  };
  scatter(55, 80);
  for (let i = 0; i < 10; i++) {
    let x, y, k = 0;
    do { x = rnd(100, W - 100); y = rnd(100, W - 100); k++; } while (k < 150 && !free(x, y, 130, 0));
    loot.push({ x: Math.round(x), y: Math.round(y), k: 'c', i: 0 });
  }
  // Bush blobs go out as offsets into a small palette; the client rebuilds the
  // canopy from them.
  for (let i = 0; i < 46; i++) {
    const [cx, cy] = islPt(190);
    const groups = 2 + Math.floor(Math.random() * 3);
    for (let n = 0; n < groups; n++) {
      const x = cx + rnd(-55, 55), y = cy + rnd(-55, 55), r = rnd(34, 48);
      if (!free(x, y, 170, r)) continue;
      const bl = [];
      for (let m = 0; m < 8; m++) {
        const a = rnd(0, TAU), d = rnd(0, r * .55);
        bl.push([Math.round(Math.cos(a) * d), Math.round(Math.sin(a) * d), Math.round(r * .4 + rnd(0, r * .22)), m % 4]);
      }
      for (let m = 0; m < 3; m++) {
        const a = rnd(0, TAU), d = rnd(0, r * .7);
        bl.push([Math.round(Math.cos(a) * d), Math.round(Math.sin(a) * d), 2.4, 4]);
      }
      bushes.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r), bl });
    }
  }
  const waves = Array.from({ length: 110 }, () => {
    let x, y;
    do { x = rnd(-300, 3500); y = rnd(-300, 3500); } while (Math.hypot(x - 1600, y - 1600) < 1760);
    return [Math.round(x), Math.round(y), +rnd(0, TAU).toFixed(2)];
  });

  return {
    isl: { sh: [isPts(190), isPts(110), isPts(45)], wet: isPts(0), dry: isPts(-16), edge: isPts(-135, 16), grass: isPts(-165, 22) },
    trees, houses, bushes, waves, permWalls, loot,
  };
}

// ---------- entities ----------
function mkPlayer(name, col, bot, ws) {
  return {
    id: nextEntId++, name, col, bot, ws,
    x: 0, y: 0, ang: 0, r: 14,
    hp: 100, sh: 0, wood: 30, wp: 0, inv: [true, false, false, false],
    alive: true, k: 0, rc: 0, rcg: 0, inb: null,
    cd: 0, hit: 0, rv: 0, bcd: 0,
    mx: 0, my: 0, aim: 0, fire: false, wantBuild: false, wantSwap: false, lastIn: 0,
    // bot scratch
    t: 0, det: 0, gx: 0, gy: 0, sg: 1, lx: 0, ly: 0, en: null, brk: null, brkT: 0, sd: 1,
    skill: bot ? rnd(.6, 1.2) : 1,
  };
}

function push(g, e) {
  for (const t of g.trees) {
    const dx = e.x - t[0], dy = e.y - t[1], m = e.r + t[2], d = Math.hypot(dx, dy);
    if (d < m && d > 0) { e.x = t[0] + dx / d * m; e.y = t[1] + dy / d * m; }
  }
  for (const w of g.permWalls) e = pushOutBox(e, w);
  for (const w of g.walls) e = pushOutBox(e, w);
  e.x = clamp(e.x, e.r, W - e.r);
  e.y = clamp(e.y, e.r, W - e.r);
  const dx = e.x - 1600, dy = e.y - 1600, d = Math.hypot(dx, dy);
  const l = isL(Math.atan2(dy, dx)) - e.r - 20;
  if (d > l && d > 0) { e.x = 1600 + dx / d * l; e.y = 1600 + dy / d * l; }
  return e;
}
function pushOutBox(e, w) {
  const qx = clamp(e.x, w.x, w.x + w.w), qy = clamp(e.y, w.y, w.y + w.h);
  const dx = e.x - qx, dy = e.y - qy, d = Math.hypot(dx, dy);
  if (d >= e.r) return e;
  if (d <= 0) { e.x += e.r * 2; return e; }
  e.x = qx + dx / d * e.r;
  e.y = qy + dy / d * e.r;
  return e;
}

// Can `viewer` see `target` at all? Somebody tucked in a bush is withheld from
// everyone else's snapshot, so the client cannot cheat by reading coordinates.
function visibleTo(viewer, q) {
  if (!q.alive) return false;
  if (q === viewer) return true;
  if (!q.inb) return true;
  if (q.rv > 0) return true;
  if (viewer.inb && viewer.inb === q.inb) return true;
  return Math.hypot(viewer.x - q.x, viewer.y - q.y) < 75;
}

function addSplat(g, x, y, c) {
  g.splats.push({ id: nextEntId++, x: Math.round(x), y: Math.round(y), r: rnd(6, 12), c, s: Math.floor(rnd(0, 9999)) });
  if (g.splats.length > CFG.MAX_SPLATS) g.splats.shift();
}
function spillLoot(g, x, y, items) {
  for (const k of items) {
    const a = rnd(0, TAU), d = rnd(18, 42);
    g.loot.push({ x: Math.round(x + Math.cos(a) * d), y: Math.round(y + Math.sin(a) * d), k: k.k, i: k.i, n: k.n || 0 });
  }
}

// ---------- rooms ----------
function roomList() {
  const out = [];
  for (const r of rooms.values()) {
    out.push({
      id: r.id, max: r.max, n: r.members.length, status: r.status,
      host: (r.members[0] || {}).name || '?', hostId: r.hostId,
    });
  }
  return out.sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === 'waiting' ? -1 : 1));
}
function pushList() {
  const list = roomList();
  const online = sockets.size;
  // `shore` rides along with the list so a client that has never played a match
  // still has an island to draw behind the menus.
  for (const ws of sockets) send(ws, { t: 'list', list, online, shore: BACKDROP });
}
function pushRoom(r) {
  for (const m of r.members) {
    send(m.ws, {
      t: 'room',
      id: r.id,
      max: r.max,
      status: r.status,
      hostId: r.hostId,
      you: m.id,
      members: r.members.map(x => ({ id: x.id, n: x.name, c: x.col })),
    });
  }
}
function roomOf(ws) { return ws.stormRoom ? rooms.get(ws.stormRoom) : null; }

function joinRoom(ws, room) {
  ws.stormRoom = room.id;
  ws.stormMember = nextMemberId++;
  room.members.push({ id: ws.stormMember, ws, name: ws.stormName, col: ws.stormCol });
  if (room.members.length === 1) room.hostId = ws.stormMember;
  pushRoom(room);
  pushList();
  send(ws, {
    t: 'entered',
    account: ws.account ? { name: ws.account.name, level: ws.account.level } : null,
  });
}
function leaveRoom(ws, silent) {
  const room = roomOf(ws);
  if (!room) return;
  const i = room.members.findIndex(m => m.ws === ws);
  ws.stormRoom = null;
  ws.stormMember = null;
  if (i < 0) return;
  const wasHost = room.hostId === room.members[i].id;
  room.members.splice(i, 1);
  if (!room.members.length) { rooms.delete(room.id); if (!silent) pushList(); return; }
  // Hand the host role on so a disconnect never orphans a room.
  if (wasHost || !room.members.some(m => m.id === room.hostId)) room.hostId = room.members[0].id;
  if (room.status === 'live') {
    // Walking out of a live match takes your body out of the game with you.
    const p = ws.stormPlayer;
    if (p && room.game) {
      p.ws = null;
      if (p.alive) kill(room.game, p, null);
    }
  } else {
    pushRoom(room);
  }
  if (!silent) pushList();
}

function createRoom(ws, max) {
  const room = {
    id: nextRoomId++,
    max: clamp(+max || CFG.DEFAULT_LOBBY, CFG.MIN_LOBBY, CFG.MAX_LOBBY),
    members: [],
    hostId: 0,
    status: 'waiting',
    game: null,
  };
  rooms.set(room.id, room);
  joinRoom(ws, room);
}

// Join the oldest room that still has space and is not mid-match; otherwise
// open a new one. This is the "just play" button.
function quickJoin(ws) {
  for (const r of roomList()) {
    if (r.status === 'waiting' && r.n < r.max) {
      const room = rooms.get(r.id);
      joinRoom(ws, room);
      return;
    }
  }
  createRoom(ws, CFG.DEFAULT_LOBBY);
}

// ---------- match lifecycle ----------
function startGame(room) {
  if (room.status !== 'waiting' || !room.members.length) return;
  const w = genWorld();
  const g = {
    ...w,
    t: 0, tick: 0,
    players: [], walls: [], bullets: [], splats: [],
    feed: [], events: [], byView: new Map(),
    storm: { x: W / 2, y: W / 2, r: 2300, ph: 0, t: 0, sh: false, ox: 0, oy: 0, or: 0, tx: 0, ty: 0, tr: 0 },
    over: false, winner: null, resultsT: 0,
    roster: new Map(),
  };
  room.game = g;
  room.status = 'live';

  for (const m of room.members) {
    const p = mkPlayer(m.name, m.col, false, m.ws);
    g.players.push(p);
    g.byView.set(m.ws, p);
    m.ws.stormPlayer = p;
    m.player = p;
  }
  // Bots fill whatever nobody claimed.
  while (g.players.length < room.max) {
    g.players.push(mkPlayer(
      BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
      COLS[Math.floor(Math.random() * COLS.length)], true, null));
  }
  for (const p of g.players) {
    g.roster.set(p.id, { id: p.id, name: p.name, col: p.col, bot: p.bot ? 1 : 0 });
    [p.x, p.y] = islPt(200);
  }
  // Re-roll anyone who landed on top of somebody so nobody spawns face-to-face.
  for (let pass = 0; pass < 14; pass++) {
    for (const p of g.players) {
      if (!g.players.some(q => q !== p && Math.hypot(q.x - p.x, q.y - p.y) < 300)) continue;
      [p.x, p.y] = islPt(200);
    }
  }
  for (const p of g.players) push(g, p);
  nextStormPhase(g);

  const world = publicWorld(g);
  pushRoom(room);
  for (const p of g.players) if (p.ws) send(p.ws, { t: 'world', mid: room.id, world, you: p.id });
  pushRoster(g);
  for (const p of g.players) if (p.ws) send(p.ws, { t: 'start', humans: g.players.filter(q => !q.bot).length });
  pushList();
}

function humansAlive(g) { let n = 0; for (const p of g.players) if (!p.bot && p.alive) n++; return n; }

// Final standings: still standing first, then kills. Every seat gets a place so
// a human who came 7th sees "7th" even when it is off the visible board.
function standings(g) {
  const order = g.players.slice().sort((a, b) =>
    (b.alive - a.alive) || (b.k - a.k) || a.id - b.id);
  const places = new Map();
  order.forEach((p, i) => places.set(p.id, i + 1));
  return { order, places };
}

function endGame(g) {
  if (g.over) return;
  g.over = true;
  g.resultsT = CFG.RESULTS_MS;
  const { order, places } = standings(g);
  // The winner has to be whoever tops the standings. When the round is cut
  // short because the last human was eliminated there can be several bots
  // still standing, and picking the first one we happen to find would name a
  // winner the leaderboard itself does not rank first.
  g.winner = order.length ? order[0] : null;
  const board = order.map(p => ({
    n: p.name, k: p.k, a: p.alive ? 1 : 0, b: p.bot ? 1 : 0, i: p.id, place: places.get(p.id),
  }));
  for (const p of g.players) {
    if (!p.ws) continue;
    // Only validated accounts earn anything; guests just play.
    const got = reward(p.ws.account, 'storm', {
      kills: p.k, place: places.get(p.id), alive: p.alive, plays: 1,
    });
    send(p.ws, {
      t: 'results',
      won: g.winner === p,
      winner: g.winner ? g.winner.name : null,
      kills: p.k,
      place: places.get(p.id),
      total: g.players.length,
      leaderboard: board,
      ...(got ? { reward: got } : {}),
    });
  }
}

// ---------- storm ----------
function nextStormPhase(g) {
  const S = g.storm, p = PH[S.ph];
  S.ox = S.x; S.oy = S.y; S.or = S.r; S.tr = p.r;
  let tx = S.x, ty = S.y, tn = 0;
  const margin = Math.min(p.r * .5, 250);
  do {
    const a = rnd(0, TAU), d = rnd(0, Math.max(0, S.r - p.r)) * .9;
    tx = S.x + Math.cos(a) * d; ty = S.y + Math.sin(a) * d; tn++;
  } while (tn < 30 && !inIsl(tx, ty, margin));
  if (tn >= 30) { const q = toIsl(tx, ty, margin); tx = q[0]; ty = q[1]; }
  S.tx = tx; S.ty = ty; S.sh = false; S.t = 0;
}

function stormUp(g, dt) {
  const S = g.storm, p = PH[S.ph];
  S.t += dt;
  if (!S.sh) {
    if (S.t >= p.hold) { S.sh = true; S.t = 0; g.events.push({ e: 3 }); }
    return;
  }
  const k = Math.min(1, S.t / p.shr);
  S.x = S.ox + (S.tx - S.ox) * k;
  S.y = S.oy + (S.ty - S.oy) * k;
  S.r = S.or + (S.tr - S.or) * k;
  if (k >= 1 && S.ph < PH.length - 1) { S.ph++; nextStormPhase(g); }
}

// ---------- combat ----------
// The destructible wall the bot is trying to break, if any is in the way.
function wallOn(g, x1, y1, x2, y2) {
  let best = null, bt = Infinity;
  for (const w of g.walls) { const t = segRect(x1, y1, x2, y2, w); if (t < bt) { bt = t; best = w; } }
  return best;
}
// Cheap line-of-sight for bot targeting; ignores wooden cover.
function blocked(g, x1, y1, x2, y2) {
  const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 12);
  for (let i = 1; i < n; i++) {
    const x = x1 + (x2 - x1) * i / n, y = y1 + (y2 - y1) * i / n;
    for (const t of g.trees) if ((x - t[0]) ** 2 + (y - t[1]) ** 2 < t[2] * t[2]) return true;
    for (const w of g.permWalls) if (x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h) return true;
  }
  return false;
}

function shoot(g, p) {
  const w = WP[p.wp];
  p.cd = w.rate; p.rc = 1;
  g.events.push({ e: 0, w: p.wp, x: Math.round(p.x), y: Math.round(p.y), m: g.byView.get(p.ws) === p ? 1 : 0 });

  // Stop the barrel at the first thing it touches. Wooden cover is the only
  // thing that takes damage from the barrel trace itself.
  const tx = p.x + Math.cos(p.ang) * w.len, ty = p.y + Math.sin(p.ang) * w.len;
  let bt = Infinity, obj = null, wood = false;
  for (const list of [g.permWalls, g.walls]) {
    for (const q of list) { const t = segRect(p.x, p.y, tx, ty, q); if (t < bt) { bt = t; obj = q; wood = q.hp !== undefined; } }
  }
  for (const q of g.trees) { const t = segCirc(p.x, p.y, tx, ty, q[0], q[1], q[2]); if (t < bt) { bt = t; obj = q; wood = false; } }
  if (obj) {
    if (wood) obj.hp -= w.d * w.pel;
    g.events.push({ e: wood ? 7 : 6, x: Math.round(p.x + (tx - p.x) * bt), y: Math.round(p.y + (ty - p.y) * bt) });
    return;
  }
  for (let i = 0; i < w.pel; i++) {
    const a = p.ang + (Math.random() - .5) * 2 * (w.spr + (p.bot ? .06 / p.skill : 0));
    g.bullets.push({
      id: nextEntId++, x: p.x + Math.cos(a) * 18, y: p.y + Math.sin(a) * 18,
      vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd, d: w.d, l: w.rng / w.spd, o: p,
    });
  }
}

function build(g, p) {
  if (p.wood < 10 || !p.alive) return false;
  const a = p.ang, bx = p.x + Math.cos(a) * 46, by = p.y + Math.sin(a) * 46;
  const horiz = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
  const w = horiz ? 14 : 90, h = horiz ? 90 : 14;
  g.walls.push({ id: nextEntId++, x: bx - w / 2, y: by - h / 2, w, h, hp: 150, mh: 150 });
  p.wood -= 10;
  g.events.push({ e: 5 });
  return true;
}

function wants(p, k) {
  if (k.k === 'c') return true;
  if (k.k === 'w') return p.bot ? RK[k.i] > RK[p.wp] : !p.inv[k.i];
  if (k.k === 'h') return p.hp < 100;
  if (k.k === 's') return p.sh < 100;
  return p.wood < (k.n ? 99 : 70);
}

function cycle(g, p) {
  for (let j = 1; j < WP.length; j++) {
    const i = (p.wp + j) % WP.length;
    if (p.inv[i]) { p.wp = i; p.cd = Math.max(p.cd, .25); g.events.push({ e: 4, i }); return true; }
  }
  return false;
}

// ---------- bot AI ----------
function botThink(g, b) {
  let best = null, bd = 650;
  for (const q of g.players) {
    if (q === b || !q.alive) continue;
    const d = Math.hypot(q.x - b.x, q.y - b.y);
    if (d < bd && (!q.inb || q.rv > 0 || d < 110 || q.inb === b.inb) && !blocked(g, b.x, b.y, q.x, q.y)) { best = q; bd = d; }
  }
  b.en = best;
  if (!best && !b.brk) {
    let hd = 450, hw = null;
    for (const q of g.players) {
      if (q === b || !q.alive || (q.inb && q.rv <= 0 && q.inb !== b.inb)) continue;
      const d = Math.hypot(q.x - b.x, q.y - b.y);
      if (d < hd && !blocked(g, b.x, b.y, q.x, q.y)) { const w = wallOn(g, b.x, b.y, q.x, q.y); if (w) { hd = d; hw = w; } }
    }
    if (hw) { b.brk = hw; b.brkT = 4; }
  }
  // If we barely moved last tick and we have nothing to shoot, sidestep.
  const stuck = Math.hypot(b.x - b.lx, b.y - b.ly) < 10 && !best;
  b.lx = b.x; b.ly = b.y;
  if (stuck) {
    const a = rnd(0, TAU);
    b.gx = clamp(b.x + Math.cos(a) * 300, 100, W - 100);
    b.gy = clamp(b.y + Math.sin(a) * 300, 100, W - 100);
    b.det = 1.3; return;
  }
  if (b.det > 0) return;
  const S = g.storm;
  // Always prefer standing inside the next circle over chasing or looting.
  if (Math.hypot(b.x - S.tx, b.y - S.ty) > S.tr * .85 + 40) {
    b.gx = S.tx + rnd(-1, 1) * S.tr * .5; b.gy = S.ty + rnd(-1, 1) * S.tr * .5; return;
  }
  if (best) { if (Math.random() < .35) b.sg = -b.sg; return; }
  let n = null, nd = 550;
  for (const k of g.loot) {
    if (!wants(b, k)) continue;
    const d = Math.hypot(k.x - b.x, k.y - b.y);
    if (d < nd) { n = k; nd = d; }
  }
  if (n) { b.gx = n.x; b.gy = n.y; }
  else if (Math.hypot(b.gx - b.x, b.gy - b.y) < 40) {
    const a = rnd(0, TAU), d = rnd(200, 600);
    b.gx = clamp(b.x + Math.cos(a) * d, 100, W - 100);
    b.gy = clamp(b.y + Math.sin(a) * d, 100, W - 100);
    if (Math.hypot(b.gx - S.tx, b.gy - S.ty) > S.tr * .85) { b.gx = S.tx; b.gy = S.ty; }
  }
}

// Pick a heading that is actually walkable instead of grinding into geometry.
function steer(g, b, want) {
  const clear = (a, len) => {
    const x = b.x + Math.cos(a) * len, y = b.y + Math.sin(a) * len;
    for (const t of g.trees) if ((x - t[0]) ** 2 + (y - t[1]) ** 2 < (t[2] + b.r) ** 2) return false;
    for (const w of g.permWalls) if (x > w.x - b.r && x < w.x + w.w + b.r && y > w.y - b.r && y < w.y + w.h + b.r) return false;
    return true;
  };
  const L = Math.min(90, Math.hypot(want.x - b.x, want.y - b.y));
  if (clear(want, L)) return want;
  const s = b.sd || (b.sd = Math.random() < .5 ? 1 : -1);
  for (const o of [.6, 1.2, 1.9, 2.6]) for (const q of [s, -s]) { const a = want + o * q; if (clear(a, 90)) return a; }
  return want;
}

function botUp(g, b, dt) {
  b.t -= dt; b.det -= dt;
  if (b.t <= 0) {
    b.t = rnd(.35, .6);
    botThink(g, b);
    const q = toIsl(b.gx, b.gy, 140);
    b.gx = q[0]; b.gy = q[1];
  }
  const e = b.en && b.en.alive ? b.en : null;
  let mx = 0, my = 0;
  if (e) {
    const ex = e.x - b.x, ey = e.y - b.y, ed = Math.hypot(ex, ey) || 1;
    const w = WP[b.wp], ideal = w.rng * .55;
    const ta = Math.atan2(ey, ex), da = ad(ta, b.ang);
    b.ang += clamp(da, -3.2 * dt * b.skill, 3.2 * dt * b.skill);
    const f = ed > ideal ? 1 : ed < ideal * .5 ? -1 : 0;   // hold the ideal range
    mx = ex / ed * f - ey / ed * b.sg * .8;                // and strafe around it
    my = ey / ed * f + ex / ed * b.sg * .8;
    if (Math.abs(da) < .12 && ed < w.rng * .95 && b.cd <= 0) shoot(g, b);
    if (b.hit > 0 && b.wood >= 10 && b.bcd <= 0 && Math.random() < dt * 2) {
      const o = b.ang; b.ang = ta; build(g, b); b.ang = o; b.bcd = 3;
    }
  } else {
    if (b.brk && (b.brk.hp <= 0 || (b.brkT -= dt) <= 0 || !g.walls.includes(b.brk))) b.brk = null;
    const dx = b.gx - b.x, dy = b.gy - b.y, d = Math.hypot(dx, dy);
    if (d > 20) {
      const a = steer(g, b, Math.atan2(dy, dx));
      mx = Math.cos(a); my = Math.sin(a);
      b.ang += clamp(ad(a, b.ang), -4 * dt, 4 * dt);
      if (!b.brk) {
        const w = wallOn(g, b.x, b.y, b.x + mx * (b.r + 30), b.y + my * (b.r + 30));
        if (w) { b.brk = w; b.brkT = 4; }
      }
    }
    if (b.brk) {
      const w = b.brk;
      const ta = Math.atan2(w.y + w.h / 2 - b.y, w.x + w.w / 2 - b.x), da = ad(ta, b.ang);
      b.ang += clamp(da, -6 * dt, 6 * dt);
      mx = my = 0;
      if (Math.abs(da) < .15 && b.cd <= 0) shoot(g, b);
    }
  }
  const m = Math.hypot(mx, my);
  if (m > 0) { b.x += mx / m * CFG.BOT_SPEED * dt; b.y += my / m * CFG.BOT_SPEED * dt; }
}

// ---------- simulation ----------
function kill(g, p, by) {
  if (!p.alive) return;
  p.alive = false;
  if (by) by.k++;
  g.events.push({ e: 8, x: Math.round(p.x), y: Math.round(p.y) });
  for (let i = 0; i < 3; i++) addSplat(g, p.x + rnd(-18, 18), p.y + rnd(-18, 18), colIdx(p.col));
  spillLoot(g, p.x, p.y, [randLoot(0, 0, 0), { k: Math.random() < .5 ? 'h' : 's', i: 0 }, { k: 'o', i: 0 }]);
  if (p.wp > 0) spillLoot(g, p.x, p.y, [{ k: 'w', i: p.wp }]);
  g.feed.unshift((by ? by.name : 'The Storm') + ' eliminated ' + p.name);

  if (p.ws) {
    const { places } = standings(g);
    send(p.ws, {
      t: 'dead',
      place: places.get(p.id),
      total: g.players.length,
      kills: p.k,
      by: by ? by.name : 'The Storm',
      humansLeft: humansAlive(g),
    });
  }
  // Finish the match when a single player is left, or - the important case for
  // this mode - the moment every human is out and it would be bots alone.
  const alive = g.players.filter(q => q.alive).length;
  if (alive <= 1 || humansAlive(g) === 0) endGame(g);
}

function hit(g, p, dmg, by) {
  if (g.t < CFG.SPAWN_GRACE) return;
  p.hit = 1.5; p.rv = 1.5;
  if (by) by.rv = Math.max(by.rv, 1.5);
  // Events are tagged for whoever they belong to; every client only reacts to
  // the ones that concern it.
  g.events.push({ e: 1, to: p.id, at: [Math.round(p.x), Math.round(p.y)] });
  if (by) g.events.push({ e: 2, by: by.id, at: [Math.round(p.x), Math.round(p.y)], d: Math.round(dmg) });
  let d = dmg;
  if (p.sh > 0) { const a = Math.min(p.sh, d); p.sh -= a; d -= a; }
  p.hp -= d;
  if (p.ws) g.events.push({ e: 13, x: Math.round(p.x), y: Math.round(p.y) });
  if (p.hp <= 0) kill(g, p, by);
}

function step(g) {
  g.t += DT;
  const S = g.storm;

  for (const p of g.players) {
    if (!p.alive) continue;
    p.cd -= DT; p.hit -= DT; p.rv -= DT; p.bcd -= DT;
    p.rc = Math.max(0, p.rc - DT * 9);

    if (p.bot) {
      botUp(g, p, DT);
    } else {
      // Input arrived over the wire: consume each edge exactly once.
      if (p.wantSwap) { cycle(g, p); p.wantSwap = false; }
      if (p.wantBuild) { if (p.bcd <= 0 && build(g, p)) p.bcd = .25; p.wantBuild = false; }
      p.ang = p.aim;
      const m = Math.hypot(p.mx, p.my);
      p.x += (m > 1 ? p.mx / m : p.mx) * CFG.SPEED * DT;
      p.y += (m > 1 ? p.my / m : p.my) * CFG.SPEED * DT;
      if (p.fire && p.cd <= 0) shoot(g, p);
    }
    push(g, p);

    p.inb = null;
    for (const bu of g.bushes) if ((p.x - bu.x) ** 2 + (p.y - bu.y) ** 2 < bu.r * bu.r) { p.inb = bu; break; }
    if ((p.rcg += DT) > 2) { p.rcg = 0; if (p.wood < 30) p.wood++; }   // slow wood trickle

    if (Math.hypot(p.x - S.x, p.y - S.y) > S.r) {
      p.hp -= PH[S.ph].dps * DT;
      if (p.hp <= 0) kill(g, p, null);
    }
  }

  // A human whose client has stopped talking - a tab in the background, a
  // laptop asleep - leaves a body standing in the island forever, and since a
  // match only ends once every human is out, that one idle player would hold
  // the whole round open. Take them out instead.
  for (const p of g.players) {
    if (!p.alive || p.bot || g.t - p.lastIn <= CFG.IDLE_OUT) continue;
    g.feed.unshift(p.name + ' went idle and was removed');
    kill(g, p, null);
  }

  for (let i = g.loot.length - 1; i >= 0; i--) {
    const k = g.loot[i];
    for (const p of g.players) {
      if (!p.alive || !wants(p, k)) continue;
      if (Math.abs(k.x - p.x) > 26 || Math.abs(k.y - p.y) > 26) continue;
      g.loot.splice(i, 1);
      g.events.push({ e: 9, to: p.id, k: k.k });
      if (k.k === 'c') spillLoot(g, k.x, k.y, [randLoot(0, 0, 1), randLoot(0, 0, 1), randLoot(0, 0, 0)]);
      else if (k.k === 'w') { p.wp = k.i; p.inv[k.i] = true; g.events.push({ e: 11, to: p.id, i: k.i }); }
      else if (k.k === 'h') p.hp = Math.min(100, p.hp + 40);
      else if (k.k === 's') p.sh = Math.min(100, p.sh + 35);
      else p.wood = Math.min(99, p.wood + (k.n || 25));
      break;
    }
  }

  for (let i = g.bullets.length - 1; i >= 0; i--) {
    const b = g.bullets[i];
    const x0 = b.x, y0 = b.y, x1 = x0 + b.vx * DT, y1 = y0 + b.vy * DT;
    let bt = Infinity, kind = 0, obj = null;
    for (const p of g.players) {
      if (!p.alive || p === b.o) continue;
      const t = segCirc(x0, y0, x1, y1, p.x, p.y, p.r + 3);
      if (t < bt) { bt = t; kind = 1; obj = p; }
    }
    for (const list of [g.permWalls, g.walls]) {
      for (const w of list) { const t = segRect(x0, y0, x1, y1, w); if (t < bt) { bt = t; kind = 2; obj = w; } }
    }
    for (const t of g.trees) { const c = segCirc(x0, y0, x1, y1, t[0], t[1], t[2]); if (c < bt) { bt = c; kind = 3; } }

    if (kind) {
      b.x = x0 + (x1 - x0) * bt; b.y = y0 + (y1 - y0) * bt;
      b.l = 0;
      if (kind === 1) hit(g, obj, b.d, b.o);
      else if (kind === 2 && obj.hp !== undefined) { obj.hp -= b.d; g.events.push({ e: 7, x: Math.round(b.x), y: Math.round(b.y) }); }
      else if (kind === 3) b.o.wood = Math.min(99, b.o.wood + (b.o.wood < 99 ? 1 : 0));
    } else { b.x = x1; b.y = y1; b.l -= DT; }
    if (b.l <= 0) g.bullets.splice(i, 1);
  }

  for (let i = g.walls.length - 1; i >= 0; i--) {
    const w = g.walls[i];
    if (w.hp > 0) continue;
    g.events.push({ e: 12, x: Math.round(w.x + w.w / 2), y: Math.round(w.y + w.h / 2) });
    g.loot.push({ x: Math.round(w.x + w.w / 2), y: Math.round(w.y + w.h / 2), k: 'o', i: 0, n: 10 });
    g.walls.splice(i, 1);
  }

  stormUp(g, DT);

  if (++g.tick % CFG.SEND_EVERY === 0) sendSnapshots(g);
}

// ---------- snapshots ----------
function publicWorld(g) {
  return {
    isl: g.isl, trees: g.trees, houses: g.houses, bushes: g.bushes, waves: g.waves,
    // Static walls go out as tight arrays; they never change during a match.
    pw: g.permWalls.map(w => [Math.round(w.x), Math.round(w.y), w.w, w.h]),
    // Weapon display data + muzzle geometry, so the client never has to guess.
    wp: WP.map(w => ({ n: w.n, g: w.g, c: w.c, len: w.len, x0: w.x0 })),
    ph: PH.map(p => ({ hold: p.hold, shr: p.shr })),
  };
}

function pushRoster(g) {
  const list = [...g.roster.values()];
  for (const p of g.players) if (p.ws) send(p.ws, { t: 'roster', list });
}

function sendSnapshots(g) {
  const S = g.storm;
  let alive = 0;
  for (const p of g.players) if (p.alive) alive++;
  for (const me of g.players) {
    if (!me.ws || me.ws.readyState !== 1) continue;
    const x0 = me.x - CFG.VIEW_X, x1 = me.x + CFG.VIEW_X;
    const y0 = me.y - CFG.VIEW_Y, y1 = me.y + CFG.VIEW_Y;
    const near = (x, y, pad) => x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad;

    // Players: cull to the area of interest, then apply the stealth rule.
    const P = [];
    for (const q of g.players) {
      if (!near(q.x, q.y, 0) || !visibleTo(me, q)) continue;
      P.push([q.id, Math.round(q.x), Math.round(q.y), +q.ang.toFixed(2), q.wp, Math.round(q.hp), Math.round(q.sh), q.inb ? 1 : 0, +q.rc.toFixed(2)]);
    }
    const B = [], L = [], Wl = [], Sp = [];
    for (const b of g.bullets) if (near(b.x, b.y, 60)) B.push([b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]);
    for (const k of g.loot) if (near(k.x, k.y, 40)) L.push([k.x, k.y, k.k, k.i, k.n || 0]);
    for (const w of g.walls) if (w.x < x1 && w.x + w.w > x0 && w.y < y1 && w.y + w.h > y0) Wl.push([w.id, Math.round(w.x), Math.round(w.y), w.w, w.h, Math.round(w.hp)]);
    for (const s of g.splats) if (near(s.x, s.y, 20)) Sp.push([s.id, s.x, s.y, +s.r.toFixed(1), s.c, s.s]);

    send(me.ws, {
      t: 's',
      me: [Math.round(me.x), Math.round(me.y), +me.ang.toFixed(2), Math.round(me.hp), Math.round(me.sh),
        me.wp, me.wood, me.alive ? 1 : 0, me.k, me.inv.map(v => (v ? 1 : 0)).join('')],
      P, B, L, W: Wl, S: Sp,
      st: [Math.round(S.x), Math.round(S.y), Math.round(S.r), Math.round(S.tx), Math.round(S.ty), Math.round(S.tr), S.ph, +S.t.toFixed(1), S.sh ? 1 : 0],
      n: alive, tm: +g.t.toFixed(1),
      ev: g.events, feed: g.feed,
    });
  }
  g.events = [];
  g.feed = [];
}

// ---------- connections ----------
module.exports = function start(wss) {
  setInterval(() => {
    // A bad tick must never take the whole arcade (and every other game on it)
    // down with it. Log it and carry on next frame.
    try { tick(); } catch (err) { console.error('[storm] tick failed:', (err && err.stack) || err); }
  }, 1000 / CFG.TICK);

  setInterval(() => {
    try { pushList(); } catch (err) { console.error('[storm] list push failed:', (err && err.stack) || err); }
  }, CFG.LIST_EVERY);

  function tick() {
    for (const room of [...rooms.values()]) {
      const g = room.game;
      if (!g) continue;
      if (g.over) {
        // Standings have been on screen long enough; release everyone back to
        // the lobby and tear the room down.
        if ((g.resultsT -= 1000 / CFG.TICK) <= 0) closeRoom(room);
        continue;
      }
      step(g);
    }
  }

  function closeRoom(room) {
    for (const m of room.members) {
      m.ws.stormPlayer = null;
      send(m.ws, { t: 'lobby' });
    }
    rooms.delete(room.id);
    pushList();
  }

  wss.on('connection', ws => {
    ws.stormRoom = null;
    ws.stormPlayer = null;
    ws.stormMember = null;
    sockets.add(ws);
    // Greet a fresh client with the current rooms and the backdrop shoreline.
    send(ws, { t: 'list', list: roomList(), online: sockets.size, shore: BACKDROP });

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;

      const room = roomOf(ws);

      switch (m.t) {
        case 'create': {
          if (room) leaveRoom(ws);
          ws.stormName = pickName(ws, m.name);
          ws.stormCol = COLS.includes(m.col) ? m.col : COLS[0];
          createRoom(ws, m.max);
          break;
        }
        case 'quick': {
          if (room) leaveRoom(ws);
          ws.stormName = pickName(ws, m.name);
          ws.stormCol = COLS.includes(m.col) ? m.col : COLS[0];
          quickJoin(ws);
          break;
        }
        case 'join': {
          if (room) leaveRoom(ws);
          const target = rooms.get(+m.room);
          if (!target) return send(ws, { t: 'error', msg: 'That game has closed' });
          if (target.status !== 'waiting') return send(ws, { t: 'error', msg: 'That game has already started' });
          if (target.members.length >= target.max) return send(ws, { t: 'error', msg: 'That game is full' });
          ws.stormName = pickName(ws, m.name);
          ws.stormCol = COLS.includes(m.col) ? m.col : COLS[0];
          joinRoom(ws, target);
          break;
        }
        case 'leave': {
          // Acknowledge even when the room has already closed, otherwise a
          // client sitting on the end screen could never get back to the menu.
          if (room) leaveRoom(ws);
          send(ws, { t: 'lobby' });
          pushList();
          break;
        }
        case 'size': {
          // Only the host resizes the game.
          if (!room || room.status !== 'waiting' || room.hostId !== ws.stormMember) break;
          const n = clamp(+m.max || room.max, CFG.MIN_LOBBY, CFG.MAX_LOBBY);
          room.max = Math.max(n, room.members.length);
          pushRoom(room);
          pushList();
          break;
        }
        case 'start': {
          // Only the player who opened the game may launch it; otherwise anyone
          // in the room could start a match on someone else's behalf.
          if (!room || room.status !== 'waiting') break;
          if (room.hostId !== ws.stormMember) {
            return send(ws, { t: 'error', msg: 'Only the host can launch the game' });
          }
          startGame(room);
          break;
        }
        case 'in': {
          const g = room && room.game;
          const p = ws.stormPlayer;
          if (!p || !g || g.over || !p.alive) break;
          if (Number.isFinite(m.mx)) p.mx = clamp(m.mx, -1, 1);
          if (Number.isFinite(m.my)) p.my = clamp(m.my, -1, 1);
          if (Number.isFinite(m.a)) p.aim = m.a;
          p.fire = !!m.f;
          p.lastIn = g.t;
          if (m.b) p.wantBuild = true;
          if (m.s) p.wantSwap = true;
          break;
        }
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      ws.stormPlayer = null;
      // leaveRoom also removes a live body from its match, so the round
      // resolves immediately when somebody drops.
      leaveRoom(ws, true);
      pushList();
    });
    ws.on('error', () => {});
  });
};

function cleanName(n) {
  return String(n || '').replace(/[<>&"'\\]/g, '').trim().slice(0, 16) || 'Player';
}

// A validated account plays under its own name, whatever the client sent.
const pickName = (ws, sent) => (ws.account ? ws.account.name : cleanName(sent));
