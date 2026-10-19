// No browser or frontend packages required: exercise the public API with WebAuthn stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/passkey.js', 'utf8');
const encoded = Buffer.from([251, 255, 0, 127]).toString('base64url');
const makeBuffer = () => Uint8Array.from([251, 255, 0, 127]).buffer;
const bytes = value => [...new Uint8Array(value)];

function harness(native = false) {
  const requests = [];
  const ceremonies = [];
  const assigned = [];
  const toasts = [];
  const events = [];
  let mode = 'success';
  let responseError = null;
  let domError = null;
  const nativeOptions = { challenge: makeBuffer(), native: true };
  const credential = {
    id: encoded, rawId: makeBuffer(), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: makeBuffer(), attestationObject: makeBuffer(),
      authenticatorData: makeBuffer(), signature: makeBuffer(), userHandle: null,
      getTransports: () => ['internal', 'hybrid'] },
    getClientExtensionResults: () => ({}),
  };
  let jsonCalls = 0;
  const nativeCalls = [];
  function PublicKeyCredential() {}
  if (native) {
    PublicKeyCredential.parseCreationOptionsFromJSON = value => { nativeCalls.push(['create', value]); return nativeOptions; };
    PublicKeyCredential.parseRequestOptionsFromJSON = value => { nativeCalls.push(['get', value]); return nativeOptions; };
    credential.toJSON = () => { jsonCalls++; return { nativeCredential: true }; };
  }
  const ceremony = async (kind, options) => {
    ceremonies.push([kind, options]);
    if (domError) throw domError;
    return credential;
  };
  const context = {
    window: {}, document: { addEventListener() {} }, PublicKeyCredential,
    navigator: { userAgent: 'Macintosh', credentials: { create: opts => ceremony('create', opts), get: opts => ceremony('get', opts) } },
    CustomEvent: function(type) { this.type = type; },
    location: { assign: value => assigned.push(value) },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (responseError) return { ok: false, status: responseError.status, json: async () => ({ error: responseError.message }) };
      if (mode === 'network') throw new TypeError('network failure');
      const data = url.endsWith('/options') ? { challenge: encoded, user: { id: encoded },
        excludeCredentials: [{ id: encoded, transports: ['internal'] }], allowCredentials: [{ id: encoded }] }
        : url === '/login/passkey/verify' ? { redirect: '/book/x?y=1' } : { ok: true };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  context.window.PublicKeyCredential = PublicKeyCredential;
  context.window.binderyToast = message => toasts.push(message);
  context.window.dispatchEvent = event => events.push(event.type);
  vm.runInNewContext(source, context);
  return { api: context.window.binderyPasskey, requests, ceremonies, assigned, nativeCalls,
    credential, toasts, events,
    jsonCalls: () => jsonCalls, responseError: value => { responseError = value; },
    domError: value => { domError = value; }, networkError: () => { mode = 'network'; }, context };
}

