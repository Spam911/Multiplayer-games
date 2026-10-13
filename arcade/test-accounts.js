'use strict';
// Integration test for the account system.
//
//   node test-accounts.js
//
// Phase 1 (server running): registration needs admin approval, settings save,
//   the leaderboard only lists validated accounts, and a real WebSocket match
//   pays XP out to a signed-in player but not to a guest.
// Phase 2 (server stopped, in process): the reward formulas and their caps,
//   exercised directly against the reward table the games share.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3458;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-acc-'));
process.env.ARCADE_DATA = DATA;          // the in-process phase must use the same file

let failures = 0;
const log = (...a) => console.log('  ', ...a);
function check(name, cond, extra) {
  if (cond) log('PASS  ' + name);
  else { failures++; log('FAIL  ' + name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ARCADE_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => log('srv! ' + String(d).trim()));
  srv.on('exit', () => log('srv  server stopped'));
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/health'); return srv; } catch { await sleep(100); }
  }
  throw new Error('server did not boot');
}

// A cookie jar so a client keeps its session the way a browser would.
function makeClient() {
  const jar = { cookie: '' };
  const call = async (pathname, body) => {
    const res = await fetch(BASE + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(jar.cookie ? { cookie: jar.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) jar.cookie = c.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, ...(json || {}) };
  };
  call.jar = jar;
  call.token = () => jar.cookie.split('=').slice(1).join('=');
  return call;
}

// Plays one slither round: eat a little first (so the score is non zero), then
// steer straight into the wall until the server reports the round is over.
function playUntilDead(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/slither`, cookie ? { headers: { cookie } } : {});
    const timer = setTimeout(() => { ws.close(); reject(new Error('timed out')); }, 30000);
    const started = Date.now();
    const EAT_MS = 3000;                     // feed phase before we crash on purpose
    let myId = null;
    const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

    ws.on('error', reject);
    ws.on('open', () => send({ t: 'join', name: 'Test' }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') { myId = m.id; return; }
      if (m.t === 'dead') { clearTimeout(timer); ws.close(); resolve(m); return; }
      if (m.t !== 's') return;

      const me = m.sn.find(s => s.i === myId);
      if (!me) return;                        // not spawned yet
      const [hx, hy] = [me.s[0], me.s[1]];

      if (Date.now() - started > EAT_MS) { send({ t: 'in', a: 0, b: 0 }); return; }   // straight into the wall

      // Head for the closest visible pellet (food is sent as [x, y, hue, r]).
      let best = null, bestD = Infinity;
      for (let i = 0; i < m.f.length; i += 4) {
        const d = Math.hypot(m.f[i] - hx, m.f[i + 1] - hy);
        if (d < bestD) { bestD = d; best = m.f; }
      }
      if (best && bestD < 400) send({ t: 'in', a: Math.atan2(best[1] - hy, best[0] - hx), b: 0 });
      else send({ t: 'in', a: 0, b: 1 });    // nothing in reach: boost around a bit
    });
  });
}

// Registers an account, has the admin validate it and returns a signed-in client.
async function newValidated(name, adminClient) {
  const c = makeClient();
  await c('/api/auth/register', { name, password: 'secret123' });
  await adminClient('/api/admin/user/' + encodeURIComponent(name), { action: 'validate' });
  const r = await c('/api/auth/login', { name, password: 'secret123' });
  if (!r.ok) throw new Error(`could not sign in ${name}: ${r.error}`);
  return c;
}

// Two chess clients: one challenges, the other accepts, then Alice resigns.
// Resolves once both sides have received their reward.
function playChessToResign(a, b) {
  function open(client, label) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chess`, { headers: { cookie: client.jar.cookie } });
    const st = { id: null, incoming: [], reward: null, send: o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
    st.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} never got a welcome`)), 10000);
      ws.on('error', reject);
      ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'welcome') { st.id = m.id; clearTimeout(timer); resolve(st); }
        else if (m.t === 'incoming') st.incoming.push(m);
      });
    });
    st.rewarded = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 10000);
      ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'reward') { st.reward = m.reward; clearTimeout(timer); resolve(m.reward); }
      });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: label })));
    return st;
  }

  return (async () => {
    const A = open(a, 'Alice'), B = open(b, 'Bob');
    await Promise.all([A.ready, B.ready]);
    A.send({ t: 'challenge', to: B.id });
    await sleep(300);
    B.send({ t: 'respond', cid: B.incoming[0].cid, accept: true });
    await sleep(400);
    A.send({ t: 'resign' });
    const [aliceReward, bobReward] = await Promise.all([A.rewarded, B.rewarded]);
    A.send({ t: 'leave' }); B.send({ t: 'leave' });
    return { alice: { ...A, reward: aliceReward }, bob: { ...B, reward: bobReward } };
  })();
}

(async () => {
  let server = await startServer();
  const cleanup = () => { try { server.kill(); } catch {} };
  process.on('exit', cleanup);

  const admin = makeClient();
  const guest = makeClient();

  console.log('\n  admin');
  let r = await admin('/api/auth/login', { name: 'Matakara', password: 'Games123' });
  check('admin signs in with the seeded credentials', r.ok && r.admin === true, r);
  r = await admin('/api/auth/login', { name: 'Matakara', password: 'wrong' });
  check('wrong admin password is rejected', r.status === 401, r);

  console.log('\n  registration needs validation');
  const player = makeClient();
  r = await player('/api/auth/register', { name: 'Tester', password: 'secret123' });
  check('registration is accepted', r.ok && r.pending === true, r);
  r = await player('/api/auth/login', { name: 'Tester', password: 'secret123' });
  check('pending account cannot sign in', r.status === 403 && /validat/i.test(r.error), r);
  r = await player('/api/auth/register', { name: 'tester', password: 'secret123' });
  check('duplicate names are refused', r.status === 400, r);
  r = await player('/api/auth/register', { name: 'x', password: 'secret123' });
  check('short names are refused', r.status === 400, r);
  r = await player('/api/auth/register', { name: 'Matakara', password: 'Games123' });
  check('the admin name cannot be re-registered', r.status === 400, r);

  console.log('\n  admin endpoints are protected');
  check('anonymous cannot list users', (await makeClient()('/api/admin/users')).status === 403);
  check('pending account cannot list users', (await player('/api/admin/pending')).status === 403);

  console.log('\n  validation');
  r = await admin('/api/admin/pending');
  check('admin sees the pending account', r.ok && r.users.some(u => u.name === 'Tester'), r);
  check('pending count is 1', r.stats.pending === 1, r.stats);
  r = await admin('/api/admin/user/Tester', { action: 'validate' });
  check('admin validates the account', r.ok && r.user.status === 'active', r);
  r = await player('/api/auth/login', { name: 'Tester', password: 'secret123' });
  check('validated account can sign in', r.ok && r.user.name === 'Tester', r);
  check('new account starts at 0 XP, level 1', r.user.xp === 0 && r.user.level === 1, r.user);
  r = await admin('/api/admin/user/Matakara', { action: 'pending' });
  check('admin cannot demote themself', r.status === 400, r);
  r = await admin('/api/admin/user/Nobody', { action: 'validate' });
  check('validating an unknown account fails cleanly', r.status === 400, r);

  console.log('\n  settings');
  r = await player('/api/auth/settings', { slitherCfg: JSON.stringify({ sens: 1.4, touch: 'on' }) });
  check('settings are saved', r.ok && JSON.parse(r.user.settings.slitherCfg).sens === 1.4, r.user.settings);
  r = await player('/api/auth/settings', { 'bad key!': 'x', audioMus: 'false' });
  check('invalid setting keys are dropped', r.ok && r.user.settings['bad key!'] === undefined, r.user.settings);
  check('boolean settings are kept', r.user.settings.audioMus === 'false', r.user.settings);
  check('anonymous cannot save settings', (await guest('/api/auth/settings', { x: 1 })).status === 401);

  console.log('\n  a real match pays XP to accounts only');
  const round = await playUntilDead(player.jar.cookie);
  check('the round ended with a score', typeof round.score === 'number' && round.score > 0, round);
  check('a placement is reported', typeof round.rank === 'number' && round.rank > 0, round.rank);
  check('the signed-in player earned XP', !!round.reward && round.reward.xp > 0, round.reward);
  check('the signed-in player earned tokens', !!round.reward && round.reward.tokens > 0, round.reward);
  check('the account name overrides the nickname sent by the client', round.reward.game === 'slither', round.reward);
  const gained = round.reward.xp;
  const after = (await player('/api/auth/me')).user;
  check('XP landed on the account', after.xp === gained, { xp: after.xp, gained });
  check('per-game stats are tracked', after.games.slither.xp === gained && after.games.slither.plays === 1, after.games.slither);

  const guestRound = await playUntilDead('');
  check('a guest gets no reward', !guestRound.reward, guestRound);

  console.log('\n  a chess game pays both sides');
  // Two validated accounts, one of them resigning: the quitter must be paid
  // less than the winner, and both must land on their own account.
  const alice = await newValidated('Alice', admin);
  const bob = await newValidated('Bob', admin);
  const chess = await playChessToResign(alice, bob);
  check('both players got a reward', chess.alice.reward && chess.bob.reward, chess);
  const resultOf = r => r.detail.result;
  check('the winner is paid a win', resultOf(chess.bob.reward) === 'win', chess.bob.reward);
  check('the quitter is paid a resign', resultOf(chess.alice.reward) === 'resign', chess.alice.reward);
  check('a win pays more than a resign', Math.max(chess.alice.reward.xp, chess.bob.reward.xp) > Math.min(chess.alice.reward.xp, chess.bob.reward.xp), chess);
  check('the winner is flagged', chess.bob.reward.win === true && chess.alice.reward.win === false, chess);
  check('the reward names the game', chess.alice.reward.game === 'chess', chess.alice.reward);
  const aliceAcc = (await alice('/api/auth/me')).user;
  check('the winner keeps their own name', aliceAcc.games.chess.plays === 1, aliceAcc.games.chess);
  check('the loser is credited too', (await bob('/api/auth/me')).user.games.chess.plays === 1);
  console.log('\n  leaderboard');
  await admin('/api/admin/user/Matakara', { action: 'grant', xp: 5000, tokens: 42 });
  r = await guest('/api/leaderboard');
  check('leaderboard is public', r.ok && Array.isArray(r.leaderboard), r);
  check('only validated accounts are ranked',
    r.leaderboard.length === 4 && ['Tester', 'Matakara', 'Alice', 'Bob'].every(n => r.leaderboard.some(e => e.name === n)), r.leaderboard);
  check('ranks are sequential from 1', r.leaderboard.every((e, i) => e.rank === i + 1), r.leaderboard.map(e => e.rank));
  check('the ranking is ordered by XP', r.leaderboard.every((e, i, a) => i === 0 || a[i - 1].xp >= e.xp), r.leaderboard);
  check('admin is ranked first with the granted XP', r.leaderboard[0].name === 'Matakara' && r.leaderboard[0].xp === 5000, r.leaderboard[0]);
  check('admin is flagged in the ranking', r.leaderboard[0].admin === true, r.leaderboard[0]);
  check('the chess winner outranks the slither player', r.leaderboard[1].name === 'Bob', r.leaderboard.slice(0, 3));

  await player('/api/auth/register', { name: 'Waiting', password: 'secret123' });
  r = await guest('/api/leaderboard');
  check('pending accounts stay off the ranking', !r.leaderboard.some(e => e.name === 'Waiting'), r.leaderboard);

  r = await guest('/api/games/summary');
  check('per-game summary lists the live games', r.ok && ['slither', 'chess', 'storm'].every(id => r.games.some(g => g.id === id)), r.games && r.games.map(g => g.id));
  check('per-game summary shows slither XP', r.games.find(g => g.id === 'slither').top[0].name === 'Tester', r.games.find(g => g.id === 'slither').top);

  console.log('\n  rejection, admin grants, logout');
  const doomed = makeClient();
  await doomed('/api/auth/register', { name: 'Doomed', password: 'secret123' });
  await admin('/api/admin/user/Doomed', { action: 'reject' });
  r = await doomed('/api/auth/login', { name: 'Doomed', password: 'secret123' });
  check('rejected account cannot sign in', r.status === 403 && /rejected/i.test(r.error), r);

  r = await admin('/api/admin/user/Tester', { action: 'grant', xp: -5, tokens: -100000 });
  check('grants cannot push a balance negative', r.ok && r.user.tokens === 0 && r.user.xp === Math.max(0, gained - 5), r.user);

  const xpBefore = (await player('/api/auth/me')).user.xp;
  r = await player('/api/auth/logout', {});
  check('logout succeeds', r.ok, r);
  check('session is gone after logout', (await player('/api/auth/me')).user === null);
  r = await player('/api/auth/login', { name: 'Tester', password: 'secret123' });
  check('XP survived the logout', r.user.xp === xpBefore, r.user);

  console.log('\n  persistence');
  server.kill();
  await sleep(400);
  server = await startServer();
  r = await player('/api/auth/login', { name: 'Tester', password: 'secret123' });
  check('accounts, XP and tokens survive a restart', r.ok && r.user.xp === xpBefore && r.user.tokens >= 0, r.user);
  check('the ranking survives a restart', (await guest('/api/leaderboard')).leaderboard[0].xp === 5000);
  check('the session cookie survives a restart', (await player('/api/auth/me')).user !== null);
  server.kill();
  await sleep(300);

  // ---- phase 2: the reward table itself, no server involved ----
  // Point the in-process copy at a scratch dir: requiring the modules boots
  // them (and seeds an admin), and these checks only need the pure functions.
  console.log('\n  reward table');
  const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-acc-unit-'));
  process.env.ARCADE_DATA = UNIT_DIR;
  const { reward, XP } = require('./lib/progress');
  const accounts = require('./lib/accounts');
  const fake = () => ({ id: 'x', name: 'Unit', role: 'player', status: 'active', xp: 0, tokens: 0, games: {}, settings: {}, inventory: {} });

  let u = fake();
  check('slither: 4 XP per point of score', reward(u, 'slither', { score: 10, rank: 2 }).xp === 40);
  check('slither: last place pays a bonus', reward(u, 'slither', { score: 10, rank: 1 }).xp === 40 + XP.slither.win);
  check('slither: capped', reward(u, 'slither', { score: 1e6, rank: 1 }).xp === XP.slither.max);

  u = fake();
  check('chess: win pays the most', reward(u, 'chess', { result: 'win' }).xp === XP.chess.win);
  check('chess: a draw pays less than a win', reward(u, 'chess', { result: 'draw' }).xp === XP.chess.draw);
  check('chess: a loss still pays something', reward(u, 'chess', { result: 'loss' }).xp === XP.chess.loss);
  check('chess: quitting pays the least', reward(u, 'chess', { result: 'resign' }).xp === XP.chess.resign);
  check('chess: order is win > draw > loss > resign',
    XP.chess.win > XP.chess.draw && XP.chess.draw > XP.chess.loss && XP.chess.loss > XP.chess.resign);

  u = fake();
  check('storm: first place with 2 kills', reward(u, 'storm', { kills: 2, place: 1, alive: true }).xp === 2 * 35 + 40 + 200);
  check('storm: a later place pays less', reward(u, 'storm', { kills: 0, place: 10, alive: false }).xp === XP.storm.placeBonus[9]);
  check('storm: placement pays more the higher you finish',
    XP.storm.placeBonus.every((v, i, a) => i === 0 || v <= a[i - 1]), XP.storm.placeBonus);
  check('storm: capped', reward(u, 'storm', { kills: 999, place: 1, alive: true }).xp === XP.storm.max);

  u = fake();
  check('wins are counted per game', (() => {
    reward(u, 'storm', { kills: 1, place: 1, alive: true });
    reward(u, 'storm', { kills: 1, place: 4, alive: false });
    return u.games.storm.wins === 1 && u.games.storm.plays === 2;
  })());
  check('an unvalidated account earns nothing', reward({ ...fake(), status: 'pending' }, 'slither', { score: 50 }) === null);
  check('a guest (no account) earns nothing', reward(null, 'slither', { score: 50 }) === null);
  check('an unknown game id is rejected', reward(fake(), '../../etc', { xp: 5 }) === null);
  check('a stray negative xp field cannot reduce a win', reward(fake(), 'chess', { result: 'win', xp: -999 }).xp === XP.chess.win);

  console.log('\n  level curve');
  check('level 1 at 0 XP', accounts.levelFromXp(0) === 1);
  check('level 2 at 100 XP', accounts.levelFromXp(100) === 2);
  check('level 3 at 300 XP', accounts.levelFromXp(300) === 3);
  check('level 4 at 600 XP', accounts.levelFromXp(600) === 4);
  check('level 10 at 4500 XP', accounts.levelFromXp(4500) === 10);
  check('just under a level stays put', accounts.levelFromXp(99) === 1 && accounts.levelFromXp(299) === 2);
  check('every level boundary maps back to its level',
    Array.from({ length: 30 }, (_, i) => accounts.levelFromXp(accounts.xpForLevel(i + 1)) === i + 1).every(Boolean));

  console.log(failures ? `\n  ${failures} FAILURE(S)\n` : '\n  all good\n');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(UNIT_DIR, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error(e);
  for (const d of new Set([DATA, process.env.ARCADE_DATA])) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  process.exit(1);
});
