import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage stand-in shared by the auth module.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
};

const {
  accountStatus, beginAccountAttempt, getValidCredential, readCredential,
  setAccountFlows, signOut, storeCredential,
} = await import('../src/providers/account-auth.js');

// The refresh each provider gets, so the tests can say what the provider answers.
const refreshHandlers = new Map();
const flowStub = (provider) => ({
  name: provider,
  async login() { throw new Error('the login flow is not used in this test'); },
  async refresh(credential, signal) {
    const handler = refreshHandlers.get(provider);
    if (!handler) throw new Error(`no refresh handler for ${provider}`);
    return handler(credential, signal);
  },
});
setAccountFlows({
  openaiCodexOAuth: flowStub('chatgpt'),
  anthropicOAuth: flowStub('claude'),
  xaiOAuth: flowStub('grok'),
});

const expiresSoon = (from = Date.now()) => from + 3600e3;

/** A stored credential for a provider, with the given expiry. */
function putRecord(provider, credential) {
  store[`accountAuth.${provider}`] = { generation: 1, credential };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  refreshHandlers.clear();
});

test('the ChatGPT sign-in of an older version moves into the per-provider key', async () => {
  store.chatgptAuth = {
    accessToken: 'at', refreshToken: 'rt', accountId: 'acc_1', email: 'me@x.y',
    planType: 'pro', expiresAt: 1000, idToken: 'idt',
  };

  const credential = await readCredential('chatgpt');

  assert.equal(credential.access, 'at');
  assert.equal(credential.refresh, 'rt');
  assert.equal(credential.expires, 1000);
  assert.equal(credential.accountId, 'acc_1');
  assert.equal(credential.email, 'me@x.y');
  assert.equal(credential.planType, 'pro');
  assert.equal(credential.idToken, 'idt');
  assert.equal(store.chatgptAuth, undefined, 'the old key is removed');
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'at');
});

test('the migration runs once and leaves a record that is already there alone', async () => {
  store.chatgptAuth = { accessToken: 'old', refreshToken: 'rt' };
  putRecord('chatgpt', { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() });

  const credential = await readCredential('chatgpt');

  assert.equal(credential.access, 'new');
  assert.equal(store.chatgptAuth, undefined);
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'new');
});

test('the old ChatGPT sign-in moves in even over a signed-out record', async () => {
  store['accountAuth.chatgpt'] = { generation: 4, credential: null };
  store.chatgptAuth = { accessToken: 'restored', refreshToken: 'rt', expiresAt: 1000 };

  const credential = await readCredential('chatgpt');

  assert.equal(credential.access, 'restored');
  assert.equal(store['accountAuth.chatgpt'].generation, 5, 'the generation keeps counting up');
  assert.equal(store.chatgptAuth, undefined);
});

test('a credential is refreshed with ten minutes left, and left alone with eleven', async () => {
  let refreshes = 0;
  refreshHandlers.set('chatgpt', async () => {
    refreshes += 1;
    return { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() };
  });
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() + 11 * 60 * 1000 });

  assert.equal((await getValidCredential('chatgpt')).access, 'old');
  assert.equal(refreshes, 0, 'eleven minutes are plenty');

  store['accountAuth.chatgpt'].credential.expires = Date.now() + 10 * 60 * 1000;
  assert.equal((await getValidCredential('chatgpt')).access, 'new');
  assert.equal(refreshes, 1);
});

test('two callers that need a refresh share one', async () => {
  let refreshes = 0;
  refreshHandlers.set('chatgpt', async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() };
  });
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  const [first, second] = await Promise.all([getValidCredential('chatgpt'), getValidCredential('chatgpt')]);

  assert.equal(refreshes, 1);
  assert.equal(first.access, 'new');
  assert.equal(second.access, 'new');
});

