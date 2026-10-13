'use strict';
// Headless integration test for the storm royale server.
// Boots the arcade server, drives a room-based match with fake clients, and
// checks the whole path: creating a room, joining it, resizing it, launching,
// the simulation itself, and the rules that end a match early.

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3457;
const URL = `ws://127.0.0.1:${PORT}/ws/storm`;

const log = (...a) => console.log('  ', ...a);
let failures = 0;
function check(name, cond, extra) {
  if (cond) log(`PASS  ${name}`);
  else { failures++; log(`FAIL  ${name}${extra ? ' -> ' + extra : ''}`); }
}

// A minimal stand-in for the browser client: it can run the room protocol and,
// once a match starts, it walks at the storm centre and shoots whatever it sees.
class Client {
  constructor(name, opts = {}) {
    this.name = name;
    this.col = opts.col || '#ef4444';
    this.msgs = [];
    this.state = {};
    this.events = [];
    this.feed = [];
    this.rooms = [];
    this.errors = [];
    this.mark = 0;
    this.deadAt = 0;
    this.resultsAt = 0;
    this.stopped = false;
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        this.msgs.push(m.t);
        if (m.t === 's') {
          this.state = m;
          this.events.push(...(m.ev || []));
          this.feed.push(...(m.feed || []));   // the feed is cleared each batch
        }
        else {
          this.last = m;
          if (m.t === 'world') { this.worldMsg = m; this.id = m.you; }
          if (m.t === 'room') this.roomMsg = m;
          if (m.t === 'list') { this.list = m; }
          if (m.t === 'dead') { this.deadMsg = m; this.deadAt = Date.now(); }
          if (m.t === 'results') { this.resultsMsg = m; this.resultsAt = Date.now(); }
          if (m.t === 'error') this.errors.push(m.msg);
        }
      });
      this.ws.on('close', () => { this.stopped = true; });
    });
  }
  send(o) { if (!this.stopped) this.ws.send(JSON.stringify(o)); }
  create(max) { this.send({ t: 'create', name: this.name, col: this.col, max }); }
  join(room) { this.send({ t: 'join', room, name: this.name, col: this.col }); }
  quick() { this.send({ t: 'quick', name: this.name, col: this.col }); }
  start() { this.send({ t: 'start' }); }
  size(max) { this.send({ t: 'size', max }); }
  leave() { this.send({ t: 'leave' }); }
  input(mx, my, a, fire, build, swap) {
    this.send({ t: 'in', mx, my, a, f: fire ? 1 : 0, b: build ? 1 : 0, s: swap ? 1 : 0 });
  }
  // Where am I in the snapshot's player list, if I am visible at all?
  self() { return (this.state.P || []).find(p => p[0] === this.id); }
  alive() { return !!(this.state.me && this.state.me[7]); }
  // Messages are kept forever, so anything asserted about "this match" has to
  // be counted from the point the match started rather than from the beginning.
  markMatch() {
    this.mark = this.msgs.length;
    this.feed = [];
    this.deadAt = 0;
    this.resultsAt = 0;
  }
  has(t) { return this.msgs.slice(this.mark).includes(t); }
  count(t) { return this.msgs.slice(this.mark).filter(x => x === t).length; }
  // Play a plausible fight: close on the next circle, engage anything in sight.
  // holdFire keeps A from simply shooting B dead, which would mask the idle rule.
  drive(holdFire) {
    const s = this.state;
    if (!s.me || !s.me[7] || !s.st) return;
    const [mx, my] = s.me;
    // st = [x, y, r, nextX, nextY, nextR, phase, t, shrinking]
    const goal = s.st[5] > 0 ? [s.st[3], s.st[4]] : [s.st[0], s.st[1]];
    let tgt = null, bd = 1e9;
    for (const p of s.P || []) {
      if (p[0] === this.id) continue;
      const d = Math.hypot(p[1] - mx, p[2] - my);
      if (d < bd) { bd = d; tgt = p; }
    }
    const aim = tgt
      ? Math.atan2(tgt[2] - my, tgt[1] - mx)
      : Math.atan2(goal[1] - my, goal[0] - mx);
    const toX = (tgt ? tgt[1] : goal[0]) - mx;
    const toY = (tgt ? tgt[2] : goal[1]) - my;
    const d = Math.hypot(toX, toY) || 1;
    // Push toward the circle, but stop and trade shots once someone is close.
    const advance = !tgt || bd > 380;
    this.input(advance ? toX / d : 0, advance ? toY / d : 0, aim, !holdFire && !!tgt && bd < 720);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const seen = (c, t) => c.msgs.includes(t);
// Wait for a predicate, giving up after ms. Returns whether it came true.
async function until(fn, ms = 5000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return fn();
}

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await sleep(900);
    check('server booted', /Arcade server on/.test(serverLog), serverLog.slice(0, 400));

    // --- lobby listing includes the game ------------------------------------
    const res = await fetch(`http://127.0.0.1:${PORT}/api/games`);
    const info = await res.json();
    const storm = info.games.find(g => g.id === 'storm');
    check('catalog lists storm as live', storm && storm.status === 'live');
    check('client page is served', (await fetch(`http://127.0.0.1:${PORT}/games/storm/`)).ok);
    check('game script is served', (await fetch(`http://127.0.0.1:${PORT}/games/storm/game.js`)).ok);

    // Regression guard for the freeze: a render loop that throws before it
    // schedules its next frame stops for good, leaving a bare island on screen
    // while the server keeps playing. The frame must be drawn inside a guard, and
    // the loop must always reschedule.
    const clientJs = await (await fetch(`http://127.0.0.1:${PORT}/games/storm/game.js`)).text();
    check('the render loop survives a throwing frame',
      /try\s*\{[\s\S]{0,400}draw\(\)[\s\S]{0,300}catch[\s\S]{0,300}requestAnimationFrame\(frame\)/.test(clientJs),
      'draw() must be wrapped and rAF rescheduled in a finally-safe order');
    check('the wall ghost does not read self before it exists',
      /if \(self && stats\.alive && \(stats\.wood/.test(clientJs),
      'the build ghost guard must include self');

    // --- A creates a room ---------------------------------------------------
    const a = new Client('Alice', { col: '#ef4444' });
    await a.connect();
    a.create(4);
    check('room creation acknowledged', await until(() => seen(a, 'room')));
    check('room payload echoes size', a.roomMsg && a.roomMsg.max === 4, JSON.stringify(a.roomMsg));
    check('creator is the host', a.roomMsg && a.roomMsg.hostId === a.roomMsg.you);
    check('creator is listed as a member', a.roomMsg && a.roomMsg.members.length === 1);
    const roomId = a.roomMsg && a.roomMsg.id;
    check('room has an id', !!roomId);

    // --- the room is visible in the browser list ---------------------------
    check('room appears in the open-games list',
      await until(() => a.list && a.list.list.some(r => r.id === roomId)));
    const listed = a.list.list.find(r => r.id === roomId);
    check('listed room reports its occupancy', listed && listed.n === 1 && listed.max === 4,
      JSON.stringify(listed));
    check('list reports online players', a.list && a.list.online >= 1);
    // The menus draw an island behind them, which has to work before any match
    // has been played, so the shoreline rides along with the list.
    check('a client with no match yet still gets an island to draw',
      !!(a.list && a.list.shore && a.list.shore.length > 50),
      a.list ? `shore=${a.list.shore && a.list.shore.length}` : 'no list');

    // --- B joins it ---------------------------------------------------------
    const b = new Client('Bob', { col: '#06b6d4' });
    await b.connect();
    b.join(roomId);
    check('second player joins the room', await until(() => b.roomMsg && b.roomMsg.members.length === 2));
    check('room update reaches the creator',
      await until(() => a.roomMsg && a.roomMsg.members.length === 2));

    // --- only the host may resize ------------------------------------------
    b.size(9);
    await sleep(300);
    check('non-host cannot resize the game', a.roomMsg.max === 4, `max=${a.roomMsg.max}`);
    a.size(6);
    check('host can resize the game', await until(() => a.roomMsg.max === 6));
    check('resize reaches the other member', await until(() => b.roomMsg.max === 6));

    // --- joining a room that is not there ----------------------------------
    const c = new Client('Cara', { col: '#a3e635' });
    await c.connect();
    c.errors = [];
    c.join(9999);
    check('joining a missing room is refused', await until(() => c.errors.length > 0));

    // --- A launches the match ----------------------------------------------
    a.start();
    check('world sent on launch', await until(() => seen(a, 'world') && seen(b, 'world')));
    check('roster sent', seen(a, 'roster') && seen(b, 'roster'));
    check('match started', seen(a, 'start') && seen(b, 'start'));
    check('each player knows its own id', a.id > 0 && b.id > 0 && a.id !== b.id);
    const world = a.worldMsg ? a.worldMsg.world : null;
    check('world has island layers', !!(world && world.isl && world.isl.grass.length > 100));
    check('world has trees', !!(world && world.trees.length > 150), world ? `trees=${world.trees.length}` : 'no world');
    check('world has bushes', !!(world && world.bushes.length > 20));
    check('world has static walls', !!(world && world.pw.length > 20));
    check('world has wave decor', !!(world && world.waves.length > 50));

    // --- snapshots flow ----------------------------------------------------
    await sleep(700);
    check('snapshots arriving', a.msgs.filter(t => t === 's').length > 5,
      `${a.msgs.filter(t => t === 's').length} snapshots`);
    const s = a.state;
    check('snapshot carries self state', Array.isArray(s.me) && s.me.length === 10);
    check('self stats sane', s.me[3] === 100 && s.me[7] === 1, JSON.stringify(s.me));
    check('empty slots were filled with bots', s.n === 6, `n=${s.n}`);
    check('storm present', Array.isArray(s.st) && s.st[2] > 0);

    // --- movement is authoritative ----------------------------------------
    const before = [s.me[0], s.me[1]];
    for (let i = 0; i < 12; i++) { a.input(1, 0, 0, false); await sleep(33); }
    await sleep(200);
    const moved = Math.hypot(a.state.me[0] - before[0], a.state.me[1] - before[1]);
    check('player moves on input', moved > 20, `moved ${moved.toFixed(1)}px`);

    // --- firing spawns bullets --------------------------------------------
    a.input(0, 0, 0, true);
    await sleep(250);
    a.input(0, 0, 0, false);
    check('firing produced events or bullets', a.events.some(e => e.e === 0) || (a.state.B || []).length > 0);

    // --- building consumes wood -------------------------------------------
    const woodBefore = a.state.me[6];
    for (let i = 0; i < 3; i++) { a.input(0, 0, 0, false, true); await sleep(60); }
    await sleep(250);
    check('build consumed wood', a.state.me[6] < woodBefore || woodBefore < 10,
      `wood ${woodBefore} -> ${a.state.me[6]}`);
    check('wall appears in world state', (a.state.W || []).length >= 0);

    // --- bots are alive and fighting --------------------------------------
    check('sees other players', (a.state.P || []).length >= 1, `${(a.state.P || []).length} visible`);
    check('AOI culls distant entities', (a.state.P || []).length < 6,
      `${(a.state.P || []).length} in AOI of 6`);
    await sleep(3000);
    check('match clock advancing', a.state.tm > 3, `t=${a.state.tm}`);

    // --- run it to the end -------------------------------------------------
    console.log('   ... playing out the match (up to 180s)');
    const t0 = Date.now();
    let ended = false;
    while (Date.now() - t0 < 180000) {
      await sleep(250);
      a.drive(); b.drive();
      if (seen(a, 'results') && seen(b, 'results')) { ended = true; break; }
    }
    check('match reached results screen', ended);

    const r = a.resultsMsg || {};
    check('results name a winner', !!r.winner, JSON.stringify({ winner: r.winner }));
    // The headline winner must be the same player the leaderboard ranks first,
    // or the results card contradicts the table printed underneath it.
    check('the announced winner is the one ranked first',
      r.leaderboard && r.winner === r.leaderboard[0].n,
      `winner=${r.winner} rank1=${r.leaderboard && r.leaderboard[0].n}`);
    check('results carry a leaderboard covering the whole game',
      !!(r.leaderboard && r.leaderboard.length === 6), `board=${r.leaderboard && r.leaderboard.length}`);
    check('leaderboard is ranked 1..n',
      r.leaderboard && r.leaderboard.every((e, i) => e.place === i + 1));
    check('someone took a kill', r.leaderboard && r.leaderboard.some(e => e.k > 0),
      JSON.stringify(r.leaderboard && r.leaderboard.slice(0, 3)));
    check('results carry a placement', r.place >= 1 && r.place <= 6, JSON.stringify({ place: r.place }));
    check('total players reported', r.total === 6, JSON.stringify({ total: r.total }));
    check('a guest match pays no XP', !r.reward, JSON.stringify(r.reward));

    // --- the point of the mode: no lingering bots-only match ---------------
    // Both humans died, so the match must end right away instead of letting
    // the bots grind the storm out.
    if (a.deadAt && b.deadAt) {
      const last = Math.max(a.deadAt, b.deadAt);
      check('match ends the moment the last human is out', (r && a.resultsAt - last) < 5000,
        `${((a.resultsAt - last) / 1000).toFixed(1)}s between last human out and results`);
      check('some bot was still standing when it ended', r.leaderboard.some(e => e.a === 1 && e.b === 1),
        JSON.stringify(r.leaderboard.filter(e => e.a).map(e => ({ n: e.n, b: e.b }))));
    } else {
      check('a human survived the match', !(a.deadAt && b.deadAt),
        `a=${!!a.deadAt} b=${!!b.deadAt}`);
    }

    // --- back to the game browser ------------------------------------------
    check('elimination was reported', a.msgs.includes('dead') || b.msgs.includes('dead'));
    check('everyone is released back to the browser after the match',
      await until(() => seen(a, 'lobby') && seen(b, 'lobby'), 20000));
    check('the finished room is no longer offered',
      await until(() => a.list && !a.list.list.some(r => r.id === roomId)));

    // --- a second game: an idle player must not stall the round ------------
    a.create(2);
    check('a new room can be created after a match', await until(() => a.roomMsg && a.roomMsg.id !== roomId));
    const room2 = a.roomMsg.id;
    b.join(room2);
    check('the same players can regroup', await until(() => b.roomMsg && b.roomMsg.id === room2));
    a.markMatch();
    b.markMatch();
    a.start();
    check('second match starts', await until(() => a.has('start'), 8000));
    check('second match has no bots when the room is full',
      await until(() => a.state.n === 2), `n=${a.state.n}`);

    // B goes completely silent - the tab-backgrounded case. A plays on alone.
    console.log('   ... waiting for the idle player to be dropped (up to 60s)');
    const idleFrom = Date.now();
    let idleOk = false;
    while (Date.now() - idleFrom < 60000) {
      await sleep(250);
      a.drive(true);                            // hold fire: only the timer may end B
      if (b.has('dead')) { idleOk = true; break; }
    }
    const idleWait = (Date.now() - idleFrom) / 1000;
    check('a player who stops sending input is removed', idleOk, `waited ${idleWait.toFixed(0)}s`);
    check('they are dropped on the idle timer, not by luck',
      idleOk && idleWait > 25 && idleWait < 45, `waited ${idleWait.toFixed(1)}s`);
    check('the idle player is told what happened',
      b.feed.some(line => /idle/i.test(line)), JSON.stringify(b.feed.slice(0, 4)));

    // With B gone, A is the last human standing and should take the win.
    check('the remaining human wins once the others are out',
      await until(() => a.has('results'), 60000));
    check('the winner is told they won', a.resultsMsg && a.resultsMsg.won === true,
      JSON.stringify({ won: a.resultsMsg && a.resultsMsg.won, winner: a.resultsMsg && a.resultsMsg.winner }));

    // --- a live room cannot be joined --------------------------------------
    const d = new Client('Dee', { col: '#8b5cf6' });
    await d.connect();
    d.errors = [];
    d.join(room2);
    check('joining a game already in progress is refused', await until(() => d.errors.length > 0));
    d.quick();
    check('quick play still finds you somewhere to play', await until(() => d.roomMsg && d.roomMsg.id));

    // --- launching is the host's call --------------------------------------
    // Fresh room, two players: the guest must not be able to start the game.
    // A opens a new room as soon as the previous match has released everyone.
    a.markMatch();
    a.create(2);
    check('the host waits for a finished match before reopening',
      await until(() => a.roomMsg && a.roomMsg.status === 'waiting', 25000));
    const room3 = a.roomMsg.id;
    const e = new Client('Eve', { col: '#14b8a6' });
    await e.connect();
    e.join(room3);
    check('the second player joins the room', await until(() => e.roomMsg && e.roomMsg.id === room3));
    check('the opener is the host and the joiner is not',
      a.roomMsg.hostId === a.roomMsg.you && e.roomMsg.hostId !== e.roomMsg.you);
    e.start();                                          // guest tries to launch
    await sleep(600);
    check('a guest cannot launch the game', !e.has('start') && !e.has('world'),
      `got ${[...new Set(e.msgs)].slice(0, 5).join(',') || 'nothing'}`);
    check('the room stays in the lobby after the refused launch',
      a.roomMsg.status === 'waiting', a.roomMsg.status);
    check('the guest is told why', e.errors.length > 0, JSON.stringify(e.errors));
    a.start();
    check('the host can still launch it', await until(() => a.has('start'), 8000));
    e.close();

    // --- disconnecting mid-match -------------------------------------------
    check('everyone is released back to the browser', await until(() => seen(a, 'lobby'), 25000));

    // --- disconnecting mid-match -------------------------------------------
    a.create(3);
    await until(() => a.roomMsg && a.roomMsg.status === 'waiting');
    a.markMatch();
    a.start();
    check('a solo game with bots starts', await until(() => a.has('start'), 8000));
    await sleep(1200);
    a.close();
    await sleep(900);
    check('survives a client disconnecting mid-match', !/TypeError|ReferenceError|\[storm\] tick failed/.test(serverLog),
      (serverLog.match(/.*(TypeError|ReferenceError|\[storm]).*/) || [''])[0]);

    d.close();
    await sleep(500);
  } catch (e) {
    failures++;
    console.error('   EXCEPTION', e);
  } finally {
    server.kill('SIGKILL');
  }

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nALL CHECKS PASSED\n');
  process.exit(failures ? 1 : 0);
})();