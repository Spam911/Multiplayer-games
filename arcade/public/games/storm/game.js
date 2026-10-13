'use strict';
// Storm Royale - client.
// The server is authoritative. This file predicts our own movement so aiming
// feels instant, renders everyone else from interpolated snapshots, and ships
// input at ~30 Hz.

const $ = id => document.getElementById(id);
const cv = $('g'), c = cv.getContext('2d'), m2 = $('mm').getContext('2d');
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Must mirror the server's WP table (name/glyph/muzzle geometry/colour).
const WP = [
  { n: 'Pistol', g: 'P', len: 30, x0: 10, c: '#9ca3af' },
  { n: 'Assault Rifle', g: 'R', len: 46, x0: 2, c: '#3b82f6' },
  { n: 'Shotgun', g: 'G', len: 49, x0: 2, c: '#f97316' },
  { n: 'Sniper', g: 'N', len: 59, x0: 0, c: '#a855f7' },
];
// Storm phase hold/shrink durations. The server sends the authoritative table
// with the world payload, so the HUD countdown can never drift from the sim.
let PH = [];
const COLS = ['#ef4444', '#f97316', '#a3e635', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#e5e7eb'];
const SPEED = 200;   // human px/s, mirrors the server
const WORLD = 3200;
const RAD = 14;      // player radius
// Island radius function, used for the animated foam ring and the shore line.
const isL = a => 1330 + 90 * Math.sin(3 * a + 1.3) + 55 * Math.sin(5 * a + .4)
  + 40 * Math.sin(7 * a + 2.1) + 22 * Math.sin(11 * a + .9);
const esc = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));

