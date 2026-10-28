import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome stand-in: storage, the tab the worker opens, and the call
// that keeps the service worker awake.
const store = {};
const openedTabs = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
  tabs: { create: async ({ url }) => { openedTabs.push(url); return { id: openedTabs.length }; } },
  runtime: { getPlatformInfo: async () => ({}) },
};

const { accountLoginState, cancelAccountLogin, requestedProvider, signInFailureDetail, startAccountLogin, submitAccountInput, trustedKimiVerificationUrl } = await import('../src/background/account-login.js');

test('Kimi verification origins reject credentials, cleartext, alternate ports and lookalike hosts', () => {
  assert.equal(trustedKimiVerificationUrl('https://auth.kimi.com/authorize'), true);
  assert.equal(trustedKimiVerificationUrl('https://www.kimi.com/code/authorize?user_code=TEST'), true);
  for (const url of ['http://www.kimi.com/authorize', 'https://user@www.kimi.com/authorize', 'https://www.kimi.com:8443/authorize', 'https://www.kimi.com.evil.test/authorize', 'https://auth.kimi.ai/authorize', 'javascript:alert(1)']) {
    assert.equal(trustedKimiVerificationUrl(url), false, url);
  }
});

test('Kimi device sign-in opens the trusted complete URL and stores tokens only in its account record', async () => {
  stubFetch((url) => {
    if (url.endsWith('/device_authorization')) return Response.json({ device_code: 'PRIVATE-DEVICE', user_code: 'KIMI-1234', verification_uri: 'https://www.kimi.com/code/authorize', verification_uri_complete: 'https://www.kimi.com/code/authorize?user_code=KIMI-1234', interval: 1, expires_in: 60 });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'KIMI-ACCESS', refresh_token: 'KIMI-REFRESH', expires_in: 3600 });
    throw new Error('Unexpected auth origin');
  });
  const shown = await startAccountLogin('kimi', { post });
  await settled('auth-success', 0, 5000);
  assert.equal(shown.userCode, 'KIMI-1234');
  assert.equal(openedTabs[0], 'https://www.kimi.com/code/authorize?user_code=KIMI-1234');
  assert.equal(store['accountAuth.kimi'].credential.access, 'KIMI-ACCESS');
  assert.ok(calls.every((call) => call.url.startsWith('https://auth.kimi.com/')));
  assert.ok(!JSON.stringify(events).includes('PRIVATE-DEVICE'));
  assert.ok(!JSON.stringify(events).includes('KIMI-ACCESS'));
});

test('Kimi sign-in rejects a malicious verification URL before opening or polling it', async () => {
  stubFetch(() => Response.json({ device_code: 'PRIVATE', user_code: 'CODE', verification_uri: 'https://www.kimi.com/code/authorize', verification_uri_complete: 'https://www.kimi.com.evil.test/authorize', interval: 1, expires_in: 60 }));
  await assert.rejects(startAccountLogin('kimi', { post }), /sign-in failed/i);
  await settled('auth-error');
  assert.equal(openedTabs.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(store['accountAuth.kimi'], undefined);
});

test('Kimi cancellation prevents a device poll from storing a credential', async () => {
  stubFetch(() => Response.json({ device_code: 'PRIVATE', user_code: 'CODE', verification_uri: 'https://www.kimi.com/code/authorize', verification_uri_complete: 'https://www.kimi.com/code/authorize?user_code=CODE', interval: 1, expires_in: 60 }));
  await startAccountLogin('kimi', { post });
  await cancelAccountLogin('kimi');
  await settled('auth-error');
  assert.equal(calls.length, 1);
  assert.equal(store['accountAuth.kimi'], undefined);
});

test('malformed Kimi token payloads never expose partial credentials in auth events or failure records', async () => {
  stubFetch((url) => url.endsWith('/device_authorization')
    ? Response.json({ device_code: 'PRIVATE-DEVICE', user_code: 'CODE', verification_uri: 'https://www.kimi.com/code/authorize', verification_uri_complete: 'https://www.kimi.com/code/authorize?user_code=CODE', interval: 1, expires_in: 60 })
    : Response.json({ access_token: 'PRIVATE-PARTIAL-TOKEN' }));
  await startAccountLogin('kimi', { post });
  await settled('auth-error', 0, 5000);
  assert.ok(!JSON.stringify(events).includes('PRIVATE-PARTIAL-TOKEN'));
  assert.ok(!JSON.stringify(store).includes('PRIVATE-PARTIAL-TOKEN'));
  assert.equal(events.find((event) => event.type === 'auth-error').message, 'The sign-in failed. Please try again.');
});

let calls;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
}

