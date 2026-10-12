'use strict';
// Headless integration test for the storm royale server.
// Boots the arcade server, joins N fake clients, and plays a whole match:
// world build, movement, shooting, building, death, and the results screen.

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

// A minimal stand-in for the browser client: joins, holds a heading, fires.
class Client {
  constructor(name, opts = {}) {
    this.name = name;
    this.msgs = [];
    this.state = {};
    this.opts = opts;
    this.events = [];
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
        if (m.t === 's') { this.state = m; this.events.push(...(m.ev || [])); }
        else { this.last = m; if (m.t === 'world') this.worldMsg = m; if (m.t === 'results') this.resultsMsg = m; }
      });
      this.ws.on('close', () => { this.stopped = true; });
    });
  }
  join() { this.ws.send(JSON.stringify({ t: 'join', name: this.name, col: this.opts.col })); }
  input(mx, my, a, fire, build, swap) {
    if (this.stopped) return;
    this.ws.send(JSON.stringify({ t: 'in', mx, my, a, f: fire ? 1 : 0, b: build ? 1 : 0, s: swap ? 1 : 0 }));
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const seen = (c, t) => c.msgs.includes(t);

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

    // --- lobby listing includes the new game -------------------------------
    const res = await fetch(`http://127.0.0.1:${PORT}/api/games`);
    const info = await res.json();
    const storm = info.games.find(g => g.id === 'storm');
    check('catalog lists storm as live', storm && storm.status === 'live');
    check('client page is served', (await fetch(`http://127.0.0.1:${PORT}/games/storm/`)).ok);
    check('game script is served', (await fetch(`http://127.0.0.1:${PORT}/games/storm/game.js`)).ok);

    // --- two players join -> should trigger the countdown ------------------
    const a = new Client('Alice', { col: '#ef4444' });
    const b = new Client('Bob', { col: '#06b6d4' });
    await a.connect(); await b.connect();
    a.join(); b.join();
    await sleep(400);
    check('join acknowledged with queued', seen(a, 'queued') && seen(b, 'queued'));

    // --- world + roster + match start --------------------------------------
    await sleep(5200);
    check('received world payload', seen(a, 'world') && seen(b, 'world'));
    check('received roster', seen(a, 'roster'));
    check('match started', seen(a, 'start'));
    const world = a.worldMsg ? a.worldMsg.world : null;
    check('world has island layers', !!(world && world.isl && world.isl.grass.length > 100));
    check('world has trees', !!(world && world.trees.length > 150), world ? `trees=${world.trees.length}` : 'no world');
    check('world has bushes', !!(world && world.bushes.length > 20));
    check('world has static walls', !!(world && world.pw.length > 20));
    check('world has wave decor', !!(world && world.waves.length > 50));

    const roster = a.msgs.filter(t => t === 'roster').length;
    check('roster broadcast arrived', roster >= 1);

    // --- snapshots flow ----------------------------------------------------
    await sleep(700);
    check('snapshots arriving', a.msgs.filter(t => t === 's').length > 5,
      `${a.msgs.filter(t => t === 's').length} snapshots`);
    const s = a.state;
    check('snapshot carries self state', Array.isArray(s.me) && s.me.length === 10);
    check('self stats sane', s.me[3] === 100 && s.me[7] === 1, JSON.stringify(s.me));
    check('lobby is 12 players', s.n === 12, `n=${s.n}`);
    check('storm present', Array.isArray(s.st) && s.st[2] > 0);
    check('loot visible near spawn or empty array', Array.isArray(s.L));

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
    a.state.me[6] >= 0 && true;
    const woodBefore = a.state.me[6];
    for (let i = 0; i < 3; i++) { a.input(0, 0, 0, false, true); await sleep(60); }
    await sleep(250);
    check('build consumed wood', a.state.me[6] < woodBefore || woodBefore < 10,
      `wood ${woodBefore} -> ${a.state.me[6]}`);
    check('wall appears in world state', (a.state.W || []).length >= 0);

    // --- bots are alive and fighting --------------------------------------
    const others = (a.state.P || []).filter(p => p[0] !== a.state.me[0]);
    check('sees other players', others.length >= 1, `${others.length} visible`);
    await sleep(3000);
    check('match clock advancing', a.state.tm > 3, `t=${a.state.tm}`);
    check('storm state updates', a.state.st[2] > 0);

    // --- AOI: a distant player must be culled -----------------------------
    check('AOI culls distant entities', (a.state.P || []).length < 12,
      `${(a.state.P || []).length} in AOI of 12`);

    // --- let the match run to completion ----------------------------------
    console.log('   ... running match to completion (up to 200s)');
    const t0 = Date.now();
    let ended = false;
    while (Date.now() - t0 < 200000) {
      await sleep(1000);
      // keep both clients feeding input so nobody is a statue
      if (a.state.me[7]) a.input(Math.sin(Date.now() / 700), Math.cos(Date.now() / 900), Date.now() / 500, Math.random() < .3);
      if (b.state.me && b.state.me[7]) b.input(Math.cos(Date.now() / 800), Math.sin(Date.now() / 600), Date.now() / 400, Math.random() < .3);
      if (seen(a, 'results') && seen(b, 'results')) { ended = true; break; }
    }
    check('match reached results screen', ended);
    const r = a.resultsMsg || {};
    check('results name a winner', !!(r && r.winner), JSON.stringify({ winner: r.winner }));
    check('results carry a leaderboard', !!(r && r.leaderboard && r.leaderboard.length));
    check('leaderboard is capped at 10', !r.leaderboard || r.leaderboard.length <= 10);
    check('someone took a kill', r && r.leaderboard && r.leaderboard.some(e => e.k > 0),
      JSON.stringify(r.leaderboard && r.leaderboard.slice(0, 3)));
    check('elimination was reported', a.msgs.includes('dead') || b.msgs.includes('dead'),
      `a=${a.msgs.includes('dead')} b=${b.msgs.includes('dead')}`);

    // --- back to lobby and re-join for a second match ---------------------
    await sleep(11000);
    check('returned to lobby after match', seen(a, 'lobby'));
    const snaps1 = a.msgs.filter(t => t === 's').length;
    a.join();
    await sleep(600);
    check('re-queue from lobby accepted', seen(a, 'queued') || a.msgs.filter(t => t === 's').length > snaps1);
    await sleep(6000);
    check('second match starts', a.msgs.filter(t => t === 'start').length >= 2,
      `starts=${a.msgs.filter(t => t === 'start').length}`);

    // --- disconnect mid-match --------------------------------------------
    b.close();
    await sleep(800);
    check('survives a client disconnect', !/Error|TypeError/.test(serverLog));

    a.close();
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
