import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthProtocolMismatch, request } from '../src/sidepanel/request.js';

test('unknown new auth routes identify a mismatched background, not bad credentials', async () => {
  assert.equal(isAuthProtocolMismatch('openrouter-login', {}, 'Unknown request openrouter-login'), true);
  assert.equal(isAuthProtocolMismatch('auth-start', { provider: 'kimi' }, 'Unknown account provider kimi.'), true);
  for (const provider of ['minimax', 'zai']) assert.equal(isAuthProtocolMismatch('auth-start', { provider }, `Unknown account provider ${provider}.`), true);
  assert.equal(isAuthProtocolMismatch('auth-start', { provider: 'kimi' }, 'HTTP 401'), false);
  assert.equal(isAuthProtocolMismatch('other', {}, 'Unknown request other'), false);
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: 'Unknown request openrouter-login' }) } };
  try { await assert.rejects(request('openrouter-login'), (error) => error.code === 'worker-outdated' && /Reload/.test(error.message)); }
  finally { globalThis.chrome = previous; }
});
