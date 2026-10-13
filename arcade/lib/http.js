'use strict';
// Small helpers shared by the account API routes in server.js.

function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Always carries ok:true so clients can rely on it alongside the payload.
const ok = (res, body, headers) => json(res, 200, { ok: true, ...(body || {}) }, headers);
const bad = (res, code, error) => json(res, code, { error });

// Reads a small JSON body, refusing anything unreasonably large.
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

module.exports = { json, ok, bad, readJson, clientIp };
