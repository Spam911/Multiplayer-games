'use strict';
// Accounts: registration, admin validation, XP, tokens and cross-game ranking.
//
// Deliberately dependency free: everything lives in one JSON file under
// data/accounts.json. Passwords are scrypt hashed with a per-user salt and
// sessions are HMAC signed cookies, so no session table has to be kept.
//
// XP curve: reaching level N needs 100 * N * (N - 1) / 2 total XP
// (level 2 at 100, level 3 at 300, level 4 at 600 ...). Tunable in one place.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.ARCADE_DATA || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const SECRET_FILE = path.join(DATA_DIR, 'session.key');

// The owner of the arcade. Seeded on first boot, validated and playable.
const ADMIN_NAME = process.env.ADMIN_NAME || 'Matakara';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Games123';

const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 days
const SESSION_COOKIE = 'sid';
const XP_STEP = 100;                          // xp needed per level step

// ---------- persistence ----------

function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE); }
  catch {}
  const secret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  } catch (e) { console.warn('accounts: cannot persist session key:', e.message); }
  return secret;
}
const SECRET = loadSecret();

const db = { users: {} };     // name.toLowerCase() -> user record
const byId = new Map();       // user id -> user record (sessions resolve through this)
let saveTimer = null;

let dirty = false;

function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);   // atomic: never leave a half-written db behind
    dirty = false;
  } catch (e) { console.warn('accounts: save failed:', e.message); }
}

// Writes are debounced so a busy match does not hit the disk every tick.
function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; if (dirty) writeNow(); }, 250);
}

// A restart (or a deploy) must never take the last few seconds of progress
// with it, so anything still pending is written out synchronously on exit.
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) writeNow();
}
process.on('exit', flush);
// Signals do not run the exit handler by default, so flush and then exit.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { flush(); process.exit(0); });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (raw && typeof raw.users === 'object') db.users = raw.users;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('accounts: cannot read db:', e.message);
  }
  reindex();
}

// Sessions are looked up by id, so keep an id index next to the name-keyed store.
function reindex() {
  byId.clear();
  for (const u of Object.values(db.users)) if (u && u.id) byId.set(u.id, u);
}

// ---------- password hashing ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const got = crypto.scryptSync(password, user.salt, 32);
  const want = Buffer.from(user.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- sessions (signed cookie, no server side table) ----------

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeSession(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_TTL })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readSession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.e || data.e < Date.now()) return null;
    return byId.get(data.u) || null;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- users ----------

function users() { return db.users; }

function publicUser(u) {
  if (!u) return null;
  const level = levelFromXp(u.xp);
  const start = xpForLevel(level);
  return {
    name: u.name,
    role: u.role,
    status: u.status,
    xp: u.xp,
    level,
    levelProgress: u.xp - start,
    levelNeeded: xpForLevel(level + 1) - start,
    tokens: u.tokens,
    games: u.games,
    settings: u.settings,
    inventory: u.inventory,
    created: u.created,
    lastSeen: u.lastSeen,
  };
}

const validName = n => /^[a-zA-Z0-9_-]{3,16}$/.test(n);
const validPassword = p => typeof p === 'string' && p.length >= 6 && p.length <= 72;

function findUser(name) {
  return users()[String(name || '').toLowerCase()] || null;
}

function createUser(name, password, role = 'player', status = 'pending') {
  const key = name.toLowerCase();
  const { salt, hash } = hashPassword(password);
  const u = {
    id: crypto.randomBytes(9).toString('hex'),
    name, role, status,
    salt, hash,
    xp: 0, tokens: 0,
    games: {},
    settings: {},
    inventory: {},
    created: Date.now(),
    lastSeen: Date.now(),
  };
  users()[key] = u;
  byId.set(u.id, u);
  save();
  return u;
}

// ---------- XP curve ----------

function xpForLevel(level) { return XP_STEP * (level - 1) * level / 2; }
function levelFromXp(xp) { return Math.floor((Math.sqrt(1 + 8 * xp / XP_STEP) - 1) / 2) + 1; }

// ---------- rate limiting (per IP, in memory) ----------

const attempts = new Map();
function tooManyTries(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.until < now) { attempts.set(key, { n: 1, until: now + windowMs }); return false; }
  if (++rec.n > max) return true;
  return false;
}
function clearTries(key) { attempts.delete(key); }

// ---------- API ----------

