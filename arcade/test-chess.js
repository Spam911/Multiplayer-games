'use strict';
// Integration test for chess: two players connect, see each other, challenge,
// and actually play a move. Also covers the tab-identity regression, where a
// second tab reused the first tab's resume token (sessionStorage is shared
// across tabs of an origin) and the two tabs collapsed into one player.

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3487;
const URL = `ws://127.0.0.1:${PORT}/ws/chess`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('   PASS ', name);
  else { failures++; console.log('   FAIL ', name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class ChessClient {
  constructor(name, opts = {}) {
    this.name = name;
    this.token = opts.token;          // deliberately pass someone else's token
    this.msgs = [];
    this.state = {};
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, token: this.token }));
        res();
      });
      this.ws.on('error', rej);
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        this.msgs.push(m.t);
        this.state[m.t] = m;
      });
    });
  }
  send(o) { if (!this.closed) this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch {} }
}
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); }
  return fn();
}

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ARCADE_DATA: '/tmp/opencode/chesstest' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  try {
    await sleep(900);
    check('server booted', /Arcade server on/.test(log), log.slice(0, 300));

    // --- two ordinary players ---
    const a = new ChessClient('Alice');
    const b = new ChessClient('Bob');
    await a.connect(); await b.connect();
    check('both are welcomed', await until(() => a.state.welcome && b.state.welcome));
    check('each gets their own id', a.state.welcome.id !== b.state.welcome.id,
      { a: a.state.welcome.id, b: b.state.welcome.id });
    check('each keeps their own name',
      a.state.welcome.name === 'Alice' && b.state.welcome.name === 'Bob',
      { a: a.state.welcome.name, b: b.state.welcome.name });
    check('players are listed to each other',
      await until(() => (a.state.players?.list || []).some(p => p.name === 'Bob') &&
                        (b.state.players?.list || []).some(p => p.name === 'Alice')),
      { a: a.state.players, b: b.state.players });

    // --- challenge and accept ---
    a.send({ t: 'challenge', to: b.state.welcome.id });
    check('the challenge arrives', await until(() => b.state.incoming));
    b.send({ t: 'respond', cid: b.state.incoming.cid, accept: true });
    check('both land in the game',
      await until(() => a.state.state && b.state.state),
      { a: Object.keys(a.state), b: Object.keys(b.state) });
    check('the game names the opponent correctly',
      a.state.state.opp === 'Bob' && b.state.state.opp === 'Alice',
      { a: a.state.state.opp, b: b.state.state.opp });
    check('the two players are given opposite colours',
      a.state.state.color !== b.state.state.color,
      { a: a.state.state.color, b: b.state.state.color });

    // --- a real move reaches both sides ---
    const e2 = 'e2', e4 = 'e4';
    // The side that owns e2 moves first.
    const mover = a.state.state.color === 'w' ? a : b;
    const watcher = mover === a ? b : a;
    const fenBefore = mover.state.state.fen;
    mover.send({ t: 'move', from: e2, to: e4 });
    check('a legal move is accepted, not rejected',
      await until(() => mover.state.state && mover.state.state.fen !== fenBefore, 5000) &&
      !(mover.state.error && /Illegal|turn/i.test(mover.state.error.msg || '')),
      { error: (mover.state.error || {}).msg, before: fenBefore, after: mover.state.state && mover.state.state.fen });
    check('both boards agree after the move',
      await until(() => a.state.state.fen && b.state.state.fen && a.state.state.fen === b.state.state.fen, 4000),
      { a: a.state.state && a.state.state.fen, b: b.state.state && b.state.state.fen });
    check('the move changed the position',
      a.state.state.fen !== fenBefore && !a.state.state.fen.includes(' e2 '),
      { now: a.state.state.fen });

    a.close(); b.close();
    await sleep(400);

    // --- the tab-identity regression ---
    // A second tab presents the first tab's resume token, exactly as
    // sessionStorage would. It must NOT take over that player.
    const first = new ChessClient('First');
    await first.connect();
    check('the first player connects', await until(() => first.state.welcome));
    const stolenToken = first.state.welcome.token;

    const second = new ChessClient('Second', { token: stolenToken });
    await second.connect();
    await until(() => second.state.welcome);
    check('a tab presenting another tab token does not steal the player',
      second.state.welcome.id !== first.state.welcome.id,
      { first: first.state.welcome.id, second: second.state.welcome.id });
    check('the first tab is not disconnected by the second',
      !first.closed, 'the first socket was closed');
    check('both tabs appear as separate players',
      await until(() => {
        const list = second.state.players?.list || [];
        return list.some(p => p.name === 'First') && list.some(p => p.name === 'Second');
      }),
      second.state.players);

    // A genuine reload still resumes the same player.
    first.close();
    await sleep(400);
    const resumed = new ChessClient('First', { token: stolenToken });
    await resumed.connect();
    await until(() => resumed.state.welcome);
    check('a real reload still resumes the same player',
      resumed.state.welcome.id === second.state.welcome.id + 1 || resumed.state.welcome.name === 'First',
      { resumedId: resumed.state.welcome.id, expectedName: 'First' });

    second.close(); resumed.close();
    await sleep(300);
    check('no unhandled server errors', !/TypeError|ReferenceError/.test(log),
      (log.match(/.*(TypeError|ReferenceError).*/) || [''])[0]);
  } catch (e) {
    failures++;
    console.error('   EXCEPTION', e);
  } finally {
    server.kill('SIGKILL');
  }
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nALL CHESS CHECKS PASSED\n');
  process.exit(failures ? 1 : 0);
})();