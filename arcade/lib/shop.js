'use strict';
// The shop catalogue: every cosmetic that can be bought, in one place.
//
// Prices are in tokens, the currency accounts earn from playing. This file is
// the single source of truth on both sides: the server validates a purchase
// against these entries (never a cost sent by the client), and the client
// renders the shop from the same list fetched over the API. Change a price
// here and it changes everywhere.
//
// The storm items are the original Storm Royale cosmetics, carried over with
// their original names, colours and relative pricing. The original gave 100
// coins at the start of a game and paid out per match; here tokens come from
// playing (see lib/progress), so the numbers are scaled to that slower,
// account-bound economy: a new player earns roughly 1-3 tokens a round, which
// makes the cheap items reachable in an evening and the showpieces a goal.

const GAMES = {
  storm: {
    label: 'Storm Royale',
    // Colours are applied to your player, name tag and splats.
    categories: [
      {
        id: 'colour',
        name: 'Colours',
        items: [
          { id: 'gold',    n: 'Gold',   p: 0,   col: '#facc15' },
          { id: 'snow',    n: 'Snow',   p: 60,  col: '#f1f5f9' },
          { id: 'sky',     n: 'Sky',    p: 75,  col: '#38bdf8' },
          { id: 'mint',    n: 'Mint',   p: 75,  col: '#34d399' },
          { id: 'rose',    n: 'Rose',   p: 90,  col: '#fb7185' },
          { id: 'violet',  n: 'Violet', p: 90,  col: '#a78bfa' },
          { id: 'ember',   n: 'Ember',  p: 120, col: '#f97316' },
          { id: 'shadow',  n: 'Shadow', p: 150, col: '#334155' },
          { id: 'prism',   n: 'Prism',  p: 400, col: 'rainbow' },
        ],
      },
      {
        id: 'trail',
        name: 'Trails',
        items: [
          { id: 'none',    n: 'None',    p: 0 },
          { id: 'spark',   n: 'Sparkle', p: 120, cols: ['#fde047', '#fff7ae', '#fbbf24'], r: [2, 4], l: .45 },
          { id: 'flame',   n: 'Flame',   p: 180, cols: ['#f97316', '#ef4444', '#facc15'], r: [4, 8], l: .5, up: 1 },
          { id: 'frost',   n: 'Frost',   p: 180, cols: ['#bae6fd', '#7dd3fc', '#ffffff'], r: [3, 6], l: .6 },
          { id: 'toxic',   n: 'Toxic',   p: 225, cols: ['#84cc16', '#a3e635', '#22c55e'], r: [4, 7], l: .6 },
          { id: 'rainbow', n: 'Rainbow', p: 400, rb: 1, r: [4, 7], l: .7 },
        ],
      },
      {
        id: 'bullet',
        name: 'Shots',
        items: [
          { id: 'default', n: 'Classic',  p: 0,   col: '#fde68a', w: 2.5, tail: .025 },
          { id: 'laser',   n: 'Red Laser',p: 90,  col: '#ef4444', w: 3.5, tail: .05, glow: '#fca5a5' },
          { id: 'neon',    n: 'Neon Beam',p: 150, col: '#22d3ee', w: 3,   tail: .06, glow: '#67e8f9' },
          { id: 'plasma',  n: 'Plasma',   p: 225, col: '#c084fc', w: 4,   tail: .05, glow: '#e9d5ff', cols: ['#c084fc', '#e9d5ff', '#a855f7'], pr: [2, 4] },
          { id: 'inferno', n: 'Inferno',  p: 270, col: '#fb923c', w: 3.5, tail: .05, glow: '#fde047', cols: ['#f97316', '#ef4444', '#facc15'], pr: [2, 4] },
          { id: 'rainbow', n: 'Rainbow',  p: 450, rb: 1, w: 3.5, tail: .07, pr: [2, 4] },
        ],
      },
    ],
  },

  chess: {
    label: 'Chess',
    categories: [
      {
        id: 'theme',
        name: 'Board themes',
        // A theme sets the two square colours plus the page background wash.
        items: [
          { id: 'classic', n: 'Classic',   p: 0,   light: '#eeeed2', dark: '#769656', bg: '#151a24', piece: '#2c2c2c' },
          { id: 'slate',   n: 'Slate',     p: 100, light: '#cbd5e1', dark: '#475569', bg: '#0f172a', piece: '#0f172a' },
          { id: 'emerald', n: 'Emerald',   p: 150, light: '#e7f5ec', dark: '#3f8f5f', bg: '#0d1f16', piece: '#12301f' },
          { id: 'mono',    n: 'Mono',      p: 200, light: '#f2f2f2', dark: '#8a8a8a', bg: '#101010', piece: '#1a1a1a' },
          { id: 'ocean',   n: 'Ocean',     p: 250, light: '#d7ecf5', dark: '#2f6f8f', bg: '#0a1a26', piece: '#0d2434' },
          { id: 'nebula',  n: 'Nebula',    p: 400, light: '#e9d5ff', dark: '#6d28d9', bg: '#14061f', piece: '#1f0b33' },
        ],
      },
    ],
  },

  slither: {
    label: 'Slither',
    categories: [
      {
        id: 'skin',
        name: 'Skins',
        // A skin recolours the snake: two band shades plus an eye/accent.
        items: [
          { id: 'classic', n: 'Classic', p: 0,   hue: 130, alt: 47, eye: '#fff' },
          { id: 'candy',   n: 'Candy',   p: 100, hue: 330, alt: 52, eye: '#fff' },
          { id: 'toxic',   n: 'Toxic',   p: 150, hue: 90,  alt: 45, eye: '#eaff7a' },
          { id: 'arctic',  n: 'Arctic',  p: 150, hue: 195, alt: 55, eye: '#e0f7ff' },
          { id: 'ember',   n: 'Ember',   p: 200, hue: 18,  alt: 45, eye: '#ffe9c9' },
          { id: 'royal',   n: 'Royal',   p: 250, hue: 268, alt: 52, eye: '#f0e2ff' },
          { id: 'prism',   n: 'Prism',   p: 450, hue: 'cycle', alt: 50, eye: '#fff' },
        ],
      },
    ],
  },
};

// Every item that ships free, so an account is never locked out of a default.
const STARTERS = {
  storm: { colour: 'gold', trail: 'none', bullet: 'default' },
  chess: { theme: 'classic' },
  slither: { skin: 'classic' },
};

// ---------- lookups ----------

function allItems() {
  const out = [];
  for (const [game, def] of Object.entries(GAMES)) {
    for (const cat of def.categories) {
      for (const item of cat.items) out.push({ game, cat: cat.id, ...item });
    }
  }
  return out;
}

const ITEMS = new Map(allItems().map(i => [i.game + ':' + i.cat + ':' + i.id, i]));

function item(game, cat, id) {
  return ITEMS.get(game + ':' + cat + ':' + String(id || '')) || null;
}
function category(game, cat) {
  const def = GAMES[game];
  if (!def) return null;
  return def.categories.find(c => c.id === cat) || null;
}

// What the client renders the shop from. Never includes anything sensitive.
function catalogue() {
  return {
    games: GAMES,
    starters: STARTERS,
  };
}

module.exports = { GAMES, STARTERS, item, category, catalogue, allItems };