const events = [];
const post = (message) => events.push(message);

/** Waits until the panel is told something of this kind happened. */
function settled(type, from = 0, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = events.slice(from).find((event) => event.type === type);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`no ${type} event came`));
      setTimeout(check, 5);
    };
    check();
  });
}

// pi-ai reads the ChatGPT account id out of the access token.
const accessToken = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })).toString('base64url')}.s`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  openedTabs.length = 0;
  events.length = 0;
  calls = [];
});

test('the ChatGPT sign-in picks the device code method and shows the code', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev1', user_code: 'ABCD-1234', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code1', code_verifier: 'ver1' });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: accessToken, refresh_token: 'rt', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });

  const shown = await startAccountLogin('chatgpt', { post });
  // The sign-in finishes here, so nothing of it runs on into the next test.
  await settled('auth-success');

  assert.equal(shown.userCode, 'ABCD-1234');
  assert.equal(shown.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.ok(openedTabs.includes('https://auth.openai.com/codex/device'), 'the worker opens the verification page');
  assert.ok(calls.some((call) => call.url.endsWith('/deviceauth/usercode')), 'the device code method was used');
  assert.ok(!calls.some((call) => call.url.endsWith('/oauth/authorize')), 'the browser method was not used');

  const state = accountLoginState('chatgpt');
  assert.equal(state.deviceCode, 'ABCD-1234');
  assert.equal(state.needsCode, false);
});

test('the Claude sign-in picks the copy code method and takes the pasted code', async () => {
  stubFetch((url) => {
    if (url.endsWith('/v1/oauth/token')) return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });

  const started = startAccountLogin('claude', { post });
  await started; // the authorization page was opened
  const state = accountLoginState('claude');
  assert.equal(state.phase, 'awaiting-code');
  assert.equal(state.needsCode, true);

  // Anthropic shows "code#state" after the sign-in; the state is the verifier
  // the worker put in the authorization URL.
  const verifier = new URL(openedTabs[0]).searchParams.get('state');
  submitAccountInput('claude', state.id, `the-code#${verifier}`);

  const done = await settled('auth-success');
  assert.equal(done.provider, 'claude');
  const exchange = calls.find((call) => call.url.endsWith('/v1/oauth/token'));
  const body = JSON.parse(exchange.init.body);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code, 'the-code');
  assert.equal(body.redirect_uri, 'https://platform.claude.com/oauth/code/callback', 'the copy code method was used');
  assert.equal(store['accountAuth.claude'].credential.access, 'at');
});

test('a Claude code copied across wrapped lines still exchanges', async () => {
  stubFetch((url) => {
    if (url.endsWith('/v1/oauth/token')) return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });

  await startAccountLogin('claude', { post });
  const state = accountLoginState('claude');
  const verifier = new URL(openedTabs[0]).searchParams.get('state');
  // The Claude page wraps the code. Selecting it, or pasting into the one-line
  // field, puts breaks and spaces in the middle of code#state.
  submitAccountInput('claude', state.id, `Paste this:\nthe-code\n#\n${verifier}\n`);

  await settled('auth-success');
  const body = JSON.parse(calls.find((call) => call.url.endsWith('/v1/oauth/token')).init.body);
  assert.equal(body.code, 'the-code');
  assert.equal(body.state, verifier);
});

