(() => {
  'use strict';
  const supported = () => !!window.PublicKeyCredential && !!navigator.credentials;
  const decode = value => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0)).buffer;
  };
  const encode = value => {
    if (value == null) return null;
    const bytes = new Uint8Array(value);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const optionsFromJSON = (options, creation) => {
    const parser = creation ? PublicKeyCredential.parseCreationOptionsFromJSON : PublicKeyCredential.parseRequestOptionsFromJSON;
    if (typeof parser === 'function') return parser.call(PublicKeyCredential, options);
    const result = { ...options, challenge: decode(options.challenge) };
    if (creation) result.user = { ...options.user, id: decode(options.user.id) };
    const key = creation ? 'excludeCredentials' : 'allowCredentials';
    if (options[key]) result[key] = options[key].map(item => ({ ...item, id: decode(item.id) }));
    return result;
  };
  const credentialToJSON = credential => {
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    const response = {};
    ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle'].forEach(key => {
      if (key in credential.response) response[key] = encode(credential.response[key]);
    });
    if (typeof credential.response.getTransports === 'function') response.transports = credential.response.getTransports();
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      response, authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {} };
  };
  const normalize = error => {
    if (error.code && ['needs_password', 'server', 'cancelled', 'exists'].includes(error.code)) return error;
    if (['NotAllowedError', 'AbortError'].includes(error.name)) return { code: 'cancelled' };
    if (error.name === 'InvalidStateError') return { code: 'exists' };
    return { code: 'server', message: error.message || '请重试。' };
  };
  const post = async (path, body = {}) => {
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403 && data.error === 'needs_password') throw { code: 'needs_password' };
        throw { code: 'server', message: data.error || '请求失败，请重试。' };
      }
      return data;
    } catch (error) { throw normalize(error); }
  };
  window.binderyPasskey = {
    supported,
    async login(next) {
      try {
        const options = await post('/login/passkey/options');
        const credential = await navigator.credentials.get({ publicKey: optionsFromJSON(options, false) });
        if (!credential) throw { code: 'cancelled' };
        const result = await post('/login/passkey/verify', { credential: credentialToJSON(credential), next });
        location.assign(result.redirect);
      } catch (error) { throw normalize(error); }
    },
    async register({ name }) {
      try {
        const options = await post('/security/passkeys/register/options');
        const credential = await navigator.credentials.create({ publicKey: optionsFromJSON(options, true) });
        if (!credential) throw { code: 'cancelled' };
        return await post('/security/passkeys/register/verify', { credential: credentialToJSON(credential), name });
      } catch (error) { throw normalize(error); }
    },
    reauth: password => post('/security/reauth', { password }),
  };

  const deviceName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    return ['Mac', 'Android', 'Windows', 'Linux'].find(name => ua.includes(name)) || '';
  };
  window.binderyPasskeyDialog = () => ({
    open: false, step: 'name', name: '', password: '', message: '', danger: false, busy: false, trigger: null,
    show() {
      this.trigger = document.activeElement;
      this.name = deviceName(); this.password = ''; this.message = ''; this.step = 'name'; this.open = true;
      this.$nextTick(() => this.$refs.passkeyName.focus());
    },
    close() {
      if (this.busy) return;
      this.open = false; this.password = '';
      this.trigger?.focus();
    },
    async confirmPassword() {
      this.busy = true; this.message = '';
      try {
        await window.binderyPasskey.reauth(this.password);
        this.password = ''; this.step = 'name';
        this.$nextTick(() => this.$refs.passkeyName.focus());
      } catch (error) { this.message = error.message || '密码错误'; this.danger = true; }
      finally { this.busy = false; }
    },
    async create() {
      this.busy = true; this.step = 'waiting'; this.message = '';
      try {
        await window.binderyPasskey.register({ name: this.name });
        this.busy = false; this.close();
        window.binderyToast('已添加通行密钥');
        window.dispatchEvent(new CustomEvent('passkey-added'));
      } catch (error) {
        this.step = error.code === 'needs_password' ? 'confirm' : 'name';
        this.danger = error.code !== 'cancelled';
        if (error.code === 'cancelled') this.message = '已取消。';
        else if (error.code === 'exists') this.message = '这个设备已经添加过通行密钥。';
        else if (error.code !== 'needs_password') this.message = '添加失败：' + error.message;
        this.$nextTick(() => (this.step === 'confirm' ? this.$refs.passkeyPassword : this.$refs.passkeyName).focus());
      } finally { this.busy = false; }
    },
  });
  window.binderyPasskeyRow = name => ({
    name, draft: name, editing: false, busy: false, error: '',
    edit() { this.draft = this.name; this.editing = true; this.error = ''; this.$nextTick(() => this.$refs.renameName.focus()); },
    async save(id) {
      this.busy = true; this.error = '';
      try {
        const result = await post('/security/passkeys/' + encodeURIComponent(id) + '/rename', { name: this.draft });
        this.name = result.name; this.editing = false;
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; }
    },
  });

  document.addEventListener('DOMContentLoaded', () => {
    const login = document.querySelector('[data-passkey-login]');
    if (login && supported()) {
      login.hidden = false;
      const passwordButton = document.querySelector('[data-password-submit]');
      passwordButton.classList.replace('btn-primary', 'btn-secondary');
      const button = login.querySelector('button');
      const label = login.querySelector('[data-passkey-label]');
      const hint = login.querySelector('[data-passkey-hint]');
      button.addEventListener('click', async () => {
        button.disabled = true; label.textContent = '等待验证…'; hint.hidden = true;
        try { await window.binderyPasskey.login(document.querySelector('input[name="next"]').value); }
        catch (error) {
          hint.textContent = error.code === 'cancelled' ? '已取消。' : '通行密钥登录失败，请重试或使用密码。';
          hint.className = error.code === 'cancelled' ? 'text-ink-3 text-xs mt-2' : 'notice-danger text-sm mt-2';
          hint.hidden = false;
        } finally { button.disabled = false; label.textContent = '使用通行密钥登录'; }
      });
    }
    document.querySelectorAll('[data-passkey-add]').forEach(node => { node.hidden = !supported(); });
    const unsupported = document.querySelector('[data-passkey-unsupported]');
    if (unsupported) unsupported.hidden = supported();
    const nudge = document.querySelector('[data-passkey-nudge]');
    if (nudge) {
      let dismissed = false;
      try { dismissed = localStorage.getItem('bindery-passkey-nudge') === 'dismissed'; } catch (_) { /* Storage may be disabled. */ }
      nudge.hidden = !supported() || dismissed;
      nudge.querySelector('[data-passkey-dismiss]').addEventListener('click', () => {
        try { localStorage.setItem('bindery-passkey-nudge', 'dismissed'); } catch (_) { /* Still hide for this page. */ }
        nudge.hidden = true;
      });
      window.addEventListener('passkey-added', () => { nudge.hidden = true; });
    }
  });
})();