// ---------------------------------------------------------------------------
// Audio: a small WebAudio synth ported from the single-player build, so the
// game ships without any audio assets. Everything is mixed through two gain
// buses into a compressor; world sounds attenuate with distance from us.
// ---------------------------------------------------------------------------
const AU = (() => {
  let ctx = null, sfxBus, musBus, noiseBuf, music = null, musicTimer = null, voices = 0, lastImpact = 0, counting = true;
  const on = { sfx: true, mus: true };
  try {
    const s = JSON.parse(localStorage.getItem('sr_audio') || '{}');
    if (s.sfx === false) on.sfx = false;
    if (s.mus === false) on.mus = false;
  } catch (e) {}
  // Accounts keep their audio prefs across browsers.
  if (Account.user && Account.user.settings) {
    if (typeof Account.user.settings.audioSfx === 'boolean') on.sfx = Account.user.settings.audioSfx;
    if (typeof Account.user.settings.audioMus === 'boolean') on.mus = Account.user.settings.audioMus;
  }
  const persist = () => {
    try { localStorage.setItem('sr_audio', JSON.stringify(on)); } catch (e) {}
    Account.saveSetting('audioSfx', on.sfx);
    Account.saveSetting('audioMus', on.mus);
  };
  const note = m => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    if (ctx) return true;
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return false;
    try { ctx = new A(); } catch (e) { return false; }
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = .8; sfxBus.connect(comp);
    musBus = ctx.createGain(); musBus.gain.value = .5; musBus.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }
  const live = () => ctx && on.sfx && ctx.state === 'running';
  const watch = n => { if (counting) { voices++; n.onended = () => voices--; } };
  const overlayOpen = () => !$('ov').hidden;

  function panned(side) {
    if (!side || !ctx.createStereoPanner) return sfxBus;
    const n = ctx.createStereoPanner();
    n.pan.value = clamp(side, -1, 1);
    n.connect(sfxBus);
    return n;
  }
  // Inverse-square-ish falloff for a world point; [0,0] means inaudible.
  function near(x, y, range) {
    if (x === undefined || !self) return [1, 0];
    const dx = x - self.px, dy = y - self.py, d = Math.hypot(dx, dy);
    if (d >= range) return [0, 0];
    const k = 1 - d / range;
    return [k * k, clamp(dx / 450, -1, 1)];
  }

  function tone(type, f0, f1, t, dur, vol, dest) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + .03);
    watch(o);
  }
  function noise(t, dur, vol, type, f0, f1, q, dest) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true;
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(.001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + .03);
    watch(s);
  }
  function swell(type, f, t, dur, vol, dest, glide) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.linearRampToValueAtTime(glide, t + dur);
    g.gain.setValueAtTime(.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + .012);
    g.gain.setValueAtTime(vol, t + Math.max(.013, dur * .6));
    g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + .03);
    watch(o);
  }
  const lowpass = (f, dest) => { const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; b.connect(dest); return b; };

  function shot(i, x, y, mine) {
    if (!live() || voices > 40) return;
    const [v, side] = mine ? [1, 0] : near(x, y, 1100);
    if (v < .04) return;
    const t = ctx.currentTime, d = panned(side), m = v * (mine ? 1 : .8);
    if (i === 0) { noise(t, .09, .5 * m, 'bandpass', 2500, 900, .8, d); tone('square', 520, 90, t, .09, .25 * m, d); }
    else if (i === 1) { noise(t, .07, .45 * m, 'bandpass', 3200, 1200, .7, d); tone('sawtooth', 380, 80, t, .07, .22 * m, d); }
    else if (i === 2) { noise(t, .28, .9 * m, 'lowpass', 3500, 300, .5, d); tone('sine', 140, 40, t, .22, .7 * m, d); noise(t + .02, .12, .4 * m, 'highpass', 1500, 1500, .5, d); }
    else {
      noise(t, .5, .9 * m, 'lowpass', 5000, 200, .4, d); tone('sine', 110, 30, t, .45, .9 * m, d);
      noise(t, .05, .7 * m, 'highpass', 3000, 3000, .5, d); tone('triangle', 1800, 300, t, .12, .25 * m, d);
      noise(t + .2, .4, .22 * m, 'lowpass', 1500, 200, .4, d);
    }
  }
  function impact(x, y, mine, shielded, dealt) {
    if (!live() || voices > 45) return;
    const t = ctx.currentTime;
    if (dealt) { tone('square', 1300, 900, t, .05, .16, sfxBus); return; }
    if (mine) {
      if (shielded) tone('sine', 1500, 900, t, .18, .3, sfxBus);
      tone('sine', 170, 55, t, .14, .7, sfxBus);
      noise(t, .08, .35, 'lowpass', 900, 300, .6, sfxBus);
      return;
    }
    const [v, side] = near(x, y, 800);
    if (v < .05) return;
    const d = panned(side);
    if (shielded) tone('sine', 1500, 900, t, .15, .25 * v, d);
    noise(t, .05, .35 * v, 'bandpass', 1800, 900, .8, d);
    tone('triangle', 260, 120, t, .07, .3 * v, d);
  }
  function death(x, y, mine) {
    if (!live()) return;
    const [v, side] = mine ? [1, 0] : near(x, y, 900);
    if (v < .05) return;
    const t = ctx.currentTime, d = panned(side);
    const base = mine ? 200 : 150 + Math.random() * 90, vol = .55 * v;
    const o = ctx.createOscillator(), g = ctx.createGain(), b1 = ctx.createBiquadFilter(), b2 = ctx.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base * 1.2, t);
    o.frequency.exponentialRampToValueAtTime(base * .6, t + .34);
    b1.type = b2.type = 'bandpass'; b1.Q.value = 5; b2.Q.value = 7;
    b1.frequency.setValueAtTime(700, t); b1.frequency.exponentialRampToValueAtTime(420, t + .3);
    b2.frequency.setValueAtTime(1100, t); b2.frequency.exponentialRampToValueAtTime(800, t + .3);
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(vol, t + .03);
    g.gain.setValueAtTime(vol, t + .12); g.gain.exponentialRampToValueAtTime(.001, t + .36);
    o.connect(b1); o.connect(b2); b1.connect(g); b2.connect(g); g.connect(d);
    o.start(t); o.stop(t + .4); watch(o);
    noise(t + .22, .14, .22 * v, 'highpass', 3500, 3500, .5, d);
  }
  function loot(kind) {
    if (!live()) return;
    const t = ctx.currentTime, d = sfxBus;
    if (kind === 'w') { noise(t, .03, .3, 'highpass', 2500, 2500, .5, d); swell('square', note(60), t, .07, .12, d); swell('square', note(72), t + .07, .1, .12, d); }
    else if (kind === 'h') { swell('sine', note(76), t, .12, .22, d); swell('sine', note(83), t + .09, .2, .22, d); }
    else if (kind === 's') { swell('triangle', note(81), t, .12, .2, d); swell('triangle', note(88), t + .08, .25, .2, d); }
    else if (kind === 'c') { [67, 72, 76].forEach((n, i) => swell('square', note(n), t + i * .08, .1, .12, d)); noise(t, .1, .2, 'lowpass', 900, 400, .6, d); }
    else { tone('triangle', 520, 380, t, .07, .25, d); noise(t, .05, .2, 'bandpass', 900, 500, .8, d); }
  }
  function worldFx(kind, x, y) {
    if (!live()) return;
    const t = ctx.currentTime;
    if (kind === 'swap') { noise(t, .03, .3, 'highpass', 2500, 2500, .5, sfxBus); return tone('square', 240, 160, t, .06, .15, sfxBus); }
    if (kind === 'storm') { const f = lowpass(700, sfxBus); swell('sawtooth', 196, t, .9, .35, f); swell('square', 147, t + .55, 1.1, .3, f); return; }
    const [v, side] = near(x, y, 900);
    if (v < .05 || voices > 45) return;
    const d = panned(side);
    if (kind === 'wall') {
      const now = performance.now();
      if (now - lastImpact < 45) return;
      lastImpact = now;
      noise(t, .07, .4 * v, 'bandpass', 700, 300, .9, d); tone('triangle', 200, 110, t, .06, .25 * v, d);
    } else if (kind === 'build') {
      noise(t, .1, .5 * v, 'lowpass', 700, 300, .7, d);
      tone('square', 190, 90, t, .1, .3 * v, d); tone('square', 160, 80, t + .07, .09, .2 * v, d);
    } else if (kind === 'break') {
      noise(t, .38, .8 * v, 'lowpass', 2500, 200, .6, d); tone('sawtooth', 130, 40, t, .28, .3 * v, d);
      noise(t + .05, .1, .4 * v, 'bandpass', 1200, 600, 1, d);
    }
  }
  function click() {
    if (!live()) return;
    const t = ctx.currentTime;
    swell('triangle', 880, t, .05, .22, sfxBus, 620);
    noise(t, .02, .12, 'highpass', 4000, 4000, .5, sfxBus);
  }

  // Menu music: an 8-bar chiptune, scheduled a little ahead of the clock.
  const CHORDS = [{ r: 45, a: [57, 60, 64] }, { r: 41, a: [53, 57, 60] }, { r: 48, a: [55, 60, 64] }, { r: 43, a: [55, 59, 62] },
    { r: 45, a: [57, 60, 64] }, { r: 41, a: [53, 57, 60] }, { r: 43, a: [55, 59, 62] }, { r: 40, a: [52, 56, 59] }];
  const MELODY = [
    [[0, 76, 3], [3, 72, 1], [4, 74, 2], [6, 72, 2], [8, 69, 4], [12, 72, 2], [14, 74, 2]],
    [[0, 77, 3], [3, 74, 1], [4, 72, 2], [6, 74, 2], [8, 69, 4], [12, 72, 2], [14, 69, 2]],
    [[0, 76, 2], [2, 79, 2], [4, 76, 2], [6, 72, 2], [8, 67, 4], [12, 72, 2], [14, 76, 2]],
    [[0, 74, 3], [3, 71, 1], [4, 74, 2], [6, 79, 2], [8, 74, 6], [14, 71, 2]],
    [[0, 81, 3], [3, 79, 1], [4, 76, 2], [6, 72, 2], [8, 76, 4], [12, 79, 2], [14, 76, 2]],
    [[0, 77, 3], [3, 76, 1], [4, 74, 2], [6, 72, 2], [8, 74, 4], [12, 77, 2], [14, 81, 2]],
    [[0, 79, 3], [3, 74, 1], [4, 71, 2], [6, 74, 2], [8, 79, 4], [12, 74, 2], [14, 71, 2]],
    [[0, 76, 4], [4, 80, 2], [6, 76, 2], [8, 71, 2], [10, 76, 2], [12, 80, 4]],
  ];
  function menuLoop() {
    const bus = ctx.createGain(); bus.connect(musBus);
    const lead = lowpass(2800, bus), bass = lowpass(500, bus), STEP = .125;
    let n = 0, t0 = ctx.currentTime + .08;
    const emit = (s, t) => {
      const bar = s >> 4, k = s & 15, ch = CHORDS[bar];
      if (k % 2 === 0) {
        const j = k >> 1;
        swell('sawtooth', note(ch.r + [0, 0, 12, 0, 0, 0, 12, 0][j]), t, STEP * 1.8, .2, bass);
        swell('triangle', note(ch.a[[0, 1, 2, 1, 2, 1, 0, 1][j]]), t, STEP * 1.6, .1, bus);
        noise(t, .035, k % 4 === 2 ? .12 : .07, 'highpass', 7500, 7500, .5, bus);
      }
      if (k % 4 === 0) tone('sine', 160, 45, t, .14, .55, bus);
      if (k === 4 || k === 12) { noise(t, .12, .25, 'bandpass', 1900, 1500, .8, bus); tone('triangle', 220, 140, t, .07, .15, bus); }
      for (const [at, m, len] of MELODY[bar]) if (at === k) swell('square', note(m), t, len * STEP * .95, .07, lead);
    };
    const pump = () => {
      counting = false;
      try { while (t0 < ctx.currentTime + .25) { emit(n % 128, t0); t0 += STEP; n++; } } finally { counting = true; }
    };
    pump();
    return { name: 'menu', bus, iv: setInterval(pump, 50) };
  }
  function jingle(kind) {
    const bus = ctx.createGain(); bus.connect(musBus);
    const lead = lowpass(3000, bus), t = ctx.currentTime + .1;
    let dur;
    counting = false;
    try {
      if (kind === 'win') {
        [[0, 60, .2], [.22, 64, .2], [.44, 67, .2], [.66, 72, .6], [1.35, 67, .2], [1.57, 72, .2], [1.79, 76, .8],
          [2.7, 74, .25], [2.97, 72, .25], [3.24, 74, .25], [3.51, 76, .25], [3.78, 79, 1], [5, 72, 1.9], [5, 76, 1.9], [5, 79, 1.9]]
          .forEach(([at, m, len]) => { swell('sawtooth', note(m), t + at, len, .1, lead); swell('square', note(m + 12), t + at, len, .03, lead); });
        [[0, 36, .6], [.66, 36, .6], [1.35, 41, .4], [1.79, 41, .8], [2.7, 43, .5], [3.24, 43, .5], [3.78, 36, 1], [5, 36, 1.9]]
          .forEach(([at, m, len]) => swell('triangle', note(m), t + at, len, .3, bus));
        [0, .66, 1.79, 3.78, 5].forEach(at => tone('sine', 130, 40, t + at, .3, .6, bus));
        noise(t + 5, 1.3, .18, 'highpass', 5000, 5000, .5, bus);
        dur = 7;
      } else {
        [[0, 62, .55], [.65, 61, .55], [1.3, 60, .55]].forEach(([at, m, len]) => swell('sawtooth', note(m), t + at, len, .1, lead));
        swell('sawtooth', note(59), t + 1.95, 1.9, .1, lead, note(59) * .94);
        [38, 45, 53].forEach(m => swell('triangle', note(m), t, 4.3, .1, bus));
        dur = 4.5;
      }
    } finally { counting = true; }
    return { name: kind, bus, dur };
  }
  function haltMusic() {
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
    if (!music) return;
    const s = music;
    music = null;
    if (s.iv) clearInterval(s.iv);
    try {
      const g = s.bus.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(0, ctx.currentTime + .2);
    } catch (e) {}
    setTimeout(() => { try { s.bus.disconnect(); } catch (e) {} }, 400);
  }
  function menu() { if (!ctx || !on.mus) return; if (music && music.name === 'menu') return; haltMusic(); music = menuLoop(); }
  function finish(kind) {
    haltMusic();
    if (!ctx || !on.mus) return;
    music = jingle(kind);
    musicTimer = setTimeout(() => { musicTimer = null; music = null; if (overlayOpen()) menu(); }, (music.dur + .8) * 1000);
  }
  function unlock() {
    if (!init()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (on.mus && overlayOpen() && !music && !musicTimer) menu();
  }
  document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else ctx.resume(); });

  return {
    on, unlock, shot, impact, death, loot, world: worldFx, click, menu, finish, stop: haltMusic,
    setMusic: v => { on.mus = v; persist(); if (!v) haltMusic(); else if (ctx && overlayOpen()) menu(); },
    setSfx: v => { on.sfx = v; persist(); },
  };
})();