test('a cancelled sign-in stops and says so', async () => {
  stubFetch(() => { throw new Error('the cancelled sign-in must not reach the network'); });

  const started = startAccountLogin('claude', { post });
  await started;
  await cancelAccountLogin('claude');

  const failure = await settled('auth-error');
  assert.equal(failure.provider, 'claude');
  assert.match(failure.message, /cancelled/i);
  assert.equal(failure.code, 'cancelled', 'the panel translates the code, not the English text');
  const state = accountLoginState('claude');
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.needsCode, false);
  assert.equal(state.code, 'cancelled');
  assert.equal(store.authLastFailure, undefined, 'a cancelled sign-in is not recorded');
});
test('a sign-in replaced before it showed anything still answers, and stays quiet', async () => {
  // A request that answers only by being aborted, as a real fetch does.
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  // The user-code request of the first sign-in never answers.
  stubFetch((url, init, n) => {
    if (n === 1) return hang(init);
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev2', user_code: 'WXYZ-9876', interval: '1' });
    return hang(init);
  });

  const first = startAccountLogin('chatgpt', { post });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = startAccountLogin('chatgpt', { post });

  await assert.rejects(first, /replaced/);
  assert.equal((await second).userCode, 'WXYZ-9876');
  assert.ok(!events.some((event) => event.type === 'auth-error'), 'a replaced sign-in posts no error');
  await cancelAccountLogin('chatgpt');
});

test('a sign-in cancelled before it asks for the code never asks', async () => {
  stubFetch(() => { throw new Error('no network in this test'); });

  const started = startAccountLogin('claude', { post });
  await cancelAccountLogin('claude'); // lands while pi-ai is still making the PKCE pair

  await assert.rejects(started, /cancelled/);
  await settled('auth-error');
  assert.ok(!events.some((event) => event.type === 'auth-prompt'), 'no code prompt after the cancel');
  assert.equal(accountLoginState('claude').phase, 'cancelled');
});

test('ChatGPT without device-code sign-in says how to turn it on', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return new Response('not found', { status: 404 });
    throw new Error(`unexpected ${url}`);
  });

  await assert.rejects(startAccountLogin('chatgpt', { post }), /device code authorization/i);
  const failure = await settled('auth-error');
  assert.match(failure.message, /auth\.json/);
  assert.equal(failure.code, 'device-code-disabled');
});

test('a failed sign-in posts a fixed message, never what the provider answered', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return new Response('{"detail":"https://evil.example/?token=leak"}', { status: 500 });
    throw new Error(`unexpected ${url}`);
  });

  const failure = await startAccountLogin('chatgpt', { post }).catch((err) => err);
  assert.equal(failure.message, 'The sign-in failed. Please try again.');
  assert.equal(failure.code, 'failed', 'the rejection carries the code the panel translates');
  const posted = await settled('auth-error');
  assert.equal(posted.message, 'The sign-in failed. Please try again.');
  assert.equal(posted.code, 'failed');
  assert.equal(accountLoginState('chatgpt').code, 'failed', 'the login state carries the code too');
});

test('a panel request names its provider; one that names none is refused, not taken as ChatGPT', () => {
  assert.equal(requestedProvider({ type: 'auth-start', provider: 'claude' }), 'claude');
  for (const provider of [undefined, '', 'openai']) {
    assert.throws(() => requestedProvider({ type: 'auth-start', provider }), /account provider/i);
  }
});

test('the state of a provider without a sign-in is empty', () => {
  assert.equal(accountLoginState('grok'), null);
});

test('a finished sign-in is still there, so the panel can tell it from a lost one', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev1', user_code: 'ABCD-1234', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code1', code_verifier: 'ver1' });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: accessToken, refresh_token: 'rt', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });

  await startAccountLogin('chatgpt', { post });
  await settled('auth-success');

  const state = accountLoginState('chatgpt');
  assert.equal(state.phase, 'signed-in');
  assert.equal(state.deviceCode, 'ABCD-1234');
});

