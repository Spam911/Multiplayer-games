'use strict';
// Account helper shared by the lobby, the admin panel and the games.
// The session lives in an HttpOnly cookie, so there is no token in JS to steal
// and the same cookie rides along on the WebSocket upgrade. That is how the
// game servers know who is playing.

const Account = {
  user: null,
  admin: false,

  async load() {
    try {
      const r = await fetch('/api/auth/me', { cache: 'no-store' });
      const d = await r.json();
      this.user = d.user || null;
      this.admin = !!d.admin;
    } catch { this.user = null; this.admin = false; }
    return this.user;
  },

  async register(name, password) {
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    return { ok: r.ok, ...(await r.json()) };
  },

  async login(name, password) {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    const d = await r.json();
    if (r.ok) { await this.load(); }
    return { ok: r.ok, ...d };
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    this.user = null;
    this.admin = false;
    Account.applyNickname();
  },

  // Settings are saved server side for accounts (survive a new browser) and in
  // localStorage for guests (survive a refresh).
  async saveSetting(key, value) {
    localStorage.setItem('set:' + key, JSON.stringify(value));
    if (this.user) {
      try {
        const r = await fetch('/api/auth/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: value }),
        });
        if (r.ok) this.user = (await r.json()).user || this.user;
      } catch {}
    }
  },

  setting(key, fallback) {
    const cloud = this.user && this.user.settings ? this.user.settings[key] : undefined;
    if (cloud !== undefined) return cloud;
    try {
      const raw = localStorage.getItem('set:' + key);
      if (raw !== null) return JSON.parse(raw);
    } catch {}
    return fallback;
  },

  // The account name always wins over the guest nickname.
  nickname(fallback = '') {
    if (this.user) return this.user.name;
    return (localStorage.getItem('nickname') || fallback).trim().slice(0, 16);
  },

  applyNickname() {
    if (this.user) localStorage.setItem('nickname', this.user.name);
  },

  xp: () => (Account.user ? Account.user.xp : 0),
  level: () => (Account.user ? Account.user.level : 1),
  tokens: () => (Account.user ? Account.user.tokens : 0),

  levelInfo() {
    const u = Account.user;
    if (!u) return null;
    return { level: u.level, progress: u.levelProgress, needed: u.levelNeeded };
  },

  // Small floating "+XP / +tokens" popup used by the games after a round.
  rewardToast(r) {
    if (!r || document.querySelector('.acct-toast')) return;
    const el = document.createElement('div');
    el.className = 'acct-toast';
    el.textContent = `+${r.xp} XP  +${r.tokens} ⛁  ·  level ${r.level}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  },

  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { ok: r.ok, ...(await r.json()) };
  },
};

if (typeof window !== 'undefined') window.Account = Account;
if (typeof module !== 'undefined') module.exports = Account;
