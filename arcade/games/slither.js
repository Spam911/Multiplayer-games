'use strict';
// Slither game module. server.js calls start(wss) once with this game's WebSocketServer.

const CFG = {
  WORLD: 4000,
  TICK: 30,            // simulation steps per second
  SEND_EVERY: 2,       // send a snapshot every N ticks (=15 Hz)
  FOOD_TARGET: 1000,
  FOOD_MAX: 2500,
  BOTS: 8,             // set to 0 to disable bots
  MAX_PLAYERS: 40,
  SPEED: 170,          // px/s
  BOOST_SPEED: 300,
  TURN: 4.2,           // rad/s
  SPACING: 7,
  START_LEN: 12,
  VX: 1200,            // half-width of what each player receives
  VY: 800,             // half-height
};
const W = CFG.WORLD;
const DT = 1 / CFG.TICK;
const rnd = (a, b) => a + Math.random() * (b - a);
const wrap = a => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const radiusOf = s => 7 + Math.min(10, s.score / 80);

let nextId = 1;
const snakes = new Map();
const food = [];
const BOT_NAMES = ['Nagini', 'Kaa', 'Medusa', 'Sssam', 'Viper', 'Basilisk', 'Mamba', 'Python', 'Cobra', 'Rattler'];

function addFood(x, y, v, hue) {
  if (food.length >= CFG.FOOD_MAX) return;
  food.push({ x, y, v, hue, r: Math.round(3 + v * 1.5) });
}
function randomFood() {
  addFood(rnd(20, W - 20), rnd(20, W - 20), 1, Math.floor(rnd(0, 360)));
}
for (let i = 0; i < CFG.FOOD_TARGET; i++) randomFood();

function spawn(name, ws, bot) {
  const m = 300;
  const x = rnd(m, W - m), y = rnd(m, W - m), a = rnd(0, Math.PI * 2);
  const segs = [];
  for (let i = 0; i < CFG.START_LEN; i++) {
    segs.push({ x: x - Math.cos(a) * i * CFG.SPACING, y: y - Math.sin(a) * i * CFG.SPACING });
  }
  const s = {
    id: nextId++, name, ws, bot, segs,
    hue: Math.floor(rnd(0, 360)),
    angle: a, target: a, boost: false,
    score: 0, boostAcc: 0, aiT: 0, roam: null, food: null, prey: null,
  };
  snakes.set(s.id, s);
  return s;
}

// ---------- bots ----------
// A bot re-plans ~9x/second and then commits to the heading it chose, instead of
// nudging a fresh random angle on every think. Re-picking randomly is what used
// to make them orbit themselves until they ran into their own body.
//
// Each plan commits to one goal (hunt / graze / roam) and picks the cheapest of
// HEADINGS candidate headings. Every term is bounded to roughly 0..1 so none of
// them can dominate, and the straightness term is what actually stops the
// orbiting: nothing in this game kills a snake for running into itself, so
// without a dislike of hard swerves a bot with no threat in range just loops.
const LOOK = 170;
const HEADINGS = 24;

// A persistent wander point, so a bot with nothing in reach crosses the arena
// instead of looping a tight circle where it stands.
function roamGoal(s, h) {
  if (!s.roam || Math.hypot(s.roam.x - h.x, s.roam.y - h.y) < 320) {
    let x = 0, y = 0;
    for (let i = 0; i < 10; i++) {
      x = rnd(320, W - 320); y = rnd(320, W - 320);
      if (Math.hypot(x - h.x, y - h.y) < 1600) break;
    }
    s.roam = { x, y };
  }
  return { x: s.roam.x, y: s.roam.y, boost: false };
}

function foodGoal(s, h) {
  const REACH = 820;
  let best = null, bestScore = -Infinity;
  for (const f of food) {
    const dx = f.x - h.x, dy = f.y - h.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > REACH * REACH) continue;
    const d = Math.sqrt(d2);
    let sc = 200 - d * 0.25 + f.v * 14;
    if (f === s.food) sc += 60;            // mild commitment to the current pellet
    const wallD = Math.min(f.x, f.y, W - f.x, W - f.y);
    if (wallD < 260) sc -= (260 - wallD) * 1.2;  // never graze into a corner
    if (sc > bestScore) { bestScore = sc; best = f; }
  }
  s.food = best;
  return best ? { x: best.x, y: best.y, boost: false } : null;
}

// Cut in front of a rival rather than head-to-head: a head-on clash takes both
// snakes down, but parking our body across their path only kills them. So other
// snakes' *heads* are weighted as the most dangerous thing to drift into - their
// bodies are the safe ones to hit.
function huntGoal(s, h) {
  let prey = null, pd = 520 * 520, human = false;
  for (const o of snakes.values()) {
    if (o === s) continue;
    const isHuman = !o.bot;
    // Humans are always worth a run at. Bots only once we have a real size edge,
    // otherwise every bot fights every other bot from spawn and the arena churns.
    if (!isHuman && o.score * 1.6 > s.score) continue;
    const oh = o.segs[0];
    const dx = oh.x - h.x, dy = oh.y - h.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > pd) continue;
    pd = d2; prey = o; human = isHuman;
  }
  if (prey === s.prey) pd *= 0.55;        // stay committed to the chase
  s.prey = prey;
  if (!prey) return null;
  const d = Math.sqrt(pd);
  const lead = Math.min(230, 70 + d * 0.45);
  return {
    x: prey.segs[0].x + Math.cos(prey.angle) * lead,
    y: prey.segs[0].y + Math.sin(prey.angle) * lead,
    boost: d < 200 && s.score >= 14 && (human || s.score >= 40),
  };
}