// ---------------------------------------------------------------------------
// networking
// ---------------------------------------------------------------------------
let ws = null, myId = null, socketReady = false;
let world = null, roster = new Map();
const others = new Map();     // id -> render state for other players
let shots = [], lootItems = [], boards = [], stains = [];
let storm = null, aliveCount = 0, clock = 0;
let self = null;              // our own state: x/y authoritative, px/py predicted
let stats = { hp: 100, sh: 0, wp: 0, wood: 30, alive: true, k: 0, inv: [1, 0, 0, 0] };
let outcome = null, standing = null;
// screen: menu | room | playing | dead | results
let screen = 'menu';
let room = null;              // { id, max, status, hostId, you, members[] }
let openRooms = [], online = 0;
let shore = null;             // island outline for the menu backdrop
let shake = 0, hurt = 0, feed = [], hudKey = '';
const FX = [];
const keys = {}, ptr = { x: 0, y: 0, down: false }, sticks = { l: null, r: null };
let aimMode = false, queuedBuild = false, queuedSwap = false;
const touchDevice = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
let cw, ch, zoom, dpr;

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  cw = innerWidth; ch = innerHeight;
  cv.width = cw * dpr; cv.height = ch * dpr;
  zoom = clamp(Math.min(cw, ch) / 700, .6, 1.2);
}
addEventListener('resize', resize); resize();

