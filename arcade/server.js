'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const catalog = require('./games');

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
  return { games, total: games.reduce((n, g) => n + g.online, 0) };
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