(async () => {
  const fallback = harness();
  assert.equal(fallback.api.supported(), true);
  await fallback.api.register({ name: 'Mac' });
  const creation = fallback.ceremonies[0][1].publicKey;
  assert.deepEqual(bytes(creation.challenge), [251, 255, 0, 127]);
  assert.deepEqual(bytes(creation.user.id), [251, 255, 0, 127]);
  assert.deepEqual(bytes(creation.excludeCredentials[0].id), [251, 255, 0, 127]);
  assert.deepEqual([...creation.excludeCredentials[0].transports], ['internal']);
  const registration = fallback.requests[1].body;
  assert.equal(registration.name, 'Mac');
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature']) {
    assert.equal(registration.credential.response[key], encoded);
  }
  assert.equal(registration.credential.rawId, encoded);
  assert.equal(registration.credential.response.userHandle, null);
  assert.deepEqual(registration.credential.response.transports, ['internal', 'hybrid']);
  fallback.credential.response.userHandle = makeBuffer();
  await fallback.api.login('/book/x?y=1');
  assert.deepEqual(bytes(fallback.ceremonies[1][1].publicKey.allowCredentials[0].id), [251, 255, 0, 127]);
  assert.equal(fallback.requests[3].body.next, '/book/x?y=1');
  assert.equal(fallback.requests[3].body.credential.response.userHandle, encoded);
  assert.deepEqual(fallback.assigned, ['/book/x?y=1']);
  await fallback.api.reauth('password');
  assert.deepEqual(fallback.requests[4].body, { password: 'password' });
  for (const request of fallback.requests) {
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
  }
  const native = harness(true);
  await native.api.register({ name: 'iPhone' });
  await native.api.login('/');
  assert.deepEqual(native.nativeCalls.map(call => call[0]), ['create', 'get']);
  assert.equal(native.ceremonies[0][1].publicKey.native, true);
  assert.equal(native.jsonCalls(), 2);
  assert.deepEqual(native.requests[1].body.credential, { nativeCredential: true });
  assert.deepEqual(native.requests[3].body.credential, { nativeCredential: true });
  for (const [name, code] of [['NotAllowedError', 'cancelled'], ['AbortError', 'cancelled'], ['InvalidStateError', 'exists']]) {
    const state = harness(); state.domError({ name });
    await assert.rejects(state.api.register({ name: '' }), error => error.code === code);
  }
  const stale = harness(); stale.responseError({ status: 403, message: 'needs_password' });
  await assert.rejects(stale.api.register({ name: '' }), error => error.code === 'needs_password');
  assert.equal(stale.ceremonies.length, 0);
  const server = harness(); server.responseError({ status: 400, message: '密码错误' });
  await assert.rejects(server.api.reauth('bad'), error => error.code === 'server' && error.message === '密码错误');
  const network = harness(); network.networkError();
  await assert.rejects(network.api.login('/'), error => error.code === 'server');
  const unsupported = harness(); unsupported.context.window.PublicKeyCredential = undefined;
  assert.equal(unsupported.api.supported(), false);

  // Exercise the shared Alpine state object without bringing Alpine into the test.
  const flow = harness();
  const dialog = flow.context.window.binderyPasskeyDialog();
  let nameFocus = 0;
  let passwordFocus = 0;
  dialog.$nextTick = callback => callback();
  dialog.$refs = { passkeyName: { focus: () => nameFocus++ }, passkeyPassword: { focus: () => passwordFocus++ } };
  dialog.show();
  assert.equal(dialog.name, 'Mac');
  assert.equal(dialog.open, true);
  flow.responseError({ status: 403, message: 'needs_password' });
  await dialog.create();
  assert.equal(dialog.step, 'confirm');
  assert.equal(dialog.busy, false);
  assert.equal(passwordFocus, 1);
  dialog.password = 'bad';
  flow.responseError({ status: 400, message: '密码错误' });
  await dialog.confirmPassword();
  assert.equal(dialog.message, '密码错误');
  assert.equal(dialog.step, 'confirm');
  flow.responseError(null);
  dialog.password = 'good';
  await dialog.confirmPassword();
  assert.equal(dialog.step, 'name');
  assert.equal(dialog.password, '');
  assert.ok(nameFocus >= 2);
  flow.domError({ name: 'NotAllowedError' });
  await dialog.create();
  assert.equal(dialog.step, 'name');
  assert.equal(dialog.message, '已取消。');
  assert.equal(dialog.danger, false);
  flow.domError({ name: 'InvalidStateError' });
  await dialog.create();
  assert.equal(dialog.message, '这个设备已经添加过通行密钥。');
  assert.equal(dialog.danger, true);
  flow.domError(null);
  flow.responseError({ status: 400, message: '服务器错误' });
  await dialog.create();
  assert.equal(dialog.message, '添加失败：服务器错误');
  flow.responseError(null);
  const pendingCreation = dialog.create();
  assert.equal(dialog.step, 'waiting');
  assert.equal(dialog.busy, true);
  dialog.close();
  assert.equal(dialog.open, true);
  await pendingCreation;
  assert.equal(dialog.open, false);
  assert.deepEqual(flow.toasts, ['已添加通行密钥']);
  assert.deepEqual(flow.events, ['passkey-added']);
  process.stdout.write('Passkey frontend conversion, transport, request and error checks passed\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
