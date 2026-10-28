import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBundle } from '../scripts/build-vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMITTED = path.join(ROOT, 'src/vendor/pi-oauth.js');

test('the committed bundle is byte for byte what the build produces', async () => {
  const built = await buildBundle();
  assert.equal(built, fs.readFileSync(COMMITTED, 'utf8'), 'run `npm run build:vendor` and commit the result');
});

test('the bundle exports every supported OAuth flow', async () => {
  const bundle = await import('../src/vendor/pi-oauth.js');
  assert.deepEqual(Object.keys(bundle).sort(), ['anthropicOAuth', 'kimiCodingOAuth', 'openaiCodexOAuth', 'xaiOAuth']);
  for (const flow of Object.values(bundle)) {
    assert.equal(typeof flow.login, 'function');
    assert.equal(typeof flow.refresh, 'function');
  }
});

test('the bundle names its source and licence, and holds no path from this machine', () => {
  const code = fs.readFileSync(COMMITTED, 'utf8');
  assert.match(code, /@earendil-works\/pi-ai 1\.1\.0 — MIT licence/);
  assert.match(code, /npm run build:vendor/);
  assert.ok(!code.includes(ROOT), 'the bundle must not carry the path of this checkout');
  // esbuild names every bundled module in a comment; they are relative, so two
  // machines build the same bytes.
  const modulePaths = code.match(/^\/\/ .*\.js$/gm) ?? [];
  assert.ok(modulePaths.length > 0, 'the bundle should name the modules it holds');
  for (const line of modulePaths) {
    assert.ok(!/^[A-Za-z]:[\\/]/.test(line) && !line.startsWith('// /'), `${line} is an absolute path`);
  }
});

test('browser Kimi OAuth pins the authority and refuses token-bearing redirects', () => {
  const code = fs.readFileSync(COMMITTED, 'utf8');
  assert.ok(!code.includes('KIMI_CODE_OAUTH_HOST'));
  assert.ok(!code.includes('KIMI_OAUTH_HOST'));
  const kimi = code.slice(code.indexOf('// node_modules/@earendil-works/pi-ai/dist/auth/oauth/kimi-coding.js'));
  assert.ok(kimi.includes('https://auth.kimi.com'));
  assert.equal((kimi.match(/redirect: "error"/g) ?? []).length, 3);
});