const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/storm`);
  ws.onopen = () => { socketReady = true; refreshMenu(); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
  ws.onclose = () => {
    socketReady = false; myId = null; world = null; self = null;
    others.clear(); outcome = null; standing = null; room = null;
    setScreen('menu');
    note('Disconnected — reconnecting…');
    setTimeout(connect, 1200);
  };
}
connect();

function onMessage(m) {
  switch (m.t) {
    case 'list':
      openRooms = m.list; online = m.online;
      // The shoreline arrives with the list, so the backdrop has an island even
      // before this client has ever played a match.
      if (m.shore && m.shore.length) shore = m.shore;
      refreshMenu();
      break;
    case 'room':
      room = m;
      if (m.status === 'waiting') setScreen('room');
      renderRoom();
      break;
    case 'entered':
      refreshMenu();
      if (m.account) note(`Playing as <b>${esc(m.account.name)}</b>.`);
      break;
    case 'lobby':
      room = null;
      setScreen('menu');
      break;
    case 'error':
      note(esc(m.msg || 'Something went wrong'));
      if (!room) refreshMenu();
      break;
    case 'world':
      world = m.world;
      myId = m.you;
      PH = (m.world.ph || []).map(p => ({ hold: p.hold, shr: p.shr }));
      // The server owns weapon stats too, so names/colours/muzzle geometry can
      // never drift between the two sides.
      (m.world.wp || []).forEach((w, i) => { if (WP[i]) Object.assign(WP[i], w); });
      $('wp').innerHTML = WP.map(w => `<i style="--c:${w.c}"></i>`).join('');
      hudKey = '';                                        // force the weapon chip to redraw
      // A new match starts from scratch: drop every piece of prior state so we
      // never interpolate from the previous island.
      self = null;
      others.clear();
      shots = []; lootItems = []; boards = []; stains = [];
      storm = null; aliveCount = 0; clock = 0;
      outcome = null; standing = null; feed = []; FX.length = 0;
      renderFeed();
      cacheSolids();
      break;
    case 'roster': roster = new Map(m.list.map(r => [r.id, r])); break;
    case 'start': setScreen('playing'); AU.stop(); break;
    case 's': apply(m); break;
    case 'dead':
      standing = m;
      stats.alive = false;
      setScreen('dead');
      break;
    case 'results': outcome = m; setScreen('results'); AU.finish(m.won ? 'win' : 'lose'); break;
    case 'account': if (m.account) note(`Playing as <b>${esc(m.account.name)}</b>.`); break;
  }
}

function apply(m) {
  const a = m.me;
  stats = { hp: a[3], sh: a[4], wp: a[5], wood: a[6], alive: !!a[7], k: a[8], inv: a[9].split('').map(Number) };

  // Authoritative anchor, plus a predicted point we actually draw.
  if (!self) self = { x: a[0], y: a[1], ang: a[2], rc: 0, px: a[0], py: a[1] };
  self.x = a[0]; self.y = a[1]; self.ang = a[2];

  const seen = new Set();
  for (const q of m.P) {
    const [id, x, y, ang, wp, hp, sh, inb, rc] = q;
    seen.add(id);
    let o = others.get(id);
    if (!o) { o = { id, x, y, ang, wp, hp, sh, inb, rc, px: x, py: y }; others.set(id, o); }
    o.x = x; o.y = y; o.ang = ang; o.wp = wp; o.hp = hp; o.sh = sh; o.inb = inb; o.rc = rc;
  }
  for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);

  shots = m.B.map(b => ({ id: b[0], x: b[1], y: b[2], vx: b[3], vy: b[4], px: b[1], py: b[2] }));
  lootItems = m.L.map(l => ({ x: l[0], y: l[1], k: l[2], i: l[3], n: l[4] }));
  boards = m.W.map(w => ({ id: w[0], x: w[1], y: w[2], w: w[3], h: w[4], hp: w[5] }));
  stains = m.S.map(s => ({ x: s[1], y: s[2], r: s[3], col: COLS[s[4]] || '#f87171', d: blob(s[5]) }));
  storm = { x: m.st[0], y: m.st[1], r: m.st[2], tx: m.st[3], ty: m.st[4], tr: m.st[5], ph: m.st[6], t: m.st[7], closing: !!m.st[8] };
  aliveCount = m.n;
  clock = m.tm;
  if (m.feed && m.feed.length) { feed = m.feed.slice(); renderFeed(); }
  if (m.ev && m.ev.length) playEvents(m.ev);
  updateHud();
}

// Deterministic splatter layout, rebuilt from the per-splat seed.
function blob(seed) {
  let s = (seed || 1) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = [];
  for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
    const a = rnd() * TAU, r = 8 + rnd() * 10;
    out.push([Math.cos(a) * r, Math.sin(a) * r, 2 + rnd() * 2.5]);
  }
  return out;
}

// Server events: each is tagged so a client only reacts to what concerns it.
function playEvents(evs) {
  for (const ev of evs) {
    switch (ev.e) {
      case 0: AU.shot(ev.w, ev.x, ev.y, !!ev.m); break;                        // gunshot
      case 1: if (ev.to === myId) { AU.impact(0, 0, true, stats.sh > 0, false); shake = Math.max(shake, 9); hurt = .6; } break;
      case 2: if (ev.by === myId) { AU.impact(ev.at[0], ev.at[1], false, false, true); pop(ev.at[0], ev.at[1], ev.d, '#fde047'); } break;
      case 3: AU.world('storm'); break;                                        // storm is closing
      case 4: toast(WP[ev.i] ? WP[ev.i].n : ''); break;                       // we swapped guns
      case 5: AU.world('build', self ? self.px : 0, self ? self.py : 0); break;
      case 6: case 7: AU.world('wall', ev.x, ev.y); break;                    // bullet hit scenery
      case 8: AU.death(ev.x, ev.y, false); break;                              // someone died
      case 9:                                                                        // we picked something up
        if (ev.to !== myId) break;
        AU.loot(ev.k);
        if (ev.k === 'c') toast('📦 Chest opened');
        else if (ev.k === 'h') toast('+ Health');
        else if (ev.k === 's') toast('+ Shield');
        else if (ev.k === 'o') toast('+ Wood');
        break;
      case 11: if (ev.to === myId) toast('🔫 ' + (WP[ev.i] ? WP[ev.i].n : '')); break;
      case 12: AU.world('break', ev.x, ev.y); break;                          // a wall crumbled
    }
  }
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.style.opacity = 0; }, 1500);
}
function pop(x, y, value, col) { FX.push({ x, y, l: .8, vy: -45, text: value, col }); }
function renderFeed() { $('feed').innerHTML = feed.map(f => `<div>${esc(f)}</div>`).join(''); }
// Notes show on whichever overlay panel is up.
const note = html => { $('st1').innerHTML = html; $('est1').innerHTML = html; };

function stepFx(dt) {
  for (let i = FX.length - 1; i >= 0; i--) {
    const f = FX[i];
    f.l -= dt; f.y += f.vy * dt;
    if (f.l <= 0) FX.splice(i, 1);
  }
  shake *= Math.pow(.01, dt);
  hurt = Math.max(0, hurt - dt * 1.6);
}

// ---------------------------------------------------------------------------
// local prediction + collision (mirrors the server's push())
// ---------------------------------------------------------------------------
// Permanent walls are static for a match, so flatten them once instead of
// re-allocating an array on every prediction step.
let solidsCache = [];
function cacheSolids() {
  solidsCache = world ? world.pw.map(w => ({ x: w[0], y: w[1], w: w[2], h: w[3] })) : [];
}

// Push a circle out of an axis-aligned box. Returns [x, y].
function pushOut(px, py, w) {
  const qx = clamp(px, w.x, w.x + w.w), qy = clamp(py, w.y, w.y + w.h);
  const dx = px - qx, dy = py - qy, d = Math.hypot(dx, dy);
  if (d >= RAD) return [px, py];
  if (d <= 0) return [px + RAD * 2, py];
  return [qx + dx / d * RAD, qy + dy / d * RAD];
}

function collide(px, py) {
  if (!world) return [px, py];
  for (const t of world.trees) {
    const dx = px - t[0], dy = py - t[1], m = RAD + t[2], d = Math.hypot(dx, dy);
    if (d < m && d > 0) { px = t[0] + dx / d * m; py = t[1] + dy / d * m; }
  }
  for (let i = 0; i < solidsCache.length; i++) [px, py] = pushOut(px, py, solidsCache[i]);
  for (let i = 0; i < boards.length; i++) [px, py] = pushOut(px, py, boards[i]);
  px = clamp(px, RAD, WORLD - RAD);
  py = clamp(py, RAD, WORLD - RAD);
  const dx = px - 1600, dy = py - 1600, d = Math.hypot(dx, dy);
  const l = isL(Math.atan2(dy, dx)) - RAD - 20;
  if (d > l && d > 0) { px = 1600 + dx / d * l; py = 1600 + dy / d * l; }
  return [px, py];
}

function predict(dt, mx, my) {
  if (!self || !stats.alive) return;
  const m = Math.hypot(mx, my);
  const nx = m > 1 ? mx / m : mx, ny = m > 1 ? my / m : my;
  const [cx, cy] = collide(self.px + nx * SPEED * dt, self.py + ny * SPEED * dt);
  self.px = cx; self.py = cy;
  // Reconcile gently toward the server, or snap if we have drifted badly
  // (storm shove, a wall we mis-predicted, a long stall).
  const ex = self.x - self.px, ey = self.y - self.py, err = Math.hypot(ex, ey);
  if (err > 140) { self.px = self.x; self.py = self.y; }
  else { self.px += ex * Math.min(1, dt * 7); self.py += ey * Math.min(1, dt * 7); }
  self.rc = Math.max(0, self.rc - dt * 9);
}

// A dead or late-joining player has no body to follow, so drift the camera
// toward the storm centre: as the circle closes, that is where the fight is.
function spectateStep(dt) {
  if (!self || stats.alive || !storm) return;
  const k = Math.min(1, dt * 3);
  self.px += (storm.x - self.px) * k;
  self.py += (storm.y - self.py) * k;
}

// ---------------------------------------------------------------------------
// drawing helpers
// ---------------------------------------------------------------------------
function poly(ctx, pts, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}
function drawGun(g, i, col) {
  g.save();
  g.lineJoin = 'round';
  g.lineWidth = 1.4;
  g.strokeStyle = '#111';
  const box = (x, y, w, h, f) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h); };
  if (i === 0) { box(11, 3, 6, 8, '#4b5563'); box(10, -3.5, 19, 7, '#9ca3af'); box(11, -3.5, 17, 2.2, '#e5e7eb'); box(27, -2, 3, 4, '#374151'); }
  else if (i === 1) { box(2, -3.5, 10, 7, '#1e3a8a'); box(19, 3.5, 6, 10, '#1f2937'); box(11, -4, 18, 8, '#3b82f6'); box(11, -4, 18, 2.5, '#93c5fd'); box(29, -3, 12, 6, '#1f2937'); box(41, -1.5, 5, 3, '#0b0f19'); box(15, -7, 9, 3, '#0b0f19'); }
  else if (i === 2) { box(2, -3.5, 11, 7, '#78350f'); box(13, -4, 10, 8, '#f97316'); box(23, -3, 24, 3, '#4b5563'); box(23, .5, 22, 3, '#374151'); box(29, 3.5, 11, 4.5, '#92400e'); box(47, -3.5, 2, 4, '#111'); }
  else { box(0, -3.5, 12, 8, '#581c87'); box(17, 3, 5, 6, '#1f2937'); box(12, -3, 15, 6, '#a855f7'); box(27, -1.5, 28, 3, '#1f2937'); box(55, -3, 4, 6, '#111827'); box(16, -9, 17, 5, '#111827'); box(32, -8.5, 2.5, 4, '#38bdf8'); box(18, -4, 2, 1.5, '#111'); box(28, -4, 2, 1.5, '#111'); }
  if (col) {
    g.fillStyle = col;
    for (const [x, y] of [[[14, 7]], [[17, 5], [35, 0]], [[16, 4], [33, 5]], [[19, 5], [40, 3]]][i]) {
      g.beginPath(); g.arc(x, y, 4.5, 0, TAU); g.fill(); g.stroke();
    }
  }
  g.restore();
}
function drawWood(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.lineJoin = 'round';
  g.lineWidth = 1.6;
  g.strokeStyle = '#3b210a';
  for (const [ly, off] of [[-5, 0], [4.5, 2]]) {
    g.fillStyle = '#a8692b'; g.fillRect(-10 + off, ly - 4, 16, 8); g.strokeRect(-10 + off, ly - 4, 16, 8);
    g.fillStyle = '#c98a4a'; g.fillRect(-10 + off, ly - 4, 16, 2.6);
    g.fillStyle = '#e9c48f'; g.beginPath(); g.ellipse(6 + off, ly, 3.4, 4, 0, 0, TAU); g.fill(); g.stroke();
    g.strokeStyle = '#a8692b'; g.lineWidth = 1; g.beginPath(); g.ellipse(6 + off, ly, 1.5, 2, 0, 0, TAU); g.stroke();
    g.strokeStyle = '#3b210a'; g.lineWidth = 1.6;
  }
  g.restore();
}
drawWood($('wdi').getContext('2d'), 22, 22, 1.7);

// ---------------------------------------------------------------------------
// world rendering
// ---------------------------------------------------------------------------
function drawIsland(cm, hw, hh, t) {
  // foam crests out in the water
  c.fillStyle = '#ffffff';
  for (const wv of world.waves) {
    if (Math.abs(wv[0] - cm.x) > hw || Math.abs(wv[1] - cm.y) > hh) continue;
    c.globalAlpha = .18 + .14 * Math.sin(t * 1.6 + wv[2]);
    c.beginPath();
    c.arc(wv[0], wv[1], 14, Math.PI * .15, Math.PI * .85);
    c.lineWidth = 4;
    c.strokeStyle = '#fff';
    c.stroke();
  }
  c.globalAlpha = 1;

  const I = world.isl;
  for (let i = 0; i < 3; i++) poly(c, I.sh[i], ['#2487bd', '#3aa5d6', '#6ccbe8'][i]);
  // animated surf line
  c.strokeStyle = '#fff';
  c.lineWidth = 6;
  for (const [off, al, sp] of [[10, .85, 2.2], [52, .4, 1.4]]) {
    c.globalAlpha = al;
    c.beginPath();
    for (let i = 0; i <= 150; i++) {
      const a = (i % 150) / 150 * TAU;
      const r = isL(a) + off + 4 * Math.sin(t * sp + a * 10);
      const x = 1600 + Math.cos(a) * r, y = 1600 + Math.sin(a) * r;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
  c.globalAlpha = 1;

  poly(c, I.wet, '#c9ab68');
  poly(c, I.dry, '#ecdaa4');
  poly(c, I.edge, '#5aa44c');
  poly(c, I.grass, '#2f7d3e');

  // faint grid, clipped to the grass
  c.save();
  c.beginPath();
  for (let i = 0; i < I.grass.length; i++) i ? c.lineTo(I.grass[i][0], I.grass[i][1]) : c.moveTo(I.grass[i][0], I.grass[i][1]);
  c.closePath();
  c.clip();
  c.strokeStyle = '#0000001a';
  c.lineWidth = 2;
  c.beginPath();
  const x0 = Math.max(0, Math.floor((cm.x - hw) / 160) * 160), x1 = Math.min(WORLD, cm.x + hw);
  const y0 = Math.max(0, Math.floor((cm.y - hh) / 160) * 160), y1 = Math.min(WORLD, cm.y + hh);
  for (let x = x0; x < x1; x += 160) { c.moveTo(x, 0); c.lineTo(x, WORLD); }
  for (let y = y0; y < y1; y += 160) { c.moveTo(0, y); c.lineTo(WORLD, y); }
  c.stroke();
  c.restore();
}

function drawStains(cm, hw, hh) {
  c.globalAlpha = .8;
  for (const s of stains) {
    if (Math.abs(s.x - cm.x) > hw || Math.abs(s.y - cm.y) > hh) continue;
    c.fillStyle = s.col;
    c.beginPath(); c.arc(s.x, s.y, s.r, 0, TAU); c.fill();
    for (const d of s.d) { c.beginPath(); c.arc(s.x + d[0], s.y + d[1], d[2], 0, TAU); c.fill(); }
  }
  c.globalAlpha = 1;
}

function drawScenery(cm, hw, hh) {
  const vis = o => Math.abs(o.x - cm.x) < hw + 100 && Math.abs(o.y - cm.y) < hh + 100;
  c.fillStyle = '#b9a27a';
  for (const h of world.houses) if (vis({ x: h[0] + 85, y: h[1] + 70 })) c.fillRect(h[0], h[1], h[2], h[3]);
  for (const t of world.trees) {
    if (!vis({ x: t[0], y: t[1] })) continue;
    c.fillStyle = '#0003'; c.beginPath(); c.arc(t[0] + 7, t[1] + 9, t[2], 0, TAU); c.fill();
    c.fillStyle = '#1f5f2c'; c.beginPath(); c.arc(t[0], t[1], t[2], 0, TAU); c.fill();
    c.fillStyle = '#38a152'; c.beginPath(); c.arc(t[0], t[1], t[2] * .62, 0, TAU); c.fill();
  }
  // permanent structures: a plank shell so walls read as buildings
  for (const w of world.pw) {
    if (w[0] + w[2] < cm.x - hw || w[0] > cm.x + hw || w[1] + w[3] < cm.y - hh || w[1] > cm.y + hh) continue;
    c.fillStyle = '#0004'; c.fillRect(w[0] + 5, w[1] + 7, w[2], w[3]);
    c.fillStyle = '#6b4423'; c.fillRect(w[0], w[1], w[2], w[3]);
    c.strokeStyle = '#3b210a'; c.lineWidth = 2.5; c.strokeRect(w[0], w[1], w[2], w[3]);
  }
  // player-built cover fades out as it takes damage
  for (const w of boards) {
    if (w.x + w.w < cm.x - hw || w.x > cm.x + hw || w.y + w.h < cm.y - hh || w.y > cm.y + hh) continue;
    c.globalAlpha = .45 + .55 * w.hp / 150;
    c.fillStyle = '#0004'; c.fillRect(w.x + 5, w.y + 7, w.w, w.h);
    c.fillStyle = '#d9a95f'; c.fillRect(w.x, w.y, w.w, w.h);
    c.strokeStyle = '#3b210a'; c.lineWidth = 2; c.strokeRect(w.x, w.y, w.w, w.h);
    c.globalAlpha = 1;
  }
}

function drawLoot(cm, hw, hh, t) {
  c.font = 'bold 12px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const k of lootItems) {
    if (Math.abs(k.x - cm.x) > hw || Math.abs(k.y - cm.y) > hh) continue;
    const y = k.y + Math.sin(t * 3 + k.x) * 2;
    if (k.k === 'c') {
      c.fillStyle = '#fbbf2466'; c.beginPath(); c.arc(k.x, k.y, 22 + Math.sin(t * 4) * 3, 0, TAU); c.fill();
      c.fillStyle = '#d97706'; c.fillRect(k.x - 13, k.y - 9, 26, 18);
      c.fillStyle = '#fbbf24'; c.fillRect(k.x - 13, k.y - 9, 26, 6);
      c.strokeStyle = '#78350f'; c.lineWidth = 2; c.strokeRect(k.x - 13, k.y - 9, 26, 18);
      continue;
    }
    if (k.k === 'w') {
      const w = WP[k.i];
      if (!w) continue;
      const held = stats.inv[k.i] === 1;
      c.globalAlpha = held ? .45 : 1;
      c.fillStyle = w.c + '55'; c.beginPath(); c.arc(k.x, y, 26 + Math.sin(t * 4) * 2, 0, TAU); c.fill();
      c.strokeStyle = w.c; c.lineWidth = 2; c.stroke();
      c.save();
      c.translate(k.x, y);
      c.scale(.85, .85);
      c.translate(-(w.x0 + w.len) / 2, -3);
      drawGun(c, k.i, null);
      c.restore();
      c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeText(w.n, k.x, y + 34);
      c.fillStyle = '#fff'; c.fillText(w.n, k.x, y + 34);
      c.globalAlpha = 1;
      continue;
    }
    if (k.k === 'o') {
      c.fillStyle = '#a8692b55'; c.beginPath(); c.arc(k.x, y, 19, 0, TAU); c.fill();
      c.fillStyle = '#5b3414'; c.beginPath(); c.arc(k.x, y, 14, 0, TAU); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
      drawWood(c, k.x, y, .8);
      continue;
    }
    const col = k.k === 'h' ? '#ef4444' : k.k === 's' ? '#38bdf8' : '#a16207';
    c.fillStyle = col + '55'; c.beginPath(); c.arc(k.x, y, 17, 0, TAU); c.fill();
    c.fillStyle = col; c.beginPath(); c.arc(k.x, y, 11, 0, TAU); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#fff';
    c.fillText(k.k === 'h' ? '+' : k.k === 's' ? '◆' : 'W', k.x, y + 1);
  }
  c.globalAlpha = 1;
}

function drawBushes(cm, hw, hh) {
  const PAL = ['#166534', '#16a34a', '#22c55e', '#4ade80'];
  for (const b of world.bushes) {
    if (Math.abs(b.x - cm.x) > hw + 60 || Math.abs(b.y - cm.y) > hh + 60) continue;
    c.globalAlpha = stats.alive && self && inBush(b) ? .5 : 1;
    c.fillStyle = '#0003'; c.beginPath(); c.arc(b.x + 5, b.y + 7, b.r, 0, TAU); c.fill();
    c.fillStyle = '#14532d'; c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU); c.fill();
    for (const l of b.bl) {
      c.fillStyle = l[3] === 4 ? '#ef4444' : PAL[l[3]];
      c.beginPath(); c.arc(b.x + l[0], b.y + l[1], l[2], 0, TAU); c.fill();
    }
  }
  c.globalAlpha = 1;
}
const inBush = b => self && Math.hypot(self.px - b.x, self.py - b.y) < b.r;

function drawPlayer(o, isMe) {
  const r = roster.get(o.id);
  const col = r ? r.col : '#e5e7eb';
  c.globalAlpha = 1;
  c.fillStyle = '#0004';
  c.beginPath(); c.arc(o.x + 4, o.y + 6, RAD, 0, TAU); c.fill();
  c.fillStyle = col;
  c.beginPath(); c.arc(o.x, o.y, RAD, 0, TAU); c.fill();
  c.fillStyle = '#ffffff55';
  c.beginPath(); c.arc(o.x - 4, o.y - 4, 6, 0, TAU); c.fill();
  c.strokeStyle = isMe ? '#fff' : '#0008';
  c.lineWidth = isMe ? 3 : 3;
  c.stroke();

  c.save();
  c.translate(o.x, o.y);
  c.rotate(o.ang);
  if (Math.cos(o.ang) < 0) c.scale(1, -1);
  c.translate(-(o.rc || 0) * 4, 0);
  drawGun(c, o.wp, col);
  c.restore();

  if (!isMe) {
    c.fillStyle = '#0009'; c.fillRect(o.x - 16, o.y - 28, 32, 5);
    c.fillStyle = '#4ade80'; c.fillRect(o.x - 16, o.y - 28, 32 * clamp(o.hp / 100, 0, 1), 3);
    if (o.sh > 0) { c.fillStyle = '#38bdf8'; c.fillRect(o.x - 16, o.y - 28, 32 * o.sh / 100, 2); }
    c.lineWidth = 3; c.strokeStyle = '#000';
    c.fillStyle = '#fffc';
    const name = r ? r.name : '?';
    c.font = 'bold 12px sans-serif';
    c.strokeText(name, o.x, o.y - 35);
    c.fillText(name, o.x, o.y - 35);
  }
}

function drawStorm() {
  if (!storm) return;
  c.fillStyle = 'rgba(120,40,210,.38)';
  c.beginPath();
  c.rect(self.px - 99999, self.py - 99999, 199998, 199998);
  c.moveTo(storm.x + storm.r, storm.y);
  c.arc(storm.x, storm.y, storm.r, 0, TAU);
  c.fill('evenodd');
  c.strokeStyle = '#c084fc'; c.lineWidth = 4;
  c.beginPath(); c.arc(storm.x, storm.y, storm.r, 0, TAU); c.stroke();
  c.strokeStyle = '#fff'; c.lineWidth = 3;
  c.setLineDash([14, 12]);
  c.beginPath(); c.arc(storm.tx, storm.ty, storm.tr, 0, TAU); c.stroke();
  c.setLineDash([]);
}

function drawMinimap() {
  if (!world || !storm) return;
  const k = 104 / WORLD;
  const I = world.isl;
  m2.fillStyle = '#1c78b2';
  m2.fillRect(0, 0, 104, 104);
  const layers = [[I.sh[2], '#6ccbe8'], [I.wet, '#c9ab68'], [I.dry, '#ecdaa4'], [I.edge, '#5aa44c'], [I.grass, '#2f7d3e']];
  for (const [pts, col] of layers) {
    m2.fillStyle = col;
    m2.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0] * k, y = pts[i][1] * k;
      i ? m2.lineTo(x, y) : m2.moveTo(x, y);
    }
    m2.closePath();
    m2.fill();
  }
  // storm covers everything outside the safe circle
  m2.fillStyle = 'rgba(120,40,210,.6)';
  m2.beginPath();
  m2.rect(0, 0, 104, 104);
  m2.moveTo((storm.x + storm.r) * k, storm.y * k);
  m2.arc(storm.x * k, storm.y * k, storm.r * k, 0, TAU);
  m2.fill('evenodd');
  m2.strokeStyle = '#fff'; m2.lineWidth = 1;
  m2.beginPath(); m2.arc(storm.tx * k, storm.ty * k, storm.tr * k, 0, TAU); m2.stroke();
  if (self) {
    const r = roster.get(myId);
    m2.fillStyle = r ? r.col : '#fff';
    m2.beginPath(); m2.arc(self.px * k, self.py * k, 3.5, 0, TAU); m2.fill();
    m2.strokeStyle = '#fff'; m2.lineWidth = 1; m2.stroke();
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
$('how').textContent = touchDevice
  ? 'Left side: move. Right side: aim (auto-fires). Tap BUILD to place a wall. Tap the weapon button to swap guns.'
  : 'W moves toward your cursor, S backs away, A / D strafe. Hold click to fire, E / right-click to build a wall, TAB to swap weapons.';
$('wp').innerHTML = WP.map(w => `<i style="--c:${w.c}"></i>`).join('');

function updateHud() {
  $('al').textContent = '👥 ' + aliveCount;
  $('kl').textContent = '💀 ' + stats.k;
  if (storm && PH[storm.ph]) {
    const ph = PH[storm.ph];
    const left = storm.closing
      ? Math.max(0, Math.ceil(ph.shr - storm.t))
      : Math.max(0, Math.ceil(ph.hold - storm.t));
    $('st').textContent = (storm.closing ? '⚠️ Storm closing' : '🌀 Storm in') + ' ' + left + 's';
  }
  const hp = Math.ceil(clamp(stats.hp, 0, 100));
  $('hp').children[0].style.width = hp + '%';
  $('hp').children[1].textContent = hp;
  $('sh').children[0].style.width = Math.max(0, stats.sh) + '%';
  $('sh').children[1].textContent = Math.ceil(Math.max(0, stats.sh));
  const key = stats.wp + '|' + stats.inv.join('');
  if (key !== hudKey) { hudKey = key; drawWeaponChip(); }
  $('wdn').textContent = stats.wood;
  $('bb').classList.toggle('no', stats.wood < 10);
}
function drawWeaponChip() {
  const w = WP[stats.wp];
  const g = $('wi').getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, 112, 44);
  const s = Math.min(2.6, 100 / (w.len - w.x0));
  g.translate(56 - (w.x0 + w.len) / 2 * s, 22 - 3 * s);
  g.scale(s, s);
  drawGun(g, stats.wp, null);
  $('wt').textContent = w.n;
  $('wn').style.borderColor = w.c;
  [...$('wp').children].forEach((el, i) => {
    el.className = (stats.inv[i] ? 'o' : '') + (i === stats.wp ? ' c' : '');
    el.style.setProperty('--c', WP[i].c);
  });
}

// ---------------------------------------------------------------------------
// screen flow
// ---------------------------------------------------------------------------
// The overlay is a small state machine with three panels: the game browser, the
// room you are standing in, and the end-of-match card. "playing" is the only
// state that hides it; "dead" keeps the world on screen behind the card so you
// can watch the rest of the match.
const PANELS = { menu: 'pMenu', room: 'pRoom', end: 'pEnd' };

function setScreen(s) {
  screen = s;
  const inMatch = s === 'playing' || s === 'dead';
  $('ov').hidden = s === 'playing';
  $('bb').style.display = inMatch && touchDevice && stats.alive ? 'block' : 'none';
  $('mm').style.display = inMatch ? 'block' : 'none';
  $('bars').style.display = inMatch ? '' : 'none';
  if (s !== 'playing') { AU.stop(); if (AU.on.mus) AU.menu(); }
  if (s === 'dead' || s === 'results') showEnd();
  else if (s !== 'playing') showPanel(s === 'room' ? 'room' : 'menu');
}

function showPanel(which) {
  for (const [name, id] of Object.entries(PANELS)) $(id).hidden = name !== which;
  if (which === 'menu') refreshMenu();
  if (which === 'room') renderRoom();
}

function refreshMenu() {
  if (screen !== 'menu') return;
  $('hint').textContent = online
    ? `${online} player${online === 1 ? '' : 's'} online`
    : 'Nobody else is here yet — create a game and others can join it.';
  const list = $('rlist');
  if (!openRooms.length) {
    list.innerHTML = '<p class="hint" style="margin:0">No open games right now.</p>';
    return;
  }
  list.innerHTML = openRooms.map(r => {
    const live = r.status !== 'waiting';
    const full = r.n >= r.max;
    const label = live ? 'Live' : full ? 'Full' : 'Join';
    return `<button class="rrow ${live ? 'live' : ''}" data-room="${r.id}" ${live || full ? 'disabled' : ''}>
      <span class="g">#${r.id}</span>
      <span class="info">${esc(r.host)}'s game<span class="tag2"> · ${r.n}/${r.max} players</span></span>
      <span class="go">${label}</span>
    </button>`;
  }).join('');
}

function renderRoom() {
  if (!room) return;
  const isHost = room.hostId === room.you;
  $('rsub').textContent = room.status === 'live'
    ? 'Game in progress.'
    : 'Bots fill every empty slot, so launch whenever you like.';
  $('rmem').innerHTML = room.members.map(m =>
    `<div class="mrow ${m.id === room.you ? 'me' : ''}">
       <i class="dotc" style="background:${esc(m.c)}"></i>
       <span class="nm">${esc(m.n)}${m.id === room.you ? ' (you)' : ''}</span>
       ${m.id === room.hostId ? '<span class="host">HOST</span>' : ''}
     </div>`).join('');
  // Only the host can resize the game, and never below the seats already taken.
  $('szrow2').hidden = !isHost;
  $('szv2').textContent = room.max;
  $('szd2').disabled = room.max <= Math.max(2, room.members.length);
  $('szu2').disabled = room.max >= 12;
  // Launching is the host's call, so only they get the button.
  $('rstart').hidden = !isHost;
  $('rstart').disabled = room.status !== 'waiting';
  $('rstart').textContent = `LAUNCH GAME (${room.members.length}/${room.max})`;
  const bots = room.max - room.members.length;
  $('rnote').textContent = room.status !== 'waiting'
    ? 'Game in progress.'
    : !isHost
      ? 'Waiting for the host to launch.'
      : room.members.length === 1
        ? 'You opened this game. Launch it to play with bots, or wait for someone to join.'
        : `${bots} slot${bots === 1 ? '' : 's'} will be filled with bots.`;
}

function showEnd() {
  showPanel('end');
  const ttl = $('ttl3'), sub = $('esub'), board = $('board'), again = $('eagain');
  if (screen === 'dead' && standing) {
    ttl.textContent = 'ELIMINATED';
    sub.innerHTML = `Taken out by <b>${esc(standing.by)}</b>. You placed <b>#${standing.place}</b> of ${standing.total} with ${standing.kills} elimination${standing.kills === 1 ? '' : 's'}.`;
    // While any human is still alive the match runs on; results follow it.
    again.disabled = standing.humansLeft > 0;
    again.textContent = again.disabled ? 'Match still running' : 'See final standings';
    board.hidden = true;
    return;
  }
  const kills = outcome && Number.isFinite(outcome.kills) ? outcome.kills : stats.k;
  ttl.textContent = outcome && outcome.won ? '🏆 ROYALE!' : 'MATCH OVER';
  const who = outcome && outcome.winner ? esc(outcome.winner) : 'nobody';
  sub.innerHTML = `<b>${who}</b> won. You placed <b>#${outcome ? outcome.place : '?'}</b> of ${outcome ? outcome.total : '?'} with ${kills} elimination${kills === 1 ? '' : 's'}.`;
  again.disabled = false;
  again.textContent = 'Back to games';
  const rows = (outcome ? outcome.leaderboard : []).map(r =>
    `<div class="${r.i === myId ? 'me' : ''}"><span class="pl">${r.place}</span>
       <span class="n"><i class="dotc" style="background:${esc((roster.get(r.i) || {}).col || '#888')}"></i>
       <span>${esc(r.n)}</span>${r.b ? '<span class="tag">BOT</span>' : ''}</span>
       <span>${r.place === 1 ? '🏆 ' : ''}${r.k}💀</span></div>`);
  if (rows.length) { board.innerHTML = rows.join(''); board.hidden = false; }
  if (outcome && outcome.reward) {
    Account.rewardToast(outcome.reward);
    Account.load().then(paintAccount);
  }
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ') { queuedBuild = true; e.preventDefault(); }
  if (e.key === 'Tab') { e.preventDefault(); if (!e.repeat && stats.alive) queuedSwap = true; }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('contextmenu', e => e.preventDefault());