test('two providers refreshing at the same time keep their own tokens', async () => {
  refreshHandlers.set('chatgpt', async () => ({ type: 'oauth', access: 'chatgpt-new', refresh: 'rt-c', expires: expiresSoon() }));
  refreshHandlers.set('claude', async () => ({ type: 'oauth', access: 'claude-new', refresh: 'rt-a', expires: expiresSoon() }));
  putRecord('chatgpt', { type: 'oauth', access: 'chatgpt-old', refresh: 'rt-c', expires: Date.now() - 1 });
  putRecord('claude', { type: 'oauth', access: 'claude-old', refresh: 'rt-a', expires: Date.now() - 1 });

  const [chatgpt, claude] = await Promise.all([getValidCredential('chatgpt'), getValidCredential('claude')]);

  assert.equal(chatgpt.access, 'chatgpt-new');
  assert.equal(claude.access, 'claude-new');
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'chatgpt-new');
  assert.equal(store['accountAuth.claude'].credential.access, 'claude-new');
});

test('the rotated refresh token is in storage before the new credential is handed out', async () => {
  refreshHandlers.set('chatgpt', async () => ({ type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() }));
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  const credential = await getValidCredential('chatgpt').then((fresh) => {
    assert.equal(store['accountAuth.chatgpt'].credential.refresh, 'rt2', 'the rotated token must be stored first');
    return fresh;
  });

  assert.equal(credential.refresh, 'rt2');
});

test('a refresh that finishes after a sign-out does not bring the account back', async () => {
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  refreshHandlers.set('chatgpt', () => new Promise((resolve) => {
    release = () => resolve({ type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() });
    started();
  }));
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  const refreshing = getValidCredential('chatgpt');
  await running;
  await signOut('chatgpt');
  release();

  await assert.rejects(refreshing, /not connected/);
  assert.equal(store['accountAuth.chatgpt'].credential, null);
});

test('a late refresh failure does not delete a newer sign-in', async () => {
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  refreshHandlers.set('chatgpt', () => new Promise((resolve, reject) => {
    release = () => reject(new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'));
    started();
  }));
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  const refreshing = getValidCredential('chatgpt');
  await running;
  await storeCredential('chatgpt', { type: 'oauth', access: 'signed-in-again', refresh: 'rt3', expires: expiresSoon() });
  release();

  await assert.rejects(refreshing, /expired/);
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'signed-in-again');
});

test('a login is stored while its attempt is the current one', async () => {
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: expiresSoon() });
  const attemptId = await beginAccountAttempt('chatgpt', 'attempt-1');

  const stored = await storeCredential('chatgpt', { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() }, { attemptId });

  assert.equal(stored.access, 'new');
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'new');
});

test('a login that finishes after a sign-out is dropped', async () => {
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: expiresSoon() });
  const attemptId = await beginAccountAttempt('chatgpt', 'attempt-1');

  await signOut('chatgpt');
  const stored = await storeCredential('chatgpt', { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() }, { attemptId });

  assert.equal(stored, null);
  assert.equal(store['accountAuth.chatgpt'].credential, null);
});

test('a login that finishes after an import is dropped', async () => {
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: expiresSoon() });
  const attemptId = await beginAccountAttempt('chatgpt', 'attempt-1');

  await storeCredential('chatgpt', { type: 'oauth', access: 'imported', refresh: 'rt-import', expires: expiresSoon() });
  const stored = await storeCredential('chatgpt', { type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon() }, { attemptId });

  assert.equal(stored, null);
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'imported');
});