test('nothing the panel gets carries a token, a code or an authorization URL', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev1', user_code: 'ABCD-1234', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code1', code_verifier: 'ver1' });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: accessToken, refresh_token: 'the-refresh-token', expires_in: 3600 });
    if (url.endsWith('/v1/oauth/token')) return Response.json({ access_token: 'the-access-token', refresh_token: 'the-refresh-token', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });

  await startAccountLogin('chatgpt', { post });
  await settled('auth-success');
  const before = events.length;
  const claudeStarted = startAccountLogin('claude', { post });
  await claudeStarted;
  const verifier = new URL(openedTabs.find((url) => url.includes('claude.ai'))).searchParams.get('state');
  submitAccountInput('claude', accountLoginState('claude').id, `the-code#${verifier}`);
  await settled('auth-success', before);

  for (const event of events) {
    const text = JSON.stringify(event);
    assert.ok(!text.includes('the-access-token'), 'a token must not be posted');
    assert.ok(!text.includes('the-refresh-token'), 'a refresh token must not be posted');
    assert.ok(!text.includes('the-code'), 'an authorization code must not be posted');
    assert.ok(!text.includes(verifier), 'the PKCE verifier must not be posted');
    assert.ok(!text.includes('code_challenge'), 'an authorization URL must not be posted');
    assert.ok(!/[?&]state=/.test(text), 'an authorization URL must not be posted');
  }
});

const SECRET = 'sekret-access-token-value';
const LOUD_BODY = {
  error: 'invalid_grant',
  error_description: `OAuth state mismatch status=200 Failed to fetch ${SECRET}`,
  access_token: SECRET,
};

/** The shape pi-ai gives the worker: the HTTP error wrapped, with the body inside. */
function wrappedExchange({ status = '400', body = LOUD_BODY, trailer = '; stack=Error: stack' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return 'Token exchange request failed. url=https://platform.claude.com/v1/oauth/token; redirect_uri=https://platform.claude.com/oauth/code/callback; response_type=authorization_code; details=Error: HTTP request failed. status='
    + `${status}; url=https://platform.claude.com/v1/oauth/token; body=${payload}${trailer}`;
}

function hidesSecrets(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('error_description'), false);
}

test('a wrapped token error keeps only the status and the OAuth name', () => {
  const detail = signInFailureDetail(new Error(wrappedExchange()));
  assert.deepEqual(detail, { kind: 'http', status: 400, oauthError: 'invalid_grant' });
  hidesSecrets(detail);

  const network = signInFailureDetail(new Error(
    'Token exchange request failed. url=https://platform.claude.com/v1/oauth/token; redirect_uri=https://platform.claude.com/oauth/code/callback; response_type=authorization_code; details=TypeError: Failed to fetch; stack=TypeError: Failed to fetch',
  ));
  assert.deepEqual(network, { kind: 'network', status: null, oauthError: null });

  const invalid = signInFailureDetail(new Error(
    `Token exchange returned invalid JSON. url=https://platform.claude.com/v1/oauth/token; body=<html>OAuth state mismatch status=200 Failed to fetch ${SECRET}</html>`,
  ));
  assert.deepEqual(invalid, { kind: 'invalid-json', status: null, oauthError: null });
  hidesSecrets(invalid);

  assert.deepEqual(signInFailureDetail(new Error('OAuth state mismatch')), { kind: 'state-mismatch', status: null, oauthError: null });
  assert.deepEqual(signInFailureDetail(new Error('Missing authorization code')), { kind: 'missing-code', status: null, oauthError: null });
  assert.deepEqual(signInFailureDetail(new Error(wrappedExchange({ status: '99' }))), { kind: 'other', status: null, oauthError: null });
  assert.deepEqual(signInFailureDetail(new Error(wrappedExchange({ status: '600' }))), { kind: 'other', status: null, oauthError: null });
  assert.deepEqual(signInFailureDetail(new Error(wrappedExchange({ status: '4000' }))), { kind: 'other', status: null, oauthError: null });
  assert.deepEqual(
    signInFailureDetail(new Error(wrappedExchange({ body: { error: 'Invalid Grant', access_token: SECRET } }))),
    { kind: 'http', status: 400, oauthError: null },
  );
  assert.deepEqual(
    signInFailureDetail(new Error(wrappedExchange({ body: { error: 'the code was rejected outright', access_token: SECRET } }))),
    { kind: 'http', status: 400, oauthError: null },
  );
});

