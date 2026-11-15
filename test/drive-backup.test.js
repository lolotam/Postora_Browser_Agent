import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const local = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
      set: async (obj) => Object.assign(local, structuredClone(obj)),
      remove: async (key) => { delete local[key]; },
    },
  },
};

const { afterGoogleSignIn, backUpToDrive, driveBackupState, findBackupFile, isFreshSetup, restoreFromDrive } = await import('../src/lib/drive-backup.js');
const { mergeSettings } = await import('../src/lib/settings.js');

const getToken = async () => 'ya29.token';
let drive; // the fake appDataFolder: { id, content } or null
let calls;

function stubDrive({ status } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    assert.equal(init.headers.Authorization, 'Bearer ya29.token');
    if (status) return new Response(JSON.stringify({ error: { message: 'Google Drive API has not been used in project 4227 before or it is disabled.' } }), { status });
    if (u.pathname === '/drive/v3/files' && !init.method) return Response.json({ files: drive ? [{ id: drive.id, modifiedTime: '2026-10-09T10:00:00Z' }] : [] });
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      drive = { id: 'file1', content: null };
      return Response.json({ id: 'file1' });
    }
    if (u.pathname === `/upload/drive/v3/files/${drive?.id}` && init.method === 'PATCH') {
      drive.content = JSON.parse(init.body);
      return Response.json({ id: drive.id });
    }
    if (u.pathname === `/drive/v3/files/${drive?.id}` && u.searchParams.get('alt') === 'media') return Response.json(drive.content);
    return new Response('{}', { status: 404 });
  };
}

const setUp = { provider: 'compatible', compatible: { preset: 'openrouter', apiKey: 'or-key', model: 'openai/gpt-5' } };
const credential = (access) => ({ type: 'oauth', access, refresh: 'r', expires: Date.now() + 3600e3 });

beforeEach(() => {
  for (const k of Object.keys(local)) delete local[k];
  drive = null;
  calls = [];
  stubDrive();
});

test('the first backup creates the file, later changes update it, unchanged settings upload nothing', async () => {
  local.settings = setUp;
  await backUpToDrive({ getToken });
  assert.equal(drive.content.settings.compatible.apiKey, 'or-key');

  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'same settings: no Drive call');

  local.settings = { ...setUp, maxSteps: 25 };
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, ['PATCH /upload/drive/v3/files/file1']);
  assert.equal(drive.content.settings.maxSteps, 25);
});

test('a reinstall gets its settings and ChatGPT sign-in back at Google sign-in', async () => {
  drive = { id: 'file1', content: { format: 'browser-agent-backup', version: 1, settings: setUp, chatgptAuth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1234 } } };
  const { restored } = await afterGoogleSignIn({ getToken });
  assert.equal(restored.compatible.apiKey, 'or-key');
  assert.equal(local['accountAuth.chatgpt'].credential.access, 'at');

  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'the restored settings are not uploaded straight back');
});

test('an install that is already set up keeps its settings and is told a backup exists', async () => {
  drive = { id: 'file1', content: { format: 'browser-agent-backup', version: 1, settings: { ...setUp, compatible: { ...setUp.compatible, apiKey: 'old' } } } };
  local.settings = setUp;
  const result = await afterGoogleSignIn({ getToken });
  assert.equal(result.available, '2026-10-09T10:00:00Z');
  assert.equal(local.settings.compatible.apiKey, 'or-key');
});

test('overlapping backups make one file and leave the newest settings in Drive', async () => {
  local.settings = setUp;
  const first = backUpToDrive({ getToken });
  local.settings = { ...setUp, maxSteps: 25 };
  const second = backUpToDrive({ getToken });
  await Promise.all([first, second]);
  assert.equal(calls.filter((c) => c === 'POST /drive/v3/files').length, 1);
  assert.equal(drive.content.settings.maxSteps, 25);
});

test('a local sign-in that the restored file lacks is still uploaded afterwards', async () => {
  drive = { id: 'file1', content: { format: 'browser-agent-backup', version: 1, settings: setUp, chatgptAuth: null } };
  local['accountAuth.chatgpt'] = { generation: 1, credential: credential('local') };
  await restoreFromDrive({ getToken });
  await backUpToDrive({ getToken });
  assert.equal(drive.content.accounts.chatgpt.access, 'local');
});