$('bb').addEventListener('pointerdown', e => { queuedBuild = true; e.preventDefault(); });
$('wn').addEventListener('pointerdown', e => { e.preventDefault(); if (stats.alive) queuedSwap = true; });
$('wn').addEventListener('mousedown', e => e.preventDefault());

// e.target is not guaranteed to be an Element (synthetic events, or a pointer
// that lands outside the document), so never call closest() on it unguarded.
const closest = (e, sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);

addEventListener('pointerdown', e => {
  if (screen !== 'playing' || closest(e, 'button,a')) return;
  if (e.pointerType === 'mouse') {
    aimMode = true;
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (e.button === 2) queuedBuild = true; else ptr.down = true;
    return;
  }
  aimMode = false;
  const s = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  if (e.clientX < cw / 2) { if (!sticks.l) sticks.l = s; } else if (!sticks.r) sticks.r = s;
});
addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') { aimMode = true; ptr.x = e.clientX; ptr.y = e.clientY; return; }
  for (const s of [sticks.l, sticks.r]) {
    if (s && s.id === e.pointerId) {
      let dx = (e.clientX - s.ox) / 55, dy = (e.clientY - s.oy) / 55;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      s.dx = dx; s.dy = dy;
    }
  }
});
const release = e => {
  if (e.pointerType === 'mouse') { ptr.down = false; return; }
  if (sticks.l && sticks.l.id === e.pointerId) sticks.l = null;
  if (sticks.r && sticks.r.id === e.pointerId) sticks.r = null;
};
addEventListener('pointerup', release);
addEventListener('pointercancel', release);