function ai(s, now) {
  if (now < s.aiT) return;
  s.aiT = now + 110 + Math.random() * 60;
  const h = s.segs[0];
  s.boost = false;

  const len = s.segs.length * CFG.SPACING;
  const reach = LOOK + len * 0.3;
  const safe = 90 + len * 0.35;          // how close we like to be to a wall

  // Close to a wall? Forget food and prey, just get back to open ground.
  const pinned = h.x < safe || h.x > W - safe || h.y < safe || h.y > W - safe;
  const goal = pinned
    ? { x: W / 2, y: W / 2, boost: false }
    : huntGoal(s, h) || foodGoal(s, h) || roamGoal(s, h);

  // Bodies close enough to matter, gathered once per plan rather than once per
  // candidate heading.
  const R = LOOK + 80, R2 = R * R, hazards = [];
  for (const o of snakes.values()) {
    const mine = o === s;
    for (let i = 0; i < o.segs.length; i++) {
      const g = o.segs[i];
      const dx = g.x - h.x, dy = g.y - h.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      hazards.push({ ang: Math.atan2(dy, dx), d: Math.sqrt(d2), mine, head: i === 0 });
    }
  }

  let bestA = s.target, bestCost = Infinity;
  for (let i = 0; i < HEADINGS; i++) {
    const a = (i / HEADINGS) * Math.PI * 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    const px = h.x + ux * reach, py = h.y + uy * reach;

    // want: saturating, so a distant goal cannot swamp everything else
    let cost = 1 - Math.exp(-Math.hypot(goal.x - px, goal.y - py) / 700);

    // walls: worst axis only, squared, never summed
    const gap = Math.min(px, py, W - px, W - py);
    if (gap < safe) {
      const w = 1 - gap / safe;
      cost += w * w * 2.6;
    }

    // bodies: worst threat only (max, not sum) so a long body cannot dominate.
    // Only *other* snakes are lethal here - `if (a === b) continue` in tick()
    // means a snake can never run into itself, so own-body repulsion is kept
    // tiny and the real weight goes on rivals, whose heads and bodies both kill.
    let worst = 0;
    for (const z of hazards) {
      const diff = wrap(z.ang - a);
      if (diff > 1.75 || diff < -1.75) continue;     // well behind us
      const prox = 1 - z.d / R;
      const centred = 1 - Math.min(1, Math.abs(diff) / 1.75);
      const t = prox * prox * centred * (z.mine ? 0.15 : z.head ? 1.4 : 1);
      if (t > worst) worst = t;
    }
    cost += worst * 2.2;

    // Hold a line. Nothing in this game stops a snake running into itself, so
    // without an explicit dislike of hard swerves a bot with no threat in range
    // just orbits - which is exactly the "spins on itself" we are fixing. Real
    // players drive long sweeping arcs, and so should these.
    const turn = Math.abs(wrap(a - s.angle));
    cost += turn * turn * 0.5;

    if (cost < bestCost) { bestCost = cost; bestA = a; }
  }

  s.target = bestA;
  s.boost = !!goal.boost && s.score >= 14 && !pinned && bestCost < 0.85;
}

// ---------- simulation ----------
function stepSnake(s) {
  const head = s.segs[0];
  const diff = wrap(s.target - s.angle);
  const maxT = CFG.TURN * DT;
  s.angle += Math.max(-maxT, Math.min(maxT, diff));

  const boosting = s.boost && s.score >= 4;
  if (boosting) {
    s.boostAcc += DT;
    if (s.boostAcc >= 0.15) {
      s.boostAcc = 0;
      s.score -= 1;
      const t = s.segs[s.segs.length - 1];
      addFood(t.x + rnd(-5, 5), t.y + rnd(-5, 5), 1, s.hue);
    }
  }
  const sp = boosting ? CFG.BOOST_SPEED : CFG.SPEED;
  head.x += Math.cos(s.angle) * sp * DT;
  head.y += Math.sin(s.angle) * sp * DT;

  for (let i = 1; i < s.segs.length; i++) {
    const p = s.segs[i - 1], c = s.segs[i];
    const dx = p.x - c.x, dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > CFG.SPACING) {
      const k = (d - CFG.SPACING) / d;
      c.x += dx * k; c.y += dy * k;
    }
  }
  const want = CFG.START_LEN + Math.floor(s.score / 2);
  while (s.segs.length < want) {
    const t = s.segs[s.segs.length - 1];
    s.segs.push({ x: t.x, y: t.y });
  }
  while (s.segs.length > want && s.segs.length > CFG.START_LEN) s.segs.pop();

  // eat
  const er = radiusOf(s) + 10, er2 = er * er;
  for (let i = food.length - 1; i >= 0; i--) {
    const f = food[i];
    const dx = f.x - head.x, dy = f.y - head.y;
    if (dx * dx + dy * dy < er2) {
      s.score += f.v;
      food[i] = food[food.length - 1];
      food.pop();
    }
  }
  return head.x < 0 || head.x > W || head.y < 0 || head.y > W; // true = hit the wall
}

