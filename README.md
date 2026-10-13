# Multiplayer-games

Unblocked multiplayer games at https://multiplayer-games-amxe.onrender.com

The site may take some time to load, be patient

## Accounts

You can play every game as a **guest** at any time — no account needed. An
account is optional and only adds persistence:

- your **settings** follow you between games and browsers,
- **tokens** accumulate as the shared currency for the per-game shops,
- **XP** is earned in every game and levels you up,
- you appear on the **global inter-game ranking** and the per-game rankings.

### Signing up

New accounts are created as `pending`: an admin (Matakara) has to validate them
in the admin panel before they can be used. Until then you simply keep playing
as a guest.

### Admin

Sign in with the seeded admin account at `/admin/`:

- name `Matakara`, password `Games123` (override with `ADMIN_NAME` /
  `ADMIN_PASSWORD`, and change the password in the panel if you want).

The panel lists every account with its status, level, XP, tokens and per-game
stats. From there you can validate, reject, un-validate, delete accounts, and
grant or take away XP and tokens. The admin is a normal player too: it shows up
in the ranking and can play like anyone else.

### How it works

- `arcade/lib/accounts.js` — accounts, validation, sessions, XP and tokens,
  stored in `arcade/data/accounts.json` (git ignored, created on first boot).
- `arcade/lib/progress.js` — **the XP/token economy for every game in one
  table**. Change a number there and all games follow.
- Sessions are HMAC signed HttpOnly cookies, so the same cookie rides along on
  the WebSocket upgrade: that is how a game knows who is playing.
- Passwords are scrypt hashed with a per-user salt.
- Guests never earn XP or tokens and are never ranked.

## Adding a game

1. create `arcade/games/<id>.js` exporting `function start(wss) { ... }`
2. create `arcade/public/games/<id>/index.html` (connect to `/ws/<id>`)
3. add an entry to `arcade/games/index.js` with `status: 'live'`
4. add its XP rules to `arcade/lib/progress.js` and pay them out at the end of
   a round with `reward(ws.account, '<id>', {...})`

## Tests

```
npm test                # accounts, then a full storm match
npm run test:accounts   # registration, validation, XP, ranking, persistence
npm run test:storm      # headless storm royale match
```

`test-accounts.js` plays a real slither round and a real chess game over
WebSockets to check that XP lands on the right account, and that guests earn
nothing.
