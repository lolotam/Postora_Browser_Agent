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

const { createStoredSession, importSessions, listSessions, loadSession, saveSession } = await import('../src/sessions/store.js');

const body = (text) => ({ transcript: [{ type: 'user', text }], log: null, groupId: null });

beforeEach(() => {
  for (const k of Object.keys(local)) delete local[k];
});

test('two restores at once do not overwrite each other\'s conversation', async () => {
  const archive = (text) => [{ meta: { id: 'imported-1', title: 'Imported', titled: true, createdAt: 1, updatedAt: 2 }, body: body(text) }];

  await Promise.all([importSessions(archive('first body')), importSessions(archive('second body'))]);

  const index = await listSessions();
  const ids = index.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'the index holds every conversation once');
  const texts = [];
  for (const entry of index) texts.push((await loadSession(entry.id)).transcript[0].text);
  assert.deepEqual(texts.sort(), ['first body', 'second body'], 'neither restore lost its conversation');
});

test('a restore that lands on a conversation that is there keeps both histories', async () => {
  const meta = await createStoredSession('Shared');
  await saveSession(meta.id, body('the conversation'));
  const archive = [{ meta: { id: 'imported-1', title: 'Imported', titled: true, createdAt: 1, updatedAt: 2 }, body: body('imported text') }];

  await Promise.all([importSessions(archive), importSessions(archive)]);

  const index = await listSessions();
  const ids = index.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'the index holds every conversation once');
  assert.equal(ids.filter((id) => id === 'imported-1').length, 1);
  assert.equal(index.length, 2, 'the local conversation and the imported one');
  const imported = index.find((entry) => entry.id === 'imported-1');
  assert.equal((await loadSession(imported.id)).transcript[0].text, 'imported text');
});

test('a restore into an index that already has the conversation keeps both histories', async () => {
  const meta = await createStoredSession('Local');
  await saveSession(meta.id, body('local text'));
  const archive = [{ meta: { id: meta.id, title: 'Local', titled: true, createdAt: 1, updatedAt: 2 }, body: body('other text') }];

  const added = await importSessions(archive);

  assert.equal(added, 1, 'the colliding conversation was added under another id');
  const index = await listSessions();
  assert.equal(index.length, 2);
  assert.equal(new Set(index.map((entry) => entry.id)).size, 2);
  assert.equal((await loadSession(meta.id)).transcript[0].text, 'local text', 'the local history is untouched');
});

test('a restore of the same conversation twice does not add it twice', async () => {
  const archive = [{ meta: { id: 'imported-2', title: 'Imported', titled: true, createdAt: 1, updatedAt: 2 }, body: body('imported text') }];
  await importSessions(archive);
  const added = await importSessions(archive);
  assert.equal(added, 0, 'the same conversation is not added again');
  assert.equal((await listSessions()).length, 1);
});
