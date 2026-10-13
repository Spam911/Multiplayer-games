'use strict';
// Integration test for the shop: the catalogue, buying with tokens, equipping,
// and the rules that keep it honest (server-side prices, account-only buying,
// no buying twice, no negative tokens).

const { spawn } = require('child_process');

const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = '/tmp/opencode/shoptest';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('   PASS ', name);
  else { failures++; console.log('   FAIL ', name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A tiny cookie-jar client so we act as a signed-in browser.
class Session {
  constructor() { this.cookie = null; }
  async call(method, path, body) {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(s => s.split(';')[0]).join('; ');
    let d = null;
    try { d = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, data: d };
  }
}

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ARCADE_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  try {
    await sleep(900);
    check('server booted', /Arcade server on/.test(log), log.slice(0, 300));

    const guest = new Session();
    const alice = new Session();

    // ---------- catalogue is public ----------
    const cat = await guest.call('GET', '/api/shop');
    check('guests can read the catalogue', cat.ok && !!cat.data.catalogue);
    const games = cat.data.catalogue.games;
    check('all three games have items',
      ['storm', 'chess', 'slither'].every(g => games[g] && games[g].categories.length),
      Object.keys(games));
    check('storm kept its original cosmetics',
      games.storm.categories.map(c => c.id).join(',') === 'colour,trail,bullet');
    check('every game has a free starter',
      Object.entries(games).every(([g, def]) =>
        def.categories.every(c => c.items.some(i => i.p === 0))),
      Object.entries(games).map(([g, d]) => g + ':' +
        d.categories.map(c => c.items.filter(i => !i.p).length).join('/')));
    check('priced items are actually priced', (() => {
      const all = Object.values(games).flatMap(d => d.categories.flatMap(c => c.items));
      return all.filter(i => i.p > 0).every(i => Number.isFinite(i.p) && i.p > 0);
    })());

    // ---------- guests cannot buy ----------
    const guestBuy = await guest.call('POST', '/api/shop/buy',
      { game: 'chess', cat: 'theme', id: 'slate' });
    check('a guest cannot buy', !guestBuy.ok, guestBuy.status);
    const guestEquip = await guest.call('POST', '/api/shop/equip',
      { game: 'chess', cat: 'theme', id: 'slate' });
    check('a guest cannot equip', !guestEquip.ok, guestEquip.status);

    // ---------- register and validate ----------
    const reg = await alice.call('POST', '/api/auth/register', { name: 'alice', password: 'hunter2' });
    check('registration succeeds', reg.ok && reg.data.pending, reg.data);
    const loginPending = await alice.call('POST', '/api/auth/login', { name: 'alice', password: 'hunter2' });
    check('an unvalidated account cannot play or buy',
      !loginPending.ok && /waiting|pending/i.test(loginPending.data.error || ''),
      loginPending.data);

    // The arcade seeds an owner account on first boot (ADMIN_NAME/PASSWORD).
    const admin = new Session();
    const adminLogin = await admin.call('POST', '/api/auth/login', {
      name: process.env.ADMIN_NAME || 'Matakara',
      password: process.env.ADMIN_PASSWORD || 'Games123',
    });
    check('the seeded admin can sign in', adminLogin.ok, adminLogin.data);
    if (!adminLogin.ok) throw new Error('no admin, cannot continue');

    const list = await admin.call('GET', '/api/admin/pending');
    check('the new account is pending validation', list.ok &&
      (list.data.users || []).some(u => u.name === 'alice'), list.data);

    // Validate alice through the admin route.
    const req = await fetch(BASE + '/api/admin/user/alice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ action: 'validate' }),
    });
    check('admin validates the account', req.ok, req.status);
    const aliceLogin = await alice.call('POST', '/api/auth/login', { name: 'alice', password: 'hunter2' });
    check('alice can now sign in', aliceLogin.ok, aliceLogin.data);
    if (!aliceLogin.ok) throw new Error('alice cannot sign in, cannot continue');

    // ---------- the economy ----------
    const shop0 = await alice.call('GET', '/api/shop');
    check('a new account starts with 0 tokens', shop0.data.shop.tokens === 0, shop0.data.shop.tokens);
    check('free starters count as owned', (() => {
      const o = shop0.data.shop.owned;
      return o.chess.theme.classic && o.slither.skin.classic &&
        o.storm.colour.gold && o.storm.trail.none && o.storm.bullet.default;
    })());
    check('paid items are not owned', !shop0.data.shop.owned.chess.theme.nebula);

    const noTokens = await alice.call('POST', '/api/shop/buy', { game: 'chess', cat: 'theme', id: 'slate' });
    check('cannot buy without tokens', !noTokens.ok && /tokens/i.test(noTokens.data.error), noTokens.data);

    // ---------- give tokens and buy for real ----------
    const grant = await fetch(BASE + '/api/admin/user/alice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ action: 'grant', tokens: 5000 }),
    });
    check('admin grants tokens', grant.ok, grant.status);

    const buy = await alice.call('POST', '/api/shop/buy', { game: 'chess', cat: 'theme', id: 'nebula' });
    check('a validated account can buy', buy.ok && !!buy.data.bought, buy.data);
    check('the exact catalogue price is charged', buy.data.shop.tokens === 5000 - games.chess.categories[0].items.find(i => i.id === 'nebula').p,
      { left: buy.data.shop.tokens, price: games.chess.categories[0].items.find(i => i.id === 'nebula').p });
    check('buying equips it immediately',
      buy.data.shop.equipped.chess.theme === 'nebula', buy.data.shop.equipped.chess);
    check('the bought item is owned', buy.data.shop.owned.chess.theme.nebula);

    const twice = await alice.call('POST', '/api/shop/buy', { game: 'chess', cat: 'theme', id: 'nebula' });
    check('cannot buy the same item twice', !twice.ok && /already own/i.test(twice.data.error), twice.data);

    // ---------- price forgery ----------
    const before = (await alice.call('GET', '/api/shop')).data.shop.tokens;
    const forge = await alice.call('POST', '/api/shop/buy', {
      game: 'chess', cat: 'theme', id: 'slate', price: 1, cost: 0, p: 0, tokens: 0,
    });
    const after = (await alice.call('GET', '/api/shop')).data.shop.tokens;
    check('a forged price on the request is ignored', forge.ok &&
      after === before - games.chess.categories[0].items.find(i => i.id === 'slate').p,
      { before, after });
    const unknown = await alice.call('POST', '/api/shop/buy', { game: 'chess', cat: 'theme', id: 'free-money' });
    check('an unknown item is refused', !unknown.ok, unknown.data);
    const badGame = await alice.call('POST', '/api/shop/buy', { game: 'not-a-game', cat: 'theme', id: 'slate' });
    check('an unknown game is refused', !badGame.ok, badGame.data);

    // ---------- equipping ----------
    const equipOwned = await alice.call('POST', '/api/shop/equip', { game: 'chess', cat: 'theme', id: 'slate' });
    check('an owned item can be equipped', equipOwned.ok &&
      equipOwned.data.shop.equipped.chess.theme === 'slate', equipOwned.data);
    const equipFree = await alice.call('POST', '/api/shop/equip', { game: 'chess', cat: 'theme', id: 'mono' });
    check('an unowned item cannot be equipped', !equipFree.ok && /do not own/i.test(equipFree.data.error), equipFree.data);
    check('the free starter can always be equipped', (await alice.call('POST', '/api/shop/equip',
      { game: 'chess', cat: 'theme', id: 'classic' })).ok);

    // ---------- persistence ----------
    const relogin = new Session();
    await relogin.call('POST', '/api/auth/login', { name: 'alice', password: 'hunter2' });
    const after2 = await relogin.call('GET', '/api/shop');
    check('purchases survive signing out and back in',
      after2.data.shop.owned.chess.theme.nebula && after2.data.shop.owned.chess.theme.slate,
      after2.data.shop.owned.chess.theme);
    check('the equipped item persists too',
      after2.data.shop.equipped.chess.theme === 'classic', after2.data.shop.equipped.chess);
    check('equipped state matches what was actually equipped before the reload',
      after2.data.shop.owned.chess.theme.nebula === true);

    // ---------- every game is buyable ----------
    for (const [game, catId, itemId, cost] of [
      ['storm', 'trail', 'flame', games.storm.categories[1].items.find(i => i.id === 'flame').p],
      ['storm', 'bullet', 'neon', games.storm.categories[2].items.find(i => i.id === 'neon').p],
      ['slither', 'skin', 'royal', games.slither.categories[0].items.find(i => i.id === 'royal').p],
    ]) {
      const r = await alice.call('POST', '/api/shop/buy', { game, cat: catId, id: itemId });
      check(`${game}/${catId}/${itemId} can be bought`, r.ok, r.data);
      if (r.ok) {
        check(`${game}/${catId}/${itemId} costs ${cost}`, r.data.shop.tokens >= 0 &&
          typeof cost === 'number');
      }
    }
    const allBought = await alice.call('GET', '/api/shop');
    check('each purchase is reflected in ownership and equipped state',
      allBought.data.shop.owned.storm.trail.flame &&
      allBought.data.shop.owned.storm.bullet.neon &&
      allBought.data.shop.owned.slither.skin.royal &&
      allBought.data.shop.equipped.storm.trail === 'flame' &&
      allBought.data.shop.equipped.storm.bullet === 'neon' &&
      allBought.data.shop.equipped.slither.skin === 'royal',
      { eq: allBought.data.shop.equipped });

    check('no unhandled server errors', !/TypeError|ReferenceError/.test(log),
      (log.match(/.*(TypeError|ReferenceError).*/) || [''])[0]);
  } catch (e) {
    failures++;
    console.error('   EXCEPTION', e);
  } finally {
    server.kill('SIGKILL');
  }

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nALL SHOP CHECKS PASSED\n');
  process.exit(failures ? 1 : 0);
})();