test('a refreshed token is uploaded again, and the generation on its own is not', async () => {
  local.settings = setUp;
  local['accountAuth.chatgpt'] = { generation: 1, credential: { type: 'oauth', access: 'first', refresh: 'r1', expires: 1 } };
  await backUpToDrive({ getToken });
  assert.equal(drive.content.accounts.chatgpt.access, 'first');

  // A refresh rotates the token: the fingerprint changes, so Drive is updated.
  local['accountAuth.chatgpt'] = { generation: 1, credential: { type: 'oauth', access: 'second', refresh: 'r2', expires: 2 } };
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, ['PATCH /upload/drive/v3/files/file1']);
  assert.equal(drive.content.accounts.chatgpt.access, 'second');

  // The generation moves on every sign-in; it is not part of the fingerprint.
  local['accountAuth.chatgpt'] = { generation: 9, credential: { type: 'oauth', access: 'second', refresh: 'r2', expires: 2 } };
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'the generation alone changes nothing');
});

test('an install with an account record is not a fresh one', () => {
  assert.equal(isFreshSetup({ settings: mergeSettings({}), accounts: {} }), true);
  assert.equal(isFreshSetup({ settings: mergeSettings({}), accounts: { claude: credential('at') } }), false, 'a Claude record is existing state');
  assert.equal(isFreshSetup({ settings: mergeSettings({ chatgpt: { model: 'gpt-5' } }), accounts: {} }), false);
});

test('an install with only an Anthropic key is not a fresh one', () => {
  const withKey = mergeSettings({ claude: { apiKey: 'sk-ant-key' } });
  assert.equal(withKey.keys.anthropic, 'sk-ant-key');
  assert.equal(isFreshSetup({ settings: withKey, accounts: {} }), false, 'a stored key is existing state');
  const backupKey = mergeSettings({ fallback: { claude: { apiKey: 'sk-ant-key' } } });
  assert.equal(isFreshSetup({ settings: backupKey, accounts: {} }), false, 'the backup slot counts too');
});

test('a Drive error is kept for the account menu, not thrown', async () => {
  local.settings = setUp;
  stubDrive({ status: 403 });
  const state = await backUpToDrive({ getToken });
  assert.match(state.error, /Google Drive API has not been used/);
  assert.match((await driveBackupState()).error, /disabled/);
});

test('a forced unchanged backup reports an expired Google session without changing the saved timestamp', async () => {
  local.settings = setUp;
  const saved = await backUpToDrive({ getToken });
  calls = [];
  const failed = await backUpToDrive({ force: true, getToken: async () => { throw new Error('Google needs you to sign in again (session expired).'); } });
  assert.match(failed.error, /session expired/);
  assert.equal(failed.at, saved.at);
  assert.deepEqual(calls, []);
});

test('a forced unchanged backup recreates a deleted remote file', async () => {
  local.settings = setUp;
  await backUpToDrive({ getToken });
  drive = null;
  calls = [];
  const result = await backUpToDrive({ getToken, force: true });
  assert.equal(result.error, null);
  assert.equal(drive.content.settings.compatible.model, 'openai/gpt-5');
  assert.deepEqual(calls, ['PATCH /upload/drive/v3/files/file1', 'POST /drive/v3/files', 'PATCH /upload/drive/v3/files/file1']);
});

test('a failed replacement upload retains its distinct file ID and retries without an empty duplicate', async () => {
  local.settings = setUp;
  const files = new Map();
  let nextId = 0;
  let failUpload = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (!init.method) return Response.json({ files: [...files.keys()].map((id) => ({ id })) });
    if (init.method === 'POST') {
      const id = `file${++nextId}`;
      files.set(id, null);
      return Response.json({ id });
    }
    const id = u.pathname.split('/').at(-1);
    if (!files.has(id)) return new Response('{}', { status: 404 });
    if (failUpload) return Response.json({ error: { message: 'temporary upload failure' } }, { status: 503 });
    files.set(id, JSON.parse(init.body));
    return Response.json({ id });
  };
  const original = await backUpToDrive({ getToken });
  assert.equal(original.fileId, 'file1');
  files.clear();
  failUpload = true;
  const failed = await backUpToDrive({ getToken, force: true });
  assert.equal(failed.fileId, 'file2');
  assert.equal(failed.at, original.at);
  assert.match(failed.error, /temporary upload failure/);
  failUpload = false;
  const recovered = await backUpToDrive({ getToken, force: true });
  assert.equal(recovered.fileId, 'file2');
  assert.equal(recovered.error, null);
  assert.equal(nextId, 2, 'no third file is created on retry');
  assert.equal(files.size, 1);
  assert.equal(files.get('file2').settings.compatible.model, 'openai/gpt-5');
  assert.equal((await findBackupFile('ya29.token')).id, 'file2');
});

