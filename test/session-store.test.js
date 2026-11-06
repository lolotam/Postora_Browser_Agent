import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
  },
};

const sessions = await import('../src/sessions/store.js');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

test('linked project survives a session save/load round trip', async () => {
  const meta = await sessions.createStoredSession();
  const project = { root: 'C:/fixture/project', name: 'project' };
  await sessions.saveSession(meta.id, { project, transcript: [], log: null });
  assert.deepEqual((await sessions.loadSession(meta.id)).project, project);
});

test('a session keeps its transcript, its neutral log and its tab group', async () => {
  const meta = await sessions.createStoredSession();
  await sessions.saveSession(meta.id, { transcript: [{ type: 'user', text: 'hi' }], log: { task: 'hi', notes: [], steps: [], last: null }, groupId: 7 });

  const loaded = await sessions.loadSession(meta.id);
  assert.deepEqual(loaded.transcript, [{ type: 'user', text: 'hi' }]);
  assert.equal(loaded.log.task, 'hi');
  assert.equal(loaded.groupId, 7);
  assert.equal((await sessions.listSessions())[0].groupId, 7, 'the index names the group, so a restarted worker finds the session of a grouped tab');
});

test('the list is newest first and saving moves a session to the top', async () => {
  const a = await sessions.createStoredSession('A');
  await new Promise((r) => setTimeout(r, 5));
  const b = await sessions.createStoredSession('B');
  assert.deepEqual((await sessions.listSessions()).map((s) => s.title), ['B', 'A']);
  await new Promise((r) => setTimeout(r, 5));
  await sessions.saveSession(a.id, { transcript: [], log: null, groupId: null });
  assert.deepEqual((await sessions.listSessions()).map((s) => s.title), ['A', 'B']);
  assert.ok(b.id !== a.id);
});

test('rename and delete', async () => {
  const meta = await sessions.createStoredSession('Old');
  await sessions.renameSession(meta.id, '  New name  ');
  assert.equal((await sessions.listSessions())[0].title, 'New name');
  await sessions.deleteSession(meta.id);
  assert.deepEqual(await sessions.listSessions(), []);
  assert.equal(await sessions.loadSession(meta.id), null);
});

test('a session gets its title from the first task until the user renames it', async () => {
  const meta = await sessions.createStoredSession();
  await sessions.titleFromFirstTask(meta.id, 'Find the three cheapest RTX 4060 laptops on Amazon and compare them');
  assert.equal((await sessions.listSessions())[0].title, 'Find the three cheapest RTX 4060…');
  await sessions.titleFromFirstTask(meta.id, 'A later task');
  assert.equal((await sessions.listSessions())[0].title, 'Find the three cheapest RTX 4060…', 'only the first task names the session');
});
