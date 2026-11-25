import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimaxOAuth, zaiOAuth, trustedPlanVerificationUrl } from '../src/providers/plan-oauth.js';
import { PlanAccountSession, planAccountProvider } from '../src/providers/plan-account.js';
import { isDeadToken } from '../src/providers/account-auth.js';
import { mergeSettings } from '../src/lib/settings.js';

const reply = (body) => Response.json(body);
function mockFetch(t, run) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return run(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('MiniMax binds device authorization to PKCE/state and refreshes at the fixed authority', async (t) => {
  let challenge;
  mockFetch(t, async (url, init) => {
    const body = init.body;
    if (url.endsWith('/device/code')) {
      challenge = body.get('code_challenge');
      return reply({ state: body.get('state'), user_code: 'SYNTHETIC', verification_uri: 'https://account.minimax.io/verify', expired_in: Date.now() + 60000, interval: 1000 });
    }
    assert.equal(url, 'https://account.minimax.io/oauth2/token');
    if (body.get('grant_type') !== 'refresh_token') {
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
      assert.equal(hash, challenge);
    } else assert.equal(body.get('refresh_token'), 'synthetic-refresh');
    return reply({ status: 'success', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expired_in: Date.now() + 3600000 });
  });
  const events = [];
  const credential = await minimaxOAuth.login({ notify: (event) => events.push(event) });
  assert.equal(events[0].verificationUri, 'https://account.minimax.io/verify');
  assert.equal(credential.access, 'synthetic-access');
  assert.equal((await minimaxOAuth.refresh(credential)).refresh, 'synthetic-refresh');
});

test('Z.ai separates OAuth identity from short-lived project inference tokens', async (t) => {
  const calls = [];
  let pollToken;
  mockFetch(t, async (url, init) => {
    calls.push(url);
    if (url.endsWith('/init')) {
      pollToken = init.headers.Authorization;
      return reply({ code: 0, data: { flow_id: 'flow', authorize_url: 'https://zcode.z.ai/app/oauth/login', expires_at: Date.now() + 60000, poll_interval_sec: 1 } });
    }
    if (url.endsWith('/poll/flow')) {
      assert.equal(init.headers.Authorization, pollToken);
      return reply({ code: 0, data: { status: 'ready', user: { user_id: 'test-user' }, zai: { access_token: 'synthetic-identity' } } });
    }
    if (url.endsWith('/auth/z/login')) {
      assert.equal(JSON.parse(init.body).token, 'synthetic-identity');
      return reply({ code: 0, data: { access_token: 'synthetic-business' } });
    }
    if (url.endsWith('/getCustomerInfo')) return reply({ code: 200, data: { organizations: [{ organizationId: 'org', projects: [{ projectId: 'project' }] }] } });
    if (url.endsWith('/api_keys')) {
      if (init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), { name: 'postora-coding-plan', usageScene: 1 });
        return reply({ code: 200, data: { apiKey: 'key-id' } });
      }
      return reply({ code: 200, data: [] });
    }
    assert.equal(url, 'https://api.z.ai/api/biz/v1/organization/org/projects/project/api_keys/key-id/access_tokens');
    assert.equal(JSON.parse(init.body).clientType, 'postora');
    return reply({ code: 200, data: { tokenType: 'Bearer', accessToken: 'synthetic-inference', expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 } });
  });
  const credential = await zaiOAuth.login({ notify: () => {} });
  assert.equal(credential.access, 'synthetic-inference');
  assert.equal(credential.refresh, 'synthetic-identity');
  assert.ok(credential.expires > Date.now());
  const before = calls.length;
  await zaiOAuth.refresh(credential);
  assert.equal(calls.length - before, 2, 'refresh reuses the project/key location');
});

test('Z.ai counts the flow lifetime from the server clock, not the local one', async (t) => {
  let polled = false;
  mockFetch(t, async (url) => {
    // The local clock is ten minutes ahead of the server's: the flow has five minutes left.
    if (url.endsWith('/init')) return reply({ code: 0, data: { flow_id: 'flow', authorize_url: 'https://zcode.z.ai/app/oauth/login', expires_at: Date.now() - 5 * 60000, server_time: Date.now() - 10 * 60000, poll_interval_sec: 1 } });
    polled = true;
    return reply({ code: 0, data: { status: 'denied' } });
  });
  await assert.rejects(zaiOAuth.login({ notify: () => {} }), /denied/);
  assert.equal(polled, true, 'a skewed local clock does not end a live flow');
});