const api = {
  SESSION_COOKIE,
  SESSION_TTL,

  // Creates a pending account. It cannot be used until an admin validates it,
  // but the player can keep playing as a guest in the meantime.
  register(name, password, ip) {
    name = String(name || '').trim();
    if (!validName(name)) return { error: 'Name must be 3-16 characters (letters, numbers, _ or -)' };
    if (!validPassword(password)) return { error: 'Password must be at least 6 characters' };
    // Generous enough for a shared IP (school, mobile carrier, CGNAT) but still
    // stops mass sign ups. Rejected attempts count too, which is what makes it
    // useful against someone probing for free names.
    if (tooManyTries('reg:' + ip, 10, 60 * 60 * 1000)) return { error: 'Too many sign ups from this network, try again later' };
    if (findUser(name)) return { error: 'That name is taken' };
    const isAdmin = name.toLowerCase() === ADMIN_NAME.toLowerCase();
    if (isAdmin && password !== ADMIN_PASSWORD) return { error: 'That name is reserved' };
    const u = createUser(name, password, isAdmin ? 'admin' : 'player', 'pending');
    return { user: publicUser(u) };
  },

  login(name, password, ip) {
    name = String(name || '').trim();
    const key = 'login:' + ip + ':' + name.toLowerCase();
    if (tooManyTries(key, 10, 15 * 60 * 1000)) return { error: 'Too many attempts, try again later' };
    const u = findUser(name);
    // Same message either way so the endpoint cannot be used to probe names.
    if (!verifyPassword(String(password || ''), u)) {
      return { error: 'Wrong name or password' };
    }
    clearTries(key);
    if (u.status === 'pending') return { error: 'pending', user: publicUser(u) };
    if (u.status === 'rejected') return { error: 'rejected', user: publicUser(u) };
    u.lastSeen = Date.now();
    save();
    return { token: makeSession(u.id), user: publicUser(u) };
  },

  userFromToken(token) {
    const u = readSession(token);
    if (u) { u.lastSeen = Date.now(); }
    return u;
  },

  userFromRequest(req) {
    return api.userFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  },

  sessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
  },
  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  },

  // Only active (validated) accounts collect XP, tokens and saved settings.
  isPlayable(u) { return !!u && u.status === 'active'; },
  isAdmin(u) { return !!u && u.role === 'admin'; },

  publicUser,

  setSettings(u, patch) {
    if (!api.isPlayable(u) || !patch || typeof patch !== 'object') return publicUser(u);
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(k)) continue;
      if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 64)) {
        u.settings[k] = v;
      }
    }
    save();
    return publicUser(u);
  },

  // Called by the games when a round ends. xp/tokens are clamped so a buggy
  // game can never hand out an absurd amount.
  award(u, gameId, { xp = 0, tokens = 0, win = false, plays = 1 } = {}) {
    if (!api.isPlayable(u) || !/^[a-z0-9_-]{1,32}$/.test(String(gameId))) return null;
    const g = u.games[gameId] || (u.games[gameId] = { xp: 0, plays: 0, wins: 0, tokens: 0, best: 0 });
    const gainedXp = Math.max(0, Math.min(100000, Math.round(xp || 0)));
    const gainedTokens = Math.max(0, Math.min(10000, Math.round(tokens || 0)));
    const wins = win ? 1 : 0;
    g.plays += Math.max(0, Math.min(100, plays | 0));
    g.wins += wins;
    g.xp += gainedXp;
    g.tokens += gainedTokens;
    g.best = Math.max(g.best, gainedXp);
    u.xp += gainedXp;
    u.tokens += gainedTokens;
    u.lastSeen = Date.now();
    save();
    return { xp: u.xp, gainedXp, tokens: u.tokens, gainedTokens, level: levelFromXp(u.xp), user: publicUser(u) };
  },

  spendTokens(u, gameId, itemId, cost) {
    if (!api.isPlayable(u)) return { error: 'Account not validated' };
    if (u.tokens < cost) return { error: 'Not enough tokens' };
    u.tokens -= cost;
    const bag = u.inventory[gameId] || (u.inventory[gameId] = {});
    bag[itemId] = (bag[itemId] || 0) + 1;
    save();
    return { tokens: u.tokens, inventory: u.inventory };
  },

  // ---------- leaderboard ----------

  leaderboard(limit = 25) {
    return Object.values(users())
      .filter(u => u.status === 'active')
      .sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((u, i) => ({
        rank: i + 1,
        name: u.name,
        xp: u.xp,
        level: levelFromXp(u.xp),
        tokens: u.tokens,
        admin: u.role === 'admin',
        games: u.games,
      }));
  },

  // ---------- admin ----------

  adminList(status) {
    return Object.values(users())
      .filter(u => !status || status === 'all' || u.status === status)
      .sort((a, b) => b.created - a.created)
      .map(publicUser);
  },

  setStatus(actor, name, status) {
    if (!api.isAdmin(actor)) return { error: 'Admin only' };
    const u = findUser(name);
    if (!u) return { error: 'No such account' };
    if (!['pending', 'active', 'rejected'].includes(status)) return { error: 'Unknown status' };
    if (u.id === actor.id) return { error: 'You cannot change your own status' };
    u.status = status;
    save();
    return { user: publicUser(u) };
  },

  grant(actor, name, { xp = 0, tokens = 0 } = {}) {
    if (!api.isAdmin(actor)) return { error: 'Admin only' };
    const u = findUser(name);
    if (!u) return { error: 'No such account' };
    u.xp = Math.max(0, u.xp + Math.round(xp || 0));
    u.tokens = Math.max(0, u.tokens + Math.round(tokens || 0));
    save();
    return { user: publicUser(u) };
  },

  remove(actor, name) {
    if (!api.isAdmin(actor)) return { error: 'Admin only' };
    const u = findUser(name);
    if (!u) return { error: 'No such account' };
    if (u.id === actor.id) return { error: 'You cannot delete your own account' };
    delete users()[u.name.toLowerCase()];
    byId.delete(u.id);
    save();
    return { ok: true };
  },

  stats() {
    const all = Object.values(users());
    return {
      total: all.length,
      pending: all.filter(u => u.status === 'pending').length,
      active: all.filter(u => u.status === 'active').length,
      rejected: all.filter(u => u.status === 'rejected').length,
    };
  },
};

function bootstrap() {
  load();
  const key = ADMIN_NAME.toLowerCase();
  const existing = db.users[key];
  if (!existing) {
    createUser(ADMIN_NAME, ADMIN_PASSWORD, 'admin', 'active');
    console.log(`accounts: seeded admin "${ADMIN_NAME}"`);
  } else {
    // The owner is always allowed in, even if someone edited the file.
    let changed = false;
    if (existing.role !== 'admin') { existing.role = 'admin'; changed = true; }
    if (existing.status !== 'active') { existing.status = 'active'; changed = true; }
    if (changed) save();
  }
}

module.exports = { ...api, bootstrap, levelFromXp, xpForLevel, XP_STEP };

bootstrap();