// Input is shipped at ~30 Hz. Build/swap are edge-triggered: they are set by a
// key press or tap and cleared only after being included in a sent frame.
setInterval(() => {
  if (screen !== 'playing' || !stats.alive || ws.readyState !== 1) {
    queuedBuild = queuedSwap = false;
    return;
  }
  let mx = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  let my = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0);
  let ang = self ? self.ang : 0, fire = false;

  if (aimMode) {
    // Cursor aiming: W walks toward the cursor, S retreats, A/D strafe around it.
    const f = -my, r = mx, ca = Math.cos(ang), sa = Math.sin(ang);
    mx = ca * f - sa * r;
    my = sa * f + ca * r;
    const dx = ptr.x - cw / 2, dy = ptr.y - ch / 2;
    if (dx * dx + dy * dy > 100) ang = Math.atan2(dy, dx);
    fire = ptr.down;
  }
  if (sticks.l) { mx = sticks.l.dx; my = sticks.l.dy; }
  if (sticks.r) {
    const a = Math.hypot(sticks.r.dx, sticks.r.dy);
    if (a > .15) ang = Math.atan2(sticks.r.dy, sticks.r.dx);
    fire = a > .35;
  }
  ang = wrap(ang);
  if (self) self.ang = ang;
  send({
    t: 'in',
    mx: +mx.toFixed(2), my: +my.toFixed(2), a: +ang.toFixed(2),
    f: fire ? 1 : 0,
    b: queuedBuild ? 1 : 0,
    s: queuedSwap ? 1 : 0,
  });
  queuedBuild = false;
  queuedSwap = false;
}, 33);

