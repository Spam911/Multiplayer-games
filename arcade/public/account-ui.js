'use strict';
// Renders the account dialog (login / register / sign out) into any page.
// Loaded after account.js with <script src="/account-ui.js"></script>.

const AccountUI = {};

(function () {
  AccountUI.mount = function (opts) {
    const o = opts || {};
    const root = document.createElement('dialog');
    root.className = 'acct';
    root.innerHTML = `
      <form method="dialog">
        <h3 data-r>Sign in</h3>
        <p class="hint" data-hint>Your account saves your settings, tokens and XP across every game. Guests can always play.</p>
        <label>Name</label>
        <input name="name" maxlength="16" autocomplete="username" spellcheck="false">
        <label>Password</label>
        <input name="password" type="password" maxlength="72" autocomplete="current-password">
        <p class="err" data-err></p>
        <div class="row">
          <button type="submit" data-go>Sign in</button>
          <button type="button" class="ghost" data-alt>Create account</button>
        </div>
        <p class="switch" data-sw><span data-mode>New here? </span><a data-tog>Create an account</a> — the admin validates it before you can use it.</p>
      </form>`;
    document.body.appendChild(root);

    const f = root.querySelector('form');
    const err = root.querySelector('[data-err]');
    const title = root.querySelector('[data-r]');
    const go = root.querySelector('[data-go]');
    const alt = root.querySelector('[data-alt]');
    const tog = root.querySelector('[data-tog]');
    const modeTxt = root.querySelector('[data-mode]');
    const hint = root.querySelector('[data-hint]');
    const name = f.elements.name, pass = f.elements.password;
    let mode = 'login';

    const LOGIN = {
      title: 'Sign in', go: 'Sign in', alt: 'Create account', tog: 'Create an account',
      hint: 'Your account saves your settings, tokens and XP across every game. Guests can always play.',
    };
    const REG = {
      title: 'Create account', go: 'Create account', alt: 'Sign in', tog: 'I already have one',
      hint: '3-16 characters (letters, numbers, _ or -) and a password of 6+ characters. An admin has to validate it first; you keep playing as a guest until then.',
    };

    function setMode(m) {
      mode = m;
      const c = m === 'login' ? LOGIN : REG;
      title.textContent = c.title; go.textContent = c.go; alt.textContent = c.alt;
      tog.textContent = c.tog; hint.textContent = c.hint;
      modeTxt.textContent = m === 'login' ? 'New here? ' : 'Already registered? ';
      pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      err.textContent = '';
    }
    setMode('login');
    tog.onclick = () => setMode(mode === 'login' ? 'register' : 'login');
    alt.onclick = () => { setMode(mode === 'login' ? 'register' : 'login'); (mode === 'login' ? name : pass).focus(); };

    f.onsubmit = async e => {
      e.preventDefault();
      err.textContent = '';
      go.disabled = true;
      const n = name.value.trim(), p = pass.value;
      const r = mode === 'login' ? await Account.login(n, p) : await Account.register(n, p);
      go.disabled = false;
      if (r.ok && mode === 'login') {
        Account.applyNickname();
        root.close();
        o.onChange && o.onChange(Account.user, { signedIn: true });
      } else if (r.ok) {
        err.className = 'ok';
        err.textContent = 'Account created. An admin has to validate it before you can sign in — keep playing as a guest in the meantime.';
        pass.value = '';
      } else {
        err.className = 'err';
        err.textContent = r.error || 'Something went wrong';
      }
    };

    root.addEventListener('close', () => { o.onClose && o.onClose(); });
    return {
      el: root,
      open(m) { setMode(m || 'login'); if (!root.open) root.showModal(); name.focus(); },
      close() { root.close(); },
    };
  };
})();