function kill(s) {
  for (let i = 0; i < s.segs.length; i += 2) {
    addFood(s.segs[i].x + rnd(-6, 6), s.segs[i].y + rnd(-6, 6), 2, s.hue);
  }
  snakes.delete(s.id);
  if (s.ws) {
    s.ws.snake = null;
    if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'dead', score: Math.floor(s.score) }));
  }
}

let tickNo = 0;
let lb = [];
function tick() {
  const now = Date.now();
  const dead = new Set();

  for (const s of snakes.values()) {
    if (s.bot) ai(s, now);
    if (stepSnake(s)) dead.add(s);
  }

  const list = [...snakes.values()];
  for (const a of list) {
    if (dead.has(a)) continue;
    const ra = radiusOf(a), h = a.segs[0];
    outer:
    for (const b of list) {
      if (a === b) continue;
      const bh = b.segs[0];
      const reach = b.segs.length * CFG.SPACING + 60;
      if (Math.abs(h.x - bh.x) > reach || Math.abs(h.y - bh.y) > reach) continue;
      const lim = ra * 0.5 + radiusOf(b) * 0.9, lim2 = lim * lim;
      for (const g of b.segs) {
        const dx = g.x - h.x, dy = g.y - h.y;
        if (dx * dx + dy * dy < lim2) { dead.add(a); break outer; }
      }
    }
  }
  for (const s of dead) kill(s);

  while (food.length < CFG.FOOD_TARGET) randomFood();

  tickNo++;
  if (tickNo % CFG.SEND_EVERY === 0) {
    if (tickNo % (CFG.SEND_EVERY * 15) === 0) {
      lb = [...snakes.values()].sort((a, b) => b.score - a.score).slice(0, 10)
        .map(s => [s.name, Math.floor(s.score)]);
    }
    sendSnapshots();
  }
}

function sendSnapshots() {
  for (const p of snakes.values()) {
    if (p.bot || !p.ws || p.ws.readyState !== 1) continue;
    const h = p.segs[0];
    const x0 = h.x - CFG.VX - 80, x1 = h.x + CFG.VX + 80;
    const y0 = h.y - CFG.VY - 80, y1 = h.y + CFG.VY + 80;

    const sn = [];
    for (const s of snakes.values()) {
      let vis = false;
      for (const g of s.segs) {
        if (g.x > x0 && g.x < x1 && g.y > y0 && g.y < y1) { vis = true; break; }
      }
      if (!vis) continue;
      const arr = new Array(s.segs.length * 2);
      for (let i = 0; i < s.segs.length; i++) {
        arr[i * 2] = Math.round(s.segs[i].x);
        arr[i * 2 + 1] = Math.round(s.segs[i].y);
      }
      sn.push({
        i: s.id, n: s.name, h: s.hue,
        r: +radiusOf(s).toFixed(1),
        b: s.boost && s.score >= 4 ? 1 : 0,
        sc: Math.floor(s.score), s: arr,
      });
    }
    const f = [];
    for (const fd of food) {
      if (fd.x > x0 && fd.x < x1 && fd.y > y0 && fd.y < y1) {
        f.push(Math.round(fd.x), Math.round(fd.y), fd.hue, fd.r);
      }
    }
    p.ws.send(JSON.stringify({ t: 's', sn, f, lb }));
  }
}


module.exports = function start(wss) {
  setInterval(tick, 1000 / CFG.TICK);

  // keep the bot population topped up
  setInterval(() => {
    let n = 0;
    for (const s of snakes.values()) if (s.bot) n++;
    for (; n < CFG.BOTS; n++) spawn(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], null, true);
  }, 2000);

  wss.on('connection', ws => {
    ws.snake = null;
    ws.send(JSON.stringify({ t: 'init', world: W, vx: CFG.VX, vy: CFG.VY }));

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join') {
        if (ws.snake) return;
        let humans = 0;
        for (const s of snakes.values()) if (!s.bot) humans++;
        if (humans >= CFG.MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'full' }));
        const name = String(m.name || '').replace(/[<>&"'\\]/g, '').trim().slice(0, 16) || 'Anon';
        ws.snake = spawn(name, ws, false);
        ws.send(JSON.stringify({ t: 'joined', id: ws.snake.id }));
      } else if (m.t === 'in' && ws.snake) {
        if (Number.isFinite(m.a)) ws.snake.target = m.a;
        ws.snake.boost = !!m.b;
      }
    });
    ws.on('close', () => { if (ws.snake) snakes.delete(ws.snake.id); });
    ws.on('error', () => {});
  });
};