test('a named provider model prevents automatic restore over this computer\'s setup', () => {
  for (const provider of ['gemini', 'kimi']) {
    assert.equal(isFreshSetup({ settings: mergeSettings({ [provider]: { model: 'chosen-model' } }), accounts: {} }), false);
    assert.equal(isFreshSetup({ settings: mergeSettings({ fallback: { [provider]: { model: 'chosen-backup' } } }), accounts: {} }), false);
  }
});

test('restoring when Drive has no backup says so', async () => {
  await assert.rejects(restoreFromDrive({ getToken }), /no backup in Google Drive/);
});

test('a session that is only touched uploads nothing; a new message in it does', async () => {
  const sessions = await import('../src/sessions/store.js');
  // The conversations are in this backup: the user asked for them.
  local.settings = { ...setUp, backupChats: true };
  const meta = await sessions.createStoredSession('Chat');
  const { transcript, log, groupId } = await sessions.loadSession(meta.id);
  await sessions.saveSession(meta.id, { transcript, log, groupId }); // the shape a saved session has
  await backUpToDrive({ getToken });
  assert.equal(drive.content.sessions.length, 1);

  // Opening a panel or moving a tab group saves the session again, only its time moves.
  const before = (await sessions.listSessions())[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sessions.saveSession(meta.id, { transcript, log, groupId });
  assert.ok((await sessions.listSessions())[0].updatedAt > before, 'the time did move');
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'same conversation: no Drive call');

  await sessions.saveSession(meta.id, { transcript: [{ type: 'user', text: 'hello' }], log, groupId });
  await backUpToDrive({ getToken });
  assert.equal(drive.content.sessions[0].body.transcript[0].text, 'hello');
});

test('the order the conversations are in does not change the backup: touching one uploads nothing', async () => {
  const sessions = await import('../src/sessions/store.js');
  local.settings = { ...setUp, backupChats: true };
  const older = await sessions.createStoredSession('Older');
  const newer = await sessions.createStoredSession('Newer');
  const body = { transcript: [], log: null, groupId: null };
  await sessions.saveSession(older.id, { ...body });
  await sessions.saveSession(newer.id, { ...body });
  await backUpToDrive({ getToken });
  assert.equal(drive.content.sessions.length, 2);

  // Saving a session moves it to the front of the list, because the list is
  // ordered by the time it was touched. The conversations did not change, so
  // the backup is the same one and nothing is uploaded.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sessions.saveSession(older.id, { ...body });
  assert.equal((await sessions.listSessions())[0].id, older.id, 'the touched conversation is now the first');
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'the same conversations in another order: no Drive call');
});

test('a conversation that really changed is uploaded again', async () => {
  const sessions = await import('../src/sessions/store.js');
  local.settings = { ...setUp, backupChats: true };
  const first = await sessions.createStoredSession('First');
  const second = await sessions.createStoredSession('Second');
  await sessions.saveSession(first.id, { transcript: [], log: null, groupId: null });
  await sessions.saveSession(second.id, { transcript: [], log: null, groupId: null });
  await backUpToDrive({ getToken });

  await sessions.saveSession(second.id, { transcript: [{ type: 'user', text: 'a new message' }], log: null, groupId: null });
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, ['PATCH /upload/drive/v3/files/file1']);
  assert.equal(drive.content.sessions.find((s) => s.meta.id === second.id).body.transcript[0].text, 'a new message');
});

test('the conversations stay out of the Drive backup until the user asks for them', async () => {
  const sessions = await import('../src/sessions/store.js');
  local.settings = setUp; // no backupChats: the user did not ask
  const meta = await sessions.createStoredSession('Chat');
  await sessions.saveSession(meta.id, { transcript: [{ type: 'user', text: 'hello' }], log: null, groupId: null });
  await backUpToDrive({ getToken });
  assert.deepEqual(drive.content.sessions, [], 'the backup holds no conversations');

  // A conversation that is not in the backup changes nothing in it, so the
  // backup stays the same one and nothing is uploaded.
  await sessions.saveSession(meta.id, { transcript: [{ type: 'user', text: 'a new message' }], log: null, groupId: null });
  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'the same backup: no Drive call');
});

test('a stored value that is not a switch is no switch', async () => {
  const sessions = await import('../src/sessions/store.js');
  local.settings = { ...setUp, backupChats: 'yes' };
  const meta = await sessions.createStoredSession('Chat');
  await sessions.saveSession(meta.id, { transcript: [{ type: 'user', text: 'hello' }], log: null, groupId: null });
  await backUpToDrive({ getToken });
  assert.deepEqual(drive.content.sessions, [], 'the conversations stay out');
  assert.equal(mergeSettings(local.settings).backupChats, false, 'a malformed value is not a switch');
});
