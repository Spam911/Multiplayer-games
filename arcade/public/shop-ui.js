'use strict';
// A shop dialog shared by every game: renders the catalogue from the server,
// lets a signed-in player buy and equip, and explains to a guest that buying
// needs an account. Nothing here decides a price - every button posts an id and
// the server answers with what it actually charged, so the UI cannot drift.

const ShopUI = (() => {
  let dialog = null, currentGame = null;

  const esc = s => String(s).replace(/[<>&"']/g, m =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[m]));

  // How an item is previewed: a colour swatch, a multi-stop trail, a shot, or a
  // theme/skin gradient. Kept deliberately simple - it has to read at 40px.
  function swatch(item, cat) {
    if (item.rb) return 'background:conic-gradient(#ef4444,#facc15,#22c3ee,#a855f7,#ef4444)';
    if (item.col && item.col.startsWith('#')) return `background:${item.col}`;
    if (item.cols) return `background:linear-gradient(135deg,${item.cols.join(',')})`;
    if (item.light) return `background:linear-gradient(135deg,${item.light} 50%,${item.dark} 50%)`;
    if (item.hue === 'cycle') return 'background:conic-gradient(#ef4444,#facc15,#22c3ee,#a855f7,#ef4444)';
    if (typeof item.hue === 'number') return `background:hsl(${item.hue},70%,50%)`;
    return 'background:#888';
  }

  function ensure() {
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.id = 'shopDlg';
    dialog.hidden = true;
    dialog.innerHTML = `
      <div class="scard" role="dialog" aria-modal="true" aria-label="Shop">
        <header>
          <h3>Shop</h3>
          <div class="sp-wallet"><span class="tok"></span><b id="shopTokens">0</b></div>
          <button id="shopClose" aria-label="Close shop">✕</button>
        </header>
        <div id="shopGuest" class="sp-guest" hidden>
          Sign in with a validated account to buy items. You can play as a guest.
          <button id="shopSignIn">Sign in</button>
        </div>
        <nav id="shopTabs"></nav>
        <div id="shopBody"></div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('#shopClose').onclick = () => api.close();
    dialog.querySelector('#shopSignIn').onclick = () => {
      api.close();
      if (window.acctDialog && Account.user) acctDialog.open('login');
      else if (window.acctDialog) acctDialog.open('login');
    };
    // Click the backdrop to dismiss.
    dialog.addEventListener('pointerdown', e => { if (e.target === dialog) api.close(); });
    return dialog;
  }

  async function refresh() {
    const r = await fetch('/api/shop', { cache: 'no-store' });
    const d = await r.json();
    state.cat = d.catalogue;
    state.shop = d.shop;
    if (Account.user && Account.user.tokens !== undefined) {
      Account.user.tokens = d.shop.tokens;
    }
  }

  const state = { cat: null, shop: null, busy: false };

  function render() {
    if (!state.cat) return;
    const d = ensure();
    const game = currentGame;
    const def = state.cat.games[game];
    const mine = state.shop.owned[game] || {};
    const eq = state.shop.equipped[game] || {};
    d.querySelector('#shopTokens').textContent = state.shop.tokens;
    d.querySelector('#shopGuest').hidden = state.shop.playable;

    d.querySelector('#shopTabs').innerHTML = def.categories.map(c =>
      `<span class="sp-cat">${esc(c.name)}</span>`).join('');

    d.querySelector('#shopBody').innerHTML = def.categories.map(cat => `
      <div class="sp-group"><h4>${esc(cat.name)}</h4><div class="sp-grid">
        ${cat.items.map(it => {
          const owned = mine[cat.id] && mine[cat.id][it.id];
          const isEq = eq[cat.id] === it.id;
          const free = it.p === 0;
          const poor = !free && state.shop.tokens < it.p;
          const label = isEq ? 'Equipped'
            : owned ? 'Equip'
            : free ? 'Free'
            : it.p + ' ⛁';
          return `<button class="sp-item${isEq ? ' eq' : ''}${owned ? '' : poor ? ' poor' : ''}"
                    data-cat="${cat.id}" data-id="${it.id}">
            <span class="sp-sw" style="${swatch(it, cat.id)}"></span>
            <span class="sp-n">${esc(it.n)}</span>
            <span class="sp-p">${label}</span>
          </button>`;
        }).join('')}
      </div></div>`).join('');

    d.querySelectorAll('.sp-item').forEach(b => {
      b.onclick = () => act(game, b.dataset.cat, b.dataset.id);
    });
  }

  async function act(game, cat, id) {
    if (state.busy) return;
    state.busy = true;
    try {
      const owned = state.shop.owned[game][cat][id];
      const path = owned ? 'equip' : 'buy';
      const r = await fetch('/api/shop/' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, cat, id }),
      });
      const d = await r.json();
      if (!r.ok) { toast(d.error || 'Could not do that'); return; }
      if (d.user) Account.user = d.user;
      state.shop = d.shop;
      render();
      toast(path === 'buy' ? 'Unlocked ' + id + '!' : 'Equipped ' + id);
      // Let the game repaint with the new look straight away.
      if (window.onShopChange) window.onShopChange(d.shop);
    } catch {
      toast('Could not reach the server');
    } finally {
      state.busy = false;
    }
  }

  let toastT = 0;
  function toast(msg) {
    let el = document.getElementById('shopToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shopToast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('on'), 1800);
  }

  const api = {
    async open(game) {
      currentGame = game;
      ensure().hidden = false;
      try { await refresh(); } catch { /* render whatever we have */ }
      render();
    },
    close() { if (dialog) dialog.hidden = true; },
    // The equipped look for a game, resolved from owned + equipped. Games call
    // this to find out what to draw; it never throws.
    equipped(game) {
      const eq = state.shop && state.shop.equipped[game];
      if (!eq) return null;
      const out = {};
      for (const cat of Object.keys(eq)) {
        const id = eq[cat];
        const def = state.cat && state.cat.games[game];
        if (!def) continue;
        const c = def.categories.find(x => x.id === cat);
        const it = c && c.items.find(x => x.id === id);
        if (it) out[cat] = it;
      }
      return out;
    },
    // Re-read the catalogue, e.g. after logging in.
    async reload() { try { await refresh(); if (dialog && !dialog.hidden) render(); } catch {} },
    isOpen() { return dialog && !dialog.hidden; },
    // The raw catalogue and ownership, for a game that needs to read them
    // directly (storm restricts its colour picker to what is owned).
    raw() { return state; },
    // Look one catalogue item up by game/category/id.
    item(game, cat, id) {
      const def = state.cat && state.cat.games[game];
      if (!def) return null;
      const c = def.categories.find(x => x.id === cat);
      return c && c.items.find(x => x.id === id) || null;
    },
  };

  return api;
})();

if (typeof window !== 'undefined') window.ShopUI = ShopUI;

// Inject the styles once, so every game gets the same look without a build step.
(function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('shopCss')) return;
  const style = document.createElement('style');
  style.id = 'shopCss';
  style.textContent = `
  #shopDlg{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
    background:#000000aa;padding:16px;backdrop-filter:blur(3px)}
  #shopDlg[hidden]{display:none}
  .scard{width:min(560px,100%);max-height:88vh;overflow:auto;background:#151a24;color:#fff;
    border:2px solid #ffffff26;border-radius:16px;padding:14px 16px 18px;box-shadow:0 18px 50px #0009}
  .scard header{display:flex;align-items:center;gap:12px;margin-bottom:10px}
  .scard h3{margin:0;font:700 20px var(--f,system-ui);flex:1}
  .sp-wallet{display:flex;align-items:center;gap:6px;font:600 15px var(--f,system-ui)}
  .sp-wallet .tok{width:14px;height:14px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,#fef3c7,#f59e0b);border:2px solid #b45309;display:inline-block}
  #shopClose{width:32px;height:32px;border-radius:8px;border:2px solid #ffffff2e;background:#ffffff14;
    color:#fff;font-size:16px;cursor:pointer}
  .sp-guest{background:#facc1522;border:2px solid #facc1566;border-radius:10px;padding:10px 12px;
    font:500 14px var(--f,system-ui);margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .sp-guest button{margin-left:auto;padding:6px 14px;border-radius:9px;border:0;background:#facc15;
    color:#422006;font:600 14px var(--f,system-ui);cursor:pointer}
  #shopTabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .sp-cat{font:600 12px var(--f,system-ui);letter-spacing:.6px;text-transform:uppercase;
    background:#ffffff14;border-radius:20px;padding:4px 10px;opacity:.8}
  .sp-group h4{margin:12px 0 8px;font:600 14px var(--f,system-ui);opacity:.85}
  .sp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:9px}
  .sp-item{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;
    border-radius:12px;border:2px solid #ffffff1f;background:#ffffff0d;color:#fff;cursor:pointer;
    font:500 13px var(--f,system-ui);text-align:center}
  .sp-item:active{transform:translateY(2px)}
  .sp-item.eq{border-color:#facc15;background:#facc1522}
  .sp-item.poor{opacity:.45}
  .sp-sw{width:40px;height:40px;border-radius:50%;border:2px solid #ffffff40;display:block}
  .sp-n{font-weight:600;line-height:1.15}
  .sp-p{font-size:12px;opacity:.75}
  .sp-item.eq .sp-p{color:#facc15;opacity:1}
  #shopToast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);z-index:61;
    background:#000000cc;color:#fff;padding:9px 16px;border-radius:10px;font:500 14px var(--f,system-ui);
    opacity:0;pointer-events:none;transition:.18s}
  #shopToast.on{opacity:1;transform:translate(-50%,0)}`;
  document.head.appendChild(style);
})();