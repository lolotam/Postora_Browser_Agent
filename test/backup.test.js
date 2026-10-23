import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
};

const { exportBackup, importBackup } = await import('../src/lib/backup.js');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

const credential = (access) => ({ type: 'oauth', access, refresh: 'rt', expires: 1700000000000 });

test('a backup carries the settings and the signed-in accounts back after a reinstall', async () => {
  store.settings = { provider: 'compatible', compatible: { preset: 'openrouter', apiKey: 'or-key', model: 'm' } };
  store['accountAuth.chatgpt'] = { generation: 3, credential: credential('at') };
  store['accountAuth.claude'] = { generation: 1, credential: null }; // signed out
  const file = JSON.parse(JSON.stringify(await exportBackup()));

  assert.equal(file.version, 2);
  assert.deepEqual(file.accounts, { chatgpt: credential('at') }, 'only the signed-in providers, without the generation');

  for (const k of Object.keys(store)) delete store[k];
  await importBackup(file);

  assert.equal(store.settings.compatible.apiKey, 'or-key');
  assert.equal(store.settings.fallback.enabled, false, 'restored settings are merged with current defaults');
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'at');
  assert.equal(store['accountAuth.chatgpt'].generation, 1, 'the import moves the generation on');
  assert.equal(store['accountAuth.claude'], undefined, 'a provider the file does not have is not written');
});

test('a backup taken right after the update still carries the old ChatGPT sign-in', async () => {
  store.chatgptAuth = { accessToken: 'legacy-at', refreshToken: 'legacy-rt', expiresAt: 1700000000000 };

  const file = await exportBackup();

  assert.equal(file.accounts.chatgpt.access, 'legacy-at');
  assert.equal(file.accounts.chatgpt.refresh, 'legacy-rt');
});

test('a backup without an account restores the settings only', async () => {
  await importBackup({ format: 'browser-agent-backup', version: 2, settings: { maxSteps: 12 }, accounts: {} });
  assert.equal(store.settings.maxSteps, 12);
  assert.equal(store['accountAuth.chatgpt'], undefined);
});

test('a version 1 file brings the ChatGPT sign-in back', async () => {
  await importBackup({
    format: 'browser-agent-backup',
    version: 1,
    settings: { maxSteps: 12 },
    chatgptAuth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1234, accountId: 'acc_1', email: 'me@x.y', planType: 'pro' },
  });
  assert.equal(store.settings.maxSteps, 12);
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'at');
  assert.equal(store['accountAuth.chatgpt'].credential.refresh, 'rt');
  assert.equal(store['accountAuth.chatgpt'].credential.expires, 1234);
  assert.equal(store['accountAuth.chatgpt'].credential.email, 'me@x.y');
});

test('a version 1 file without a sign-in keeps the local one', async () => {
  store['accountAuth.chatgpt'] = { generation: 2, credential: credential('local') };
  await importBackup({ format: 'browser-agent-backup', version: 1, settings: { maxSteps: 12 }, chatgptAuth: null });
  assert.equal(store.settings.maxSteps, 12);
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'local', 'a null record means absent');
});

test('a provider the file does not have keeps its local sign-in', async () => {
  store['accountAuth.grok'] = { generation: 1, credential: credential('local-grok') };
  await importBackup({
    format: 'browser-agent-backup',
    version: 2,
    settings: {},
    accounts: { chatgpt: credential('file-chatgpt'), claude: credential('file-claude') },
  });
  assert.equal(store['accountAuth.chatgpt'].credential.access, 'file-chatgpt', 'the file replaces the local record');
  assert.equal(store['accountAuth.claude'].credential.access, 'file-claude');
  assert.equal(store['accountAuth.grok'].credential.access, 'local-grok', 'a backup never signs a provider out');
});

test('a damaged file is refused before it changes anything', async () => {
  store.settings = { provider: 'compatible', compatible: { preset: 'openrouter', apiKey: 'local-key', model: 'm' } };
  const before = JSON.stringify(store.settings);

  for (const accounts of [null, 'x', ['a']]) {
    await assert.rejects(
      importBackup({ format: 'browser-agent-backup', version: 2, settings: { provider: 'chatgpt' }, accounts }),
      /damaged/,
    );
    assert.equal(JSON.stringify(store.settings), before, `accounts=${JSON.stringify(accounts)} leaves the settings alone`);
  }
});

test('files that are not backups, or come from a newer format, are refused', async () => {
  await assert.rejects(importBackup({ tokens: {} }), /not a Postora Browser Agent backup/);
  await assert.rejects(importBackup({ format: 'browser-agent-backup', version: 99, settings: {} }), /newer version/);
  assert.deepEqual(store, {});
});