// ---------------------------------------------------------------------------
// per-frame prediction: consume the same keys at display rate
// ---------------------------------------------------------------------------
function localStep(dt) {
  if (screen !== 'playing' || !stats.alive || !self) return;
  let mx = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  let my = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0);
  if (aimMode) {
    const f = -my, r = mx, ca = Math.cos(self.ang), sa = Math.sin(self.ang);
    mx = ca * f - sa * r;
    my = sa * f + ca * r;
  }
  if (sticks.l) { mx = sticks.l.dx; my = sticks.l.dy; }
  predict(dt, mx, my);
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let warnedDraw = false;
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000);
  last = now;
  localStep(dt);
  spectateStep(dt);
  // smooth remote entities and bullets toward their latest snapshot
  const k = 1 - Math.exp(-dt * 16);
  for (const o of others.values()) { o.px += (o.x - o.px) * k; o.py += (o.y - o.py) * k; }
  for (const b of shots) { b.px += (b.x - b.px) * k; b.py += (b.y - b.py) * k; }
  // A throw inside draw() used to stop requestAnimationFrame for good, which
  // froze the game on a blank island while the server kept playing it. Draw in
  // isolation and always schedule the next frame, so one bad frame costs a
  // single frame rather than the whole match.
  try {
    if (screen === 'playing' || screen === 'dead') draw();
    else drawBackdrop();
    stepFx(dt);
  } catch (err) {
    if (!warnedDraw) {
      warnedDraw = true;
      console.error('[storm] render error (recovered, continuing):', err);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Backdrop behind the menus and the room screen. A flat fill looked like a
// broken canvas sitting there, so this paints the sea and a hint of shoreline:
// there is always an island to look at, even before a match is running.
function drawBackdrop() {
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = c.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, '#123f63');
  g.addColorStop(1, '#0d2f4c');
  c.fillStyle = g;
  c.fillRect(0, 0, cw, ch);

  // A slow swell so the water is not dead either.
  c.fillStyle = '#ffffff09';
  for (let i = 0; i < 9; i++) {
    const y = ((clock * 9 + i * 97) % (ch + 120)) - 60;
    c.beginPath();
    c.ellipse(cw * .5 + Math.sin(clock * .4 + i) * 120, y, cw * .42, 13, 0, 0, TAU);
    c.fill();
  }

  // Silhouette of the island, centred and scaled to fit. The live world wins
  // when there is one; otherwise fall back to the shoreline the server sent.
  const outline = (world && world.isl && world.isl.dry) || shore;
  if (outline && outline.length) {
    const k = Math.min(cw, ch) / 3400;
    c.save();
    c.translate(cw / 2, ch / 2);
    c.scale(k, k);
    c.translate(-1600, -1600);
    c.fillStyle = '#0a1f16';
    c.beginPath();
    outline.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.fill();
    c.restore();
  }
}

function draw() {
  const sx = (Math.random() - .5) * shake, sy = (Math.random() - .5) * shake;
  const view = self ? { x: self.px, y: self.py } : { x: 1600, y: 1600 };
  const t = clock;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#1c78b2';
  c.fillRect(0, 0, cw, ch);
  c.setTransform(dpr * zoom, 0, 0, dpr * zoom, (cw / 2 - view.x * zoom + sx) * dpr, (ch / 2 - view.y * zoom + sy) * dpr);
  const hw = cw / 2 / zoom + 80, hh = ch / 2 / zoom + 80;

  if (!world) { c.setTransform(dpr, 0, 0, dpr, 0, 0); return; }

  drawIsland(view, hw, hh, t);
  drawStains(view, hw, hh);
  drawScenery(view, hw, hh);
  drawLoot(view, hw, hh, t);

  // wall-build ghost in front of us.
  // `self` is null until the first snapshot lands, and the world arrives a beat
  // earlier than it, so it has to be part of this guard.
  if (self && stats.alive && (stats.wood >= 10) && screen === 'playing') {
    const a = self.ang, bx = self.px + Math.cos(a) * 46, by = self.py + Math.sin(a) * 46;
    const horiz = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
    const w = horiz ? 14 : 90, h = horiz ? 90 : 14;
    c.globalAlpha = .35;
    c.fillStyle = '#fff';
    c.fillRect(bx - w / 2, by - h / 2, w, h);
    c.globalAlpha = 1;
  }

  // bullets
  c.strokeStyle = '#fde68a'; c.lineWidth = 2.5;
  c.beginPath();
  for (const b of shots) { c.moveTo(b.px - b.vx * .025, b.py - b.vy * .025); c.lineTo(b.px, b.py); }
  c.stroke();

  // players: draw others first, ourselves on top
  for (const o of others.values()) {
    if (o.id === myId) continue;
    if (o.inb) continue;               // drawn after the bushes instead
    if (Math.abs(o.px - view.x) > hw || Math.abs(o.py - view.y) > hh) continue;
    drawPlayer({ ...o, x: o.px, y: o.py }, false);
  }
  if (world.bushes.length) {
    drawBushes(view, hw, hh);
    for (const o of others.values()) {
      if (!o.inb || o.id === myId) continue;
      if (Math.abs(o.px - view.x) > hw || Math.abs(o.py - view.y) > hh) continue;
      // only render someone in a bush if they are revealed or close
      drawPlayer({ ...o, x: o.px, y: o.py }, false);
    }
  }
  if (self && stats.alive) drawPlayer({ ...self, x: self.px, y: self.py, wp: stats.wp }, true);

  // floating damage numbers
  for (const f of FX) {
    c.globalAlpha = clamp(f.l * 2.5, 0, 1);
    if (f.text !== undefined) {
      c.font = 'bold 18px sans-serif';
      c.lineWidth = 3; c.strokeStyle = '#000';
      c.strokeText(f.text, f.x, f.y);
      c.fillStyle = f.col;
      c.fillText(f.text, f.x, f.y);
    }
  }
  c.globalAlpha = 1;

  drawStorm();

  // screen-space: storm vignette, damage flash, touch sticks
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const out = self && stats.alive && storm && Math.hypot(self.px - storm.x, self.py - storm.y) > storm.r;
  if (out || hurt > 0) {
    const g = c.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * .35, cw / 2, ch / 2, Math.max(cw, ch) * .7);
    g.addColorStop(0, '#0000');
    g.addColorStop(1, out ? 'rgba(140,50,230,.55)' : `rgba(220,30,30,${Math.min(.5, hurt * .8)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, cw, ch);
  }
  if (touchDevice) {
    for (const [s, hx, hy] of [[sticks.l, 110, ch - 110], [sticks.r, cw - 110, ch - 110]]) {
      const ox = s ? s.ox : hx, oy = s ? s.oy : hy;
      c.fillStyle = s ? '#ffffff22' : '#ffffff12';
      c.strokeStyle = '#ffffff55';
      c.lineWidth = 2;
      c.beginPath(); c.arc(ox, oy, 55, 0, TAU); c.fill(); c.stroke();
      c.fillStyle = '#ffffff66';
      c.beginPath(); c.arc(ox + (s ? s.dx * 55 : 0), oy + (s ? s.dy * 55 : 0), 24, 0, TAU); c.fill();
    }
  }
  drawMinimap();
}

// ---------------------------------------------------------------------------
// menus + settings
// ---------------------------------------------------------------------------
// Guest nickname, or the account name when signed in.
function paintAccount() {
  const u = Account.user;
  $('name').disabled = !!u;
  $('name').style.opacity = u ? '.6' : '';
  $('name').placeholder = u ? 'Playing as ' + u.name : 'Nickname';
  $('ab').textContent = u ? `👤 ${u.name}` : '👤 Sign in';
  $('acctInfo').textContent = u ? `Level ${u.level} · ${u.xp} XP · ⛁ ${u.tokens}` : 'Sign in to save progress';
  $('name').value = Account.nickname($('name').value);
}
$('name').addEventListener('input', () => {
  if (!Account.user) localStorage.setItem('nickname', $('name').value.trim().slice(0, 16));
});
$('ab').onclick = () => Account.user ? Account.logout().then(() => location.reload()) : acctDialog.open('login');
Account.load().then(paintAccount);

let colour = localStorage.getItem('storm-col') || COLS[0];
if (!COLS.includes(colour)) colour = COLS[0];
function renderColours() {
  $('cbox').innerHTML = COLS.map(col =>
    `<button class="sw ${col === colour ? 'sel' : ''}" style="background:${col}" data-c="${col}" aria-label="Colour ${col}"></button>`).join('');
}
renderColours();
$('cbox').addEventListener('click', e => {
  const b = closest(e, '.sw');
  if (!b) return;
  colour = b.dataset.c;
  localStorage.setItem('storm-col', colour);
  Account.saveSetting('stormColour', colour);
  renderColours();
});

// ---- deploy ----
const deployName = () => Account.nickname($('name').value);

$('mk').onclick = () => {
  AU.unlock();
  if (!socketReady) return;
  send({ t: 'create', name: deployName(), col: colour, max: menuSize });
};
$('qk').onclick = () => {
  AU.unlock();
  if (!socketReady) return;
  send({ t: 'quick', name: deployName(), col: colour });
};
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('mk').click(); });

// Game size for a new game. A room can still be resized later from inside it.
let menuSize = 8;
const paintSize = () => {
  $('szv').textContent = menuSize;
  $('szd').disabled = menuSize <= 2;
  $('szu').disabled = menuSize >= 12;
};
$('szd').onclick = () => { menuSize = Math.max(2, menuSize - 1); paintSize(); };
$('szu').onclick = () => { menuSize = Math.min(12, menuSize + 1); paintSize(); };
paintSize();

// ---- open games list ----
$('rlist').addEventListener('click', e => {
  const row = closest(e, '.rrow');
  if (!row || row.disabled || !socketReady) return;
  AU.unlock();
  send({ t: 'join', room: +row.dataset.room, name: deployName(), col: colour });
});

// ---- inside a room ----
// Anyone in the room may launch it; only the host may resize it.
$('rstart').onclick = () => { AU.unlock(); send({ t: 'start' }); };
$('rquit').onclick = () => { AU.unlock(); send({ t: 'leave' }); };
$('szd2').onclick = () => { if (room) send({ t: 'size', max: Math.max(2, room.max - 1) }); };
$('szu2').onclick = () => { if (room) send({ t: 'size', max: Math.min(12, room.max + 1) }); };

// ---- end of match ----
$('eagain').onclick = () => { AU.unlock(); send({ t: 'leave' }); };

{
  const panel = $('set'), gear = $('gear');
  const sync = () => {
    for (const [id, key] of [['tm', 'mus'], ['ts', 'sfx']]) {
      const b = $(id);
      b.classList.toggle('on', AU.on[key]);
      b.setAttribute('aria-checked', String(AU.on[key]));
    }
  };
  sync();
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, AU.unlock, true);
  document.addEventListener('click', e => {
    const b = closest(e, 'button');
    if (b && !b.closest('#bb,#wn') && !b.classList.contains('tg') && !b.classList.contains('sw')) AU.click();
  }, true);
  for (const b of [gear, $('tm'), $('ts')]) b.addEventListener('mousedown', e => e.preventDefault());
  gear.onclick = () => { panel.hidden = !panel.hidden; };
  $('tm').onclick = () => { AU.setMusic(!AU.on.mus); sync(); if (AU.on.mus) AU.click(); };
  $('ts').onclick = () => { AU.setSfx(!AU.on.sfx); sync(); if (AU.on.sfx) AU.click(); };
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  document.addEventListener('pointerdown', e => {
    if (!panel.hidden && !closest(e, '#set,#gear')) panel.hidden = true;
  }, true);
}

AU.unlock();
setScreen('menu');
