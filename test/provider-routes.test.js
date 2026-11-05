import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CONNECTION_ROUTES, connectionRoute, routeForSettings } from '../src/sidepanel/provider-routes.js';
import { mergeSettings } from '../src/lib/settings.js';
import { signInOpenRouter } from '../src/providers/openrouter-auth.js';

test('subscription and key choices resolve to distinct existing provider paths', () => {
  assert.equal(connectionRoute('kimi-account').auth, 'account');
  assert.equal(connectionRoute('kimi').auth, 'apiKey');
  assert.equal(connectionRoute('claude-api').provider, 'claude');
  for (const preset of ['openrouter', 'minimax', 'minimax-coding-plan', 'zai', 'zai-coding']) {
    assert.equal(connectionRoute(`api:${preset}`).preset, preset);
  }
  assert.equal(CONNECTION_ROUTES.filter((route) => route.provider === 'gemini').length, 1);
  assert.equal(routeForSettings(mergeSettings({ provider: 'claude', claude: { auth: 'apiKey' } })), 'claude-api');
  assert.equal(routeForSettings(mergeSettings({ provider: 'kimi', kimi: { auth: 'account' } })), 'kimi-account');
  assert.equal(routeForSettings(mergeSettings({ provider: 'compatible', compatible: { preset: 'openrouter' }, connectionRoute: 'openrouter-auth' })), 'openrouter-auth');
  assert.equal(mergeSettings({ transcription: { endpoint: 'http://localhost:8000/transcribe' } }).transcription.provider, 'custom');
});

test('OpenRouter exchanges a callback bound to a fresh PKCE verifier without browser credentials', async () => {
  let verifier;
  const identity = {
    getRedirectURL: (suffix) => `https://fixture.chromiumapp.org/${suffix}`,
    launchWebAuthFlow: async ({ url, interactive }) => {
      const auth = new URL(url); assert.equal(interactive, true);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      verifier = auth.searchParams.get('code_challenge');
      return `${auth.searchParams.get('callback_url')}?code=fixture-code`;
    },
  };
  assert.equal(await signInOpenRouter({ identity, cryptoApi: webcrypto, fetcher: async (url, request) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body); assert.equal(body.code, 'fixture-code');
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier))).toString('base64url');
    assert.equal(digest, verifier);
    return { ok: true, json: async () => ({ key: 'fixture-key' }) };
  } }), 'fixture-key');
});

test('OpenRouter rejects a substituted callback and resets its in-flight lock', async () => {
  const identity = { getRedirectURL: () => 'https://fixture.chromiumapp.org/expected', launchWebAuthFlow: async () => 'https://attacker.invalid/?code=x' };
  for (let i = 0; i < 2; i++) await assert.rejects(signInOpenRouter({ identity, cryptoApi: webcrypto, fetcher: () => { throw new Error('Must not exchange'); } }), /invalid sign-in callback/);
});