test('words inside the token body do not change the kind', () => {
  const detail = signInFailureDetail(new Error(wrappedExchange({
    body: {
      error: 'invalid_grant',
      error_description: `OAuth state mismatch status=200 Failed to fetch ${SECRET}`,
      access_token: SECRET,
    },
  })));
  assert.equal(detail.kind, 'http');
  assert.equal(detail.status, 400);
  assert.equal(detail.oauthError, 'invalid_grant');
  hidesSecrets(detail);
});

test('a refused Claude code is recorded without the response body', async () => {
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args); };
  stubFetch((url) => {
    if (url.endsWith('/v1/oauth/token')) {
      return new Response(JSON.stringify(LOUD_BODY), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    await startAccountLogin('claude', { post });
    const state = accountLoginState('claude');
    const verifier = new URL(openedTabs[0]).searchParams.get('state');
    submitAccountInput('claude', state.id, `the-code#${verifier}`);
    const failure = await settled('auth-error');
    assert.equal(failure.code, 'failed');
    assert.equal(failure.message, 'The sign-in failed. Please try again.');
    hidesSecrets(events);
    const record = store.authLastFailure;
    assert.equal(record.provider, 'claude');
    assert.equal(record.kind, 'http');
    assert.equal(record.status, 400);
    assert.equal(record.oauthError, 'invalid_grant');
    assert.equal(typeof record.at, 'number');
    hidesSecrets(record);
    hidesSecrets(lines);
  } finally {
    console.info = original;
  }
});

test('a Claude exchange that never connects is recorded as a network failure', async () => {
  stubFetch(() => { throw new TypeError('Failed to fetch'); });
  await startAccountLogin('claude', { post });
  const state = accountLoginState('claude');
  const verifier = new URL(openedTabs[0]).searchParams.get('state');
  submitAccountInput('claude', state.id, `the-code#${verifier}`);
  const failure = await settled('auth-error');
  assert.equal(failure.code, 'failed');
  assert.equal(failure.message, 'The sign-in failed. Please try again.');
  assert.deepEqual(
    { kind: store.authLastFailure.kind, status: store.authLastFailure.status, oauthError: store.authLastFailure.oauthError },
    { kind: 'network', status: null, oauthError: null },
  );
});

test('a code from another Claude sign-in is named, and a paste with no code is named', async () => {
  stubFetch(() => { throw new Error('the exchange must not run'); });
  await startAccountLogin('claude', { post });
  const state = accountLoginState('claude');
  submitAccountInput('claude', state.id, 'the-code#otherstate');
  const mismatch = await settled('auth-error');
  assert.equal(mismatch.code, 'state-mismatch');
  assert.equal(mismatch.message, 'That code is from a different sign-in. Start again, then paste the new code.');
  assert.equal(store.authLastFailure.kind, 'state-mismatch');

  events.length = 0;
  await startAccountLogin('claude', { post });
  // The state is checked first. An empty code with this sign-in's own state
  // is the missing-code case; a different state is the mismatch above.
  const verifier = new URL(openedTabs[openedTabs.length - 1]).searchParams.get('state');
  submitAccountInput('claude', accountLoginState('claude').id, `#${verifier}`);
  const missing = await settled('auth-error');
  assert.equal(missing.code, 'missing-code');
  assert.equal(missing.message, 'No authorization code was found. Paste the whole code shown on the sign-in page.');
  assert.equal(store.authLastFailure.kind, 'missing-code');
});

test('a storage failure still tells the panel', async () => {
  const rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const original = chrome.storage.local.set;
  chrome.storage.local.set = async (obj) => {
    if (Object.prototype.hasOwnProperty.call(obj, 'authLastFailure')) throw new Error('disk full');
    return original(obj);
  };
  stubFetch(() => { throw new Error('the exchange must not run'); });
  try {
    await startAccountLogin('claude', { post });
    submitAccountInput('claude', accountLoginState('claude').id, 'the-code#otherstate');
    const failure = await settled('auth-error');
    assert.equal(failure.code, 'state-mismatch');
    assert.equal(store.authLastFailure, undefined);
    await tick();
    assert.equal(rejections.length, 0);
  } finally {
    chrome.storage.local.set = original;
    process.off('unhandledRejection', onRejection);
  }
});