test('plan login refuses untrusted redirects and a substituted state', async (t) => {
  assert.equal(trustedPlanVerificationUrl('minimax', 'https://account.minimax.io/verify'), true);
  for (const url of ['http://account.minimax.io', 'https://account.minimax.io.evil.test', 'https://user@account.minimax.io', 'https://account.minimax.io:444']) {
    assert.equal(trustedPlanVerificationUrl('minimax', url), false);
  }
  mockFetch(t, async () => reply({ state: 'wrong' }));
  await assert.rejects(minimaxOAuth.login({ notify: () => assert.fail('must not open a page') }), /state mismatch/);
});

test('the plan account session keeps the usage setting of its preset', async () => {
  const { createModelSession } = await import('../src/agent/model-session.js');
  const settings = mergeSettings({ provider: 'compatible', connectionRoute: 'minimax-auth', compatible: { preset: 'minimax-coding-plan', model: 'MiniMax-M3.1-Flash' } });
  const session = createModelSession(settings, { notify: null });

  // Without the usage setting the stream reports no tokens, so a conversation
  // that never states its size is never compacted.
  assert.equal(session.active.usage, true, 'the account route reports the tokens of its turns');
});

test('account inference is pinned and does not use manual API credentials', () => {
  for (const provider of ['minimax', 'zai']) {
    const session = new PlanAccountSession({ accountProvider: provider, apiKey: 'manual-secret', baseUrl: 'https://evil.test', model: 'fixture', tools: [], systemPrompt: '' });
    assert.equal(session.apiKey, '');
    assert.equal(new URL(session.baseUrl).hostname, provider === 'minimax' ? 'api.minimax.io' : 'api.z.ai');
    assert.equal(session.strictRedirects, true);
    assert.equal(planAccountProvider({ provider: 'compatible', connectionRoute: `${provider}-auth` }), provider);
  }
});

test('inference uses the stored account token, and cancellation stops polling', async (t) => {
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async (key) => ({ [key]: { generation: 1, credential: { access: 'account-only', refresh: 'refresh', expires: Date.now() + 3600000 } } }) } } };
  t.after(() => { globalThis.chrome = previous; });
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://api.minimax.io/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer account-only');
    return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const session = new PlanAccountSession({ accountProvider: 'minimax', apiKey: 'manual-secret', model: 'MiniMax-M3.1-Flash', tools: [], systemPrompt: '' });
  await session.request('none', AbortSignal.timeout(3000), Date.now() + 3000);
});

test('cancelled device authorization never polls for a token', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  mockFetch(t, async (_url, init) => {
    calls++;
    return reply({ state: init.body.get('state'), user_code: 'SYNTHETIC', verification_uri: 'https://platform.minimax.io/verify', expired_in: Date.now() + 60000 });
  });
  await assert.rejects(minimaxOAuth.login({ signal: controller.signal, notify: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a rejected sign-in says why, and a dead token is not a failure worth retrying', async (t) => {
  mockFetch(t, async () => Response.json({ error: 'invalid_grant', error_description: 'synthetic expired grant' }, { status: 400 }));
  const error = await minimaxOAuth.refresh({ refresh: 'synthetic-refresh', access: 'stale' }).then(() => null, (err) => err);
  assert.ok(error, 'the refresh failed');
  assert.equal(error.status, 400);
  assert.equal(error.code, 'invalid_grant');
  assert.match(error.message, /invalid_grant/);
  assert.equal(isDeadToken(error, 'minimax'), true, 'the sign-in is over: the panel must ask for a new one');
});

test('a failure without a known OAuth code stays a failure worth retrying', async (t) => {
  mockFetch(t, async () => new Response('not json at all', { status: 500 }));
  const error = await minimaxOAuth.refresh({ refresh: 'synthetic-refresh', access: 'stale' }).then(() => null, (err) => err);
  assert.ok(error, 'the refresh failed');
  assert.equal(error.code, null);
  assert.equal(isDeadToken(error, 'minimax'), false, 'a server error may work the next time');

  mockFetch(t, async () => Response.json({ error: 'temporarily_unavailable' }, { status: 400 }));
  const other = await minimaxOAuth.refresh({ refresh: 'synthetic-refresh', access: 'stale' }).then(() => null, (err) => err);
  assert.equal(other.code, 'temporarily_unavailable');
  assert.equal(isDeadToken(other, 'minimax'), false, 'an unknown code is not a dead token');
});