test('a refresh that answers with no tokens keeps the old record', async () => {
  // pi-ai's Anthropic refresh turns an HTTP 200 with an empty body into
  // undefined tokens and a NaN expiry.
  refreshHandlers.set('claude', async () => ({ type: 'oauth', access: undefined, refresh: undefined, expires: Number.NaN }));
  putRecord('claude', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  await assert.rejects(getValidCredential('claude'), /could not be refreshed/);
  assert.equal(store['accountAuth.claude'].credential.access, 'old');
});

test('a confirmed OAuth rejection signs the account out', async () => {
  const rejections = [
    { provider: 'chatgpt', error: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant","error_description":"The refresh token is invalid"}') },
    { provider: 'claude', error: new Error('Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error":"invalid_grant"}') },
    { provider: 'grok', error: new Error('xAI OAuth token refresh failed (HTTP 400): invalid_grant: The refresh token is invalid') },
  ];
  for (const { provider, error } of rejections) {
    refreshHandlers.set(provider, async () => { throw error; });
    putRecord(provider, { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

    const failure = await getValidCredential(provider).catch((err) => err);
    assert.equal(failure.name, 'AccountAuthError');
    assert.equal(failure.retryable, false, `${provider} must ask for a new sign-in`);
    assert.match(failure.message, /expired/);
    assert.equal(store[`accountAuth.${provider}`].credential, null, `${provider} must be signed out`);
  }
});

test('a failure that is not a confirmed rejection keeps the record', async () => {
  const failures = [
    new Error('OpenAI Codex token refresh failed (429): {"error":"rate_limit_exceeded"}'),
    new Error('OpenAI Codex token refresh failed (500): {"error":"server_error"}'),
    new Error('OpenAI Codex token refresh failed (408): timeout'),
    new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_request"}'),
    new Error('OpenAI Codex token refresh error: fetch failed'),
    new Error('OpenAI Codex token refresh response missing fields: {}'),
  ];
  for (const error of failures) {
    refreshHandlers.set('chatgpt', async () => { throw error; });
    putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

    const failure = await getValidCredential('chatgpt').catch((err) => err);
    assert.equal(failure.retryable, true, `${error.message} must stay retryable`);
    assert.match(failure.message, /could not be refreshed/);
    assert.equal(store['accountAuth.chatgpt'].credential.access, 'old', `${error.message} must keep the record`);
  }
});

test('an early refresh that fails for a passing reason hands out the token that still works', async () => {
  refreshHandlers.set('claude', async () => { throw new Error('Anthropic token refresh request failed. url=x; details=fetch failed'); });
  putRecord('claude', { type: 'oauth', access: 'still-good', refresh: 'rt', expires: Date.now() + 5 * 60 * 1000 });

  assert.equal((await getValidCredential('claude')).access, 'still-good');
  await assert.rejects(getValidCredential('claude', { forceRefresh: true }), /could not be refreshed/);
});

test('a refresh keeps what the record knew that the provider did not send again', async () => {
  refreshHandlers.set('chatgpt', async () => ({ type: 'oauth', access: 'new', refresh: 'rt2', expires: expiresSoon(), accountId: 'acc_1' }));
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1, accountId: 'acc_1', email: 'me@x.y', planType: 'pro', idToken: 'idt' });

  const credential = await getValidCredential('chatgpt');

  assert.equal(credential.access, 'new');
  assert.equal(credential.refresh, 'rt2');
  assert.equal(credential.email, 'me@x.y');
  assert.equal(store['accountAuth.chatgpt'].credential.planType, 'pro');
  assert.equal(store['accountAuth.chatgpt'].credential.refresh, 'rt2');
});

test('the error of a failed refresh never carries the upstream text', async () => {
  refreshHandlers.set('chatgpt', async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant","error_description":"secret-detail"}'); });
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: Date.now() - 1 });

  const error = await getValidCredential('chatgpt').catch((err) => err);

  assert.ok(!error.message.includes('invalid_grant'));
  assert.ok(!error.message.includes('secret-detail'));
});

test('the status of a provider says who is signed in', async () => {
  putRecord('chatgpt', { type: 'oauth', access: 'old', refresh: 'rt', expires: expiresSoon(), accountId: 'acc_1', email: 'me@x.y', planType: 'pro' });

  assert.deepEqual(await accountStatus('chatgpt'), {
    connected: true, email: 'me@x.y', planType: 'pro', accountId: 'acc_1', expires: store['accountAuth.chatgpt'].credential.expires,
  });
  assert.deepEqual(await accountStatus('claude'), { connected: false });
});
