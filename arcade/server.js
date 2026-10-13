'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const catalog = require('./games');
const accounts = require('./lib/accounts');
const shop = require('./lib/shop');
const { ok, bad, readJson, clientIp } = require('./lib/http');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

// One WebSocketServer per live game, reachable at /ws/<id>
const live = new Map();
for (const g of catalog) {
  if (g.status !== 'live') continue;
  const wss = new WebSocketServer({ noServer: true, maxPayload: g.maxPayload || 1024 });
  require(path.join(__dirname, 'games', g.module))(wss);
  live.set(g.id, wss);
}

function gamesInfo() {
  const games = catalog.map(g => ({
    id: g.id, title: g.title, emoji: g.emoji, description: g.description, status: g.status,
    online: live.has(g.id) ? live.get(g.id).clients.size : 0,
  }));
  // One person in two games counts once: dedupe the sockets by identity, with
  // every unsigned connection lumped together as "guest".
  const online = new Set();
  for (const wss of live.values()) for (const ws of wss.clients) online.add(ws.playerId || 'guest');
  const guests = [...online].filter(id => id === 'guest').length;
  return {
    games,
    total: games.reduce((n, g) => n + g.online, 0),
    playersOnline: online.size,
    accounts: online.size - guests,
  };
}

// ---------- account API ----------
// Guests never touch these. An account is only usable once an admin validated
// it; until then the player keeps playing as a guest everywhere.

async function accountsApi(req, res, url) {
  const me = accounts.userFromRequest(req);

  if (url === '/api/auth/me' && req.method === 'GET') {
    return ok(res, { user: accounts.isPlayable(me) ? accounts.publicUser(me) : null, admin: accounts.isAdmin(me) });
  }

  if (url === '/api/auth/register' && req.method === 'POST') {
    const b = await readJson(req);
    const r = accounts.register(b.name, b.password, clientIp(req));
    if (r.error) return bad(res, 400, r.error);
    return ok(res, { user: r.user, pending: true });
  }

  if (url === '/api/auth/login' && req.method === 'POST') {
    const b = await readJson(req);
    const r = accounts.login(b.name, b.password, clientIp(req));
    if (r.error === 'pending') return bad(res, 403, 'Your account is still waiting for admin validation');
    if (r.error === 'rejected') return bad(res, 403, 'Your account was rejected by the admin');
    if (r.error) return bad(res, 401, r.error);
    return ok(res, { user: r.user, admin: r.user.role === 'admin' }, { 'Set-Cookie': accounts.sessionCookie(r.token) });
  }

  if (url === '/api/auth/logout' && req.method === 'POST') {
    return ok(res, { ok: true }, { 'Set-Cookie': accounts.clearCookie() });
  }

  if (url === '/api/auth/settings' && req.method === 'POST') {
    if (!me) return bad(res, 401, 'Not signed in');
    const b = await readJson(req);
    return ok(res, { user: accounts.setSettings(me, b) });
  }

  // ---------- shop ----------
  // Guests get the catalogue and a view of the shop with nothing owned, so the
  // UI can render and explain that signing in is what unlocks buying. Buying and
  // equipping require a validated account and are priced server side.
  if (url === '/api/shop' && req.method === 'GET') {
    return ok(res, { catalogue: shop.catalogue(), shop: accounts.shopState(me) });
  }

  if (url === '/api/shop/buy' && req.method === 'POST') {
    if (!me) return bad(res, 401, 'Sign in to buy');
    const b = await readJson(req);
    const r = accounts.buy(me, String(b.game || ''), String(b.cat || ''), String(b.id || ''));
    if (r.error) return bad(res, 400, r.error);
    return ok(res, { bought: r.item, shop: r.shop, user: r.user });
  }

  if (url === '/api/shop/equip' && req.method === 'POST') {
    if (!me) return bad(res, 401, 'Sign in to equip');
    const b = await readJson(req);
    const r = accounts.equip(me, String(b.game || ''), String(b.cat || ''), String(b.id || ''));
    if (r.error) return bad(res, 400, r.error);
    return ok(res, { equipped: r.item, shop: r.shop, user: r.user });
  }

  if (url === '/api/leaderboard' && req.method === 'GET') {
    return ok(res, { leaderboard: accounts.leaderboard(50), me: accounts.isPlayable(me) ? accounts.publicUser(me) : null });
  }

  if (url === '/api/games/summary' && req.method === 'GET') {
    // Per game XP/leaderboards, built from the catalog so new games show up.
    const rows = catalog.filter(g => g.status === 'live').map(g => ({
      id: g.id, title: g.title, emoji: g.emoji,
      top: accounts.leaderboard(200)
        .filter(e => e.games[g.id])
        .sort((a, b) => b.games[g.id].xp - a.games[g.id].xp)
        .slice(0, 10)
        .map(e => ({ name: e.name, xp: e.games[g.id].xp, wins: e.games[g.id].wins, plays: e.games[g.id].plays })),
    }));
    return ok(res, { games: rows });
  }

  // ---- admin only ----
  if (url.startsWith('/api/admin/')) {
    if (!accounts.isAdmin(me)) return bad(res, 403, 'Admin only');
    if (url === '/api/admin/pending' && req.method === 'GET') {
      return ok(res, { users: accounts.adminList('pending'), stats: accounts.stats() });
    }
    if (url === '/api/admin/users' && req.method === 'GET') {
      return ok(res, { users: accounts.adminList('all'), stats: accounts.stats() });
    }
    const m = /^\/api\/admin\/user\/([^/]+)$/.exec(url);
    if (m && req.method === 'POST') {
      const b = await readJson(req);
      const name = decodeURIComponent(m[1]);
      let r;
      if (b.action === 'validate') r = accounts.setStatus(me, name, 'active');
      else if (b.action === 'reject') r = accounts.setStatus(me, name, 'rejected');
      else if (b.action === 'pending') r = accounts.setStatus(me, name, 'pending');
      else if (b.action === 'grant') r = accounts.grant(me, name, { xp: b.xp, tokens: b.tokens });
      else if (b.action === 'delete') r = accounts.remove(me, name);
      else return bad(res, 400, 'Unknown action');
      if (r.error) return bad(res, 400, r.error);
      return ok(res, r);
    }
  }
  return bad(res, 404, 'Not found');
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('bad request'); }
  let file = path.resolve(PUBLIC, '.' + pathname);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/api/games') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(gamesInfo()));
  }
  if (url.startsWith('/api/')) {
    accountsApi(req, res, url).catch(() => { try { bad(res, 500, 'Server error'); } catch {} });
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
  const m = /^\/ws\/([a-z0-9_-]+)$/.exec(pathname);
  const wss = m && live.get(m[1]);
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Identity travels with the socket: a validated account keeps its name,
    // XP and saved settings, everyone else is just a guest.
    const u = accounts.userFromRequest(req);
    ws.account = accounts.isPlayable(u) ? u : null;
    ws.playerId = ws.account ? ws.account.id : 'guest';
    wss.emit('connection', ws, req);
  });
});

// drop dead connections so online counts stay honest
setInterval(() => {
  for (const wss of live.values()) {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, () => console.log(`Arcade server on :${PORT} (games: ${[...live.keys()].join(', ')})`));
