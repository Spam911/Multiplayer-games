'use strict';
// XP and token rewards, shared by all games so the economy stays in one place.
//
// Every game calls reward(account, gameId, payload) when a round ends. The
// numbers below are the tuning surface: change them here and every game
// follows. Rewards scale with how well you did and cap out so a single round
// can never dominate the inter-game ranking.

const accounts = require('./accounts');

const XP = {
  slither: { perFood: 2, perScore: 4, win: 120, max: 400 },
  chess:   { win: 150, draw: 60, loss: 25, resign: 10, max: 200 },
  storm:   { perKill: 35, survive: 40, placeBonus: [200, 120, 80, 60, 45, 35, 25, 20, 15, 10], max: 700 },
};

// Tokens are the shared currency for the per-game shops (items to be defined
// later). Earned alongside XP, rounded down, with a small play reward so a
// losing run still means something.
const TOKENS_PER_XP = 0.1;
const TOKENS_PER_PLAY = 1;

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v || 0)));

function reward(account, gameId, payload = {}) {
  if (!account || !accounts.isPlayable(account)) return null;   // guests earn nothing
  const rule = XP[gameId] || { max: 100 };
  let xp = 0, win = false, detail = {};

  if (gameId === 'slither') {
    const score = Math.max(0, payload.score | 0);
    win = payload.rank === 1;
    xp = score * rule.perScore + (win ? rule.win : 0);
    detail = { score, place: payload.rank || 0 };
  } else if (gameId === 'chess') {
    win = payload.result === 'win';
    const draw = payload.result === 'draw';
    xp = win ? rule.win : draw ? rule.draw : payload.result === 'resign' ? rule.resign : rule.loss;
    detail = { result: payload.result, opponent: payload.opponent || null };
  } else if (gameId === 'storm') {
    const kills = Math.max(0, payload.kills | 0);
    const place = Math.max(1, payload.place | 0);
    win = place === 1;
    const placeXp = rule.placeBonus[Math.min(place, rule.placeBonus.length) - 1] || 0;
    xp = kills * rule.perKill + (payload.alive ? rule.survive : 0) + placeXp;
    detail = { kills, place };
  } else {
    xp = payload.xp || 0;                       // future games can pass xp directly
  }

  xp = clamp(xp, rule.max);
  const tokens = Math.floor(xp * TOKENS_PER_XP) + (payload.plays === 0 ? 0 : TOKENS_PER_PLAY);
  const got = accounts.award(account, gameId, { xp, tokens, win });
  if (!got) return null;
  return {
    game: gameId, xp: got.gainedXp, tokens: got.gainedTokens,
    totalXp: got.xp, level: got.level, win, detail,
    profile: { xp: got.xp, tokens: got.tokens, level: got.level },
  };
}

module.exports = { reward, XP, TOKENS_PER_XP };
