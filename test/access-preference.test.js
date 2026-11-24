// The remembered access mode: the one record that outlives a chat and a worker.
//
// These tests are about the contract of the record, not about how it is
// written: who can change it, what a failed write does, and what a new chat
// may start with. The storage is a fake that can be made to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_PREFERENCE_KEY,
  ACCESS_PREFERENCE_VERSION,
  createAccessPreferenceStore,
} from '../src/permissions/access-preference.js';

const ASK = 'ask-first';
const FULL = 'full-access';
const NOW = 1_700_000_000_000;

/** A storage area that remembers what was done to it and can be made to fail. */
function makeArea(initial = {}) {
  const data = { ...initial };
  const area = {
    data,
    log: [],
    failSet: false,
    failRemove: false,
    failGet: false,
    async get(keys) {
      if (area.failGet) throw new Error('read failed');
      return Object.fromEntries([].concat(keys).filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) {
      area.log.push(['set', structuredClone(values)]);
      if (area.failSet) throw new Error('write failed');
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      area.log.push(['remove', [].concat(keys)]);
      if (area.failRemove) throw new Error('remove failed');
      for (const key of [].concat(keys)) delete data[key];
    },
  };
  return area;
}

/** A local area with the protection call, and a session area for the marker. */
function makeStorage({ initial = {}, protection = 'ok', session = {} } = {}) {
  const storage = makeArea(initial);
  storage.accessLevels = [];
  if (protection !== 'missing') {
    storage.setAccessLevel = async (options) => {
      storage.accessLevels.push(options);
      if (protection === 'reject') throw new Error('not allowed');
      if (protection instanceof Promise) await protection;
    };
  }
  return { storage, sessionStorage: makeArea(session) };
}

/** Timers the test runs by hand. */
function makeScheduler() {
  const queue = [];
  return {
    schedule: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    queue,
    async runNext() {
      const next = queue.shift();
      if (next) await next.fn();
      return Boolean(next);
    },
  };
}

const record = (overrides = {}) => ({
  remember: true,
  mode: FULL,
  localExecution: false,
  revision: 4,
  acknowledgedAt: NOW - 1000,
  version: ACCESS_PREFERENCE_VERSION,
  ...overrides,
});

/** Live chats as the worker would hand them to the store. */
function makeHooks({ full = false, refuse = null } = {}) {
  const calls = [];
  const live = { full };
  return {
    calls,
    live,
    anyFull: () => live.full,
    precheckFull: () => refuse,
    downgradeAll: () => { calls.push('downgradeAll'); live.full = false; },
    applyFull: () => { calls.push('applyFull'); live.full = true; return { ok: true, changed: true }; },
  };
}

async function started(initial, options = {}) {
  const { storage, sessionStorage } = makeStorage({ initial, ...options });
  const scheduler = options.scheduler ?? makeScheduler();
  const store = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW,
    schedule: scheduler.schedule,
  });
  await store.init();
  return { store, storage, sessionStorage, scheduler };
}

test('the record has a key and a version of its own', () => {
  assert.equal(ACCESS_PREFERENCE_KEY, 'accessPreference');
  assert.equal(ACCESS_PREFERENCE_VERSION, 1);
});

test('a profile that never chose starts at Ask first with "remember" on', async () => {
  const { store, storage } = await started({});
  assert.deepEqual(storage.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal(store.effectiveDefaultMode(), ASK);
  const state = store.snapshot();
  assert.equal(state.remember, true);
  assert.equal(state.mode, ASK);
  assert.equal(state.restoreFailed, false);
  assert.equal(state.unpersisted, false);
  assert.equal(typeof state.profileRevision, 'number');
});

test('a remembered Full access is honoured only after the protection call resolved', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() }, protection: gate });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  const starting = store.init();
  await Promise.resolve();
  assert.equal(store.effectiveDefaultMode(), ASK, 'the mode is not honoured while the call is pending');
  release();
  await starting;
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.equal(store.snapshot().restoreFailed, false);
});

test('when the protection call fails, every chat starts at Ask first and the panel is told', async () => {
  for (const protection of ['reject', 'missing']) {
    const { store } = await started({ accessPreference: record() }, { protection });
    assert.equal(store.effectiveDefaultMode(), ASK, protection);
    const state = store.snapshot();
    assert.equal(state.restoreFailed, true, protection);
    assert.equal(state.mode, ASK, protection);
    // A Full access that cannot be protected is never written: it is for
    // that chat only, as when "remember" is off.
    const hooks = makeHooks();
    const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: state.profileRevision }, hooks);
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.equal(result.warning, 'protection-unavailable');
    assert.deepEqual(hooks.calls, ['applyFull']);
    assert.equal(store.effectiveDefaultMode(), ASK);
  }
});

test('a record that is invalid, unreadable or has no acknowledgment reads as Ask first', async () => {
  const bad = [
    'full-access',
    42,
    { remember: true, mode: 'sudo', acknowledgedAt: NOW, version: 1, revision: 1 },
    record({ acknowledgedAt: undefined }),
    record({ acknowledgedAt: 'yesterday' }),
    record({ version: 2 }),
    record({ remember: 'yes' }),
  ];
  for (const stored of bad) {
    const { store } = await started({ accessPreference: stored });
    assert.equal(store.effectiveDefaultMode(), ASK, JSON.stringify(stored));
    assert.equal(store.snapshot().mode, ASK);
  }
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() } });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().restoreFailed, true);
});

test('the stored localExecution value is ignored', async () => {
  const { store } = await started({ accessPreference: record({ localExecution: true }) });
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.equal(store.snapshot().localExecution, false);
});

test('"remember" off is read back as opted out, and new chats start at Ask first', async () => {
  const { store } = await started({ accessPreference: record({ remember: false, mode: FULL }) });
  assert.equal(store.snapshot().remember, false);
  assert.equal(store.effectiveDefaultMode(), ASK);
});

test('Full access with "remember" on is written first, then applied', async () => {
  const { store, storage } = await started({});
  const hooks = makeHooks();
  const before = store.profileRevision;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const origSet = storage.set.bind(storage);
  storage.set = async (values) => {
    await writeGate;
    return origSet(values);
  };
  const pendingMode = store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: before }, hooks);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hooks.calls, [], 'Full access stays unapplied while the storage write is pending');
  assert.equal(store.effectiveDefaultMode(), ASK);
  releaseWrite();
  const result = await pendingMode;
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.deepEqual(hooks.calls, ['applyFull']);
  assert.equal(storage.log.length, 1);
  assert.equal(storage.log[0][0], 'set');
  const saved = storage.data.accessPreference;
  assert.equal(saved.remember, true);
  assert.equal(saved.mode, FULL);
  assert.equal(saved.localExecution, false);
  assert.equal(saved.acknowledgedAt, NOW);
  assert.equal(saved.version, 1);
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.ok(store.profileRevision > before, 'the profile revision moved');
  assert.equal(saved.revision, store.profileRevision);
});

test('a failed write leaves the previous mode in force and says so', async () => {
  const { store, storage } = await started({});
  storage.failSet = true;
  const hooks = makeHooks();
  const before = store.profileRevision;
  const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: before }, hooks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage-failed');
  assert.deepEqual(hooks.calls, [], 'nothing was applied to a chat');
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.profileRevision, before);
});

test('ready never rejects, whatever storage does', async () => {
  const { storage, sessionStorage } = makeStorage({ protection: 'reject' });
  storage.failGet = true;
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  await store.ready;
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  // No storage API at all: the store still starts, and still asks.
  const bare = createAccessPreferenceStore({ storage: {}, sessionStorage: null, now: () => NOW, schedule: () => 0 });
  await bare.ready;
  assert.equal(bare.effectiveDefaultMode(), ASK);
  assert.equal(bare.snapshot().restoreFailed, true);
});

test('Full access that no chat could take is not left remembered', async () => {
  const { store, storage } = await started({});
  const hooks = makeHooks();
  hooks.applyFull = () => { hooks.calls.push('applyFull'); return { ok: false, reason: 'stale-revision' }; };
  const before = store.profileRevision;
  const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: before }, hooks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-revision');
  assert.equal('accessPreference' in storage.data, false, 'the record was taken back');
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.ok(store.profileRevision > before, 'the choice that was undone still moved the revision on');
});

test('a chat that refuses Full access stops it before anything is written', async () => {
  const { store, storage } = await started({});
  const hooks = makeHooks({ refuse: { ok: false, reason: 'stale-revision' } });
  const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-revision');
  assert.deepEqual(storage.log, []);
});

test('Full access needs the acknowledgment and the profile revision the panel saw', async () => {
  const { store, storage } = await started({});
  const hooks = makeHooks();
  const rev = store.profileRevision;
  const a = await store.setMode({ mode: FULL, acknowledged: false, expectedProfileRevision: rev }, hooks);
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'not-acknowledged');
  const b = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: rev + 5 }, hooks);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'stale-profile-revision');
  assert.equal(b.preference.profileRevision, rev, 'the stale request is answered with the state in force');
  const c = await store.setMode({ mode: FULL, acknowledged: true }, hooks);
  assert.equal(c.reason, 'stale-profile-revision', 'a missing revision is not a revision');
  assert.deepEqual(hooks.calls, []);
  assert.deepEqual(storage.log, []);
});

test('with "remember" off, Full access is for that chat only and is never written', async () => {
  const { store, storage } = await started({ accessPreference: record({ remember: false, mode: ASK }) });
  const hooks = makeHooks();
  const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.deepEqual(hooks.calls, ['applyFull']);
  assert.deepEqual(storage.log, []);
  assert.equal(store.effectiveDefaultMode(), ASK);
});

test('changes run one at a time, in the order they came', async () => {
  const { store, storage } = await started({});
  const order = [];
  const original = storage.set.bind(storage);
  storage.set = async (values) => {
    order.push(`start:${values.accessPreference.mode}:${values.accessPreference.remember}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await original(values);
    order.push(`end:${values.accessPreference.mode}:${values.accessPreference.remember}`);
  };
  const hooks = makeHooks();
  const first = store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, hooks);
  // This second request carries the revision the panel saw before the first
  // one landed: it is stale by the time it runs.
  const second = store.setRemember({ remember: false, acknowledged: false, expectedProfileRevision: store.profileRevision }, hooks);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, false);
  assert.equal(two.reason, 'stale-profile-revision');
  assert.deepEqual(order, ['start:full-access:true', 'end:full-access:true']);
});

test('choosing Ask first applies at once to every live chat, then clears the record', async () => {
  const { store, storage } = await started({ accessPreference: record() });
  const hooks = makeHooks({ full: true });
  const log = [];
  const originalRemove = storage.remove.bind(storage);
  storage.remove = async (keys) => { log.push(`remove:${hooks.calls.join(',')}`); return originalRemove(keys); };
  const result = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.deepEqual(hooks.calls, ['downgradeAll']);
  assert.deepEqual(log, ['remove:downgradeAll'], 'the live chats were downgraded before the write');
  assert.equal('accessPreference' in storage.data, false, 'the smallest write is a removal');
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().remember, true);
});

test('a downgrade that cannot be written still applies, and is retried for its own revision only', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  storage.failSet = true;
  const hooks = makeHooks({ full: true });
  const result = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(result.ok, true, 'the live chats were downgraded');
  assert.deepEqual(hooks.calls, ['downgradeAll']);
  assert.equal(result.persisted, false);
  assert.equal(result.warning, 'not-cleared');
  assert.equal(store.effectiveDefaultMode(), ASK, 'a new chat does not start at Full access');
  assert.equal(store.snapshot().unpersisted, true);
  assert.ok('accessPreferenceDowngrade' in sessionStorage.data, 'a marker covers a worker restart');
  assert.ok(scheduler.queue.length >= 1, 'a retry is scheduled');

  // A newer choice lands before the retry runs: the retry must not touch it.
  storage.failRemove = false;
  storage.failSet = false;
  const newer = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(newer.ok, true);
  const afterNewer = structuredClone(storage.data.accessPreference);
  assert.equal(afterNewer.mode, FULL);
  while (await scheduler.runNext()) { /* every late retry */ }
  assert.deepEqual(storage.data.accessPreference, afterNewer, 'a late retry never overwrites a newer choice');
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a retry that works clears the warning and the marker', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  const hooks = makeHooks({ full: true });
  const states = [];
  store.subscribe((state) => states.push(state.unpersisted));
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, hooks);
  storage.failRemove = false;
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
  assert.equal(states.at(-1), false, 'the panels are told it is cleared');
});

test('when every retry fails the warning stays, and it says Full access will return', async () => {
  const scheduler = makeScheduler();
  const { store, storage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  storage.failSet = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  while (await scheduler.runNext()) { /* all of them fail */ }
  assert.equal(scheduler.queue.length, 0, 'the retries are bounded');
  assert.equal(store.snapshot().unpersisted, true);
  assert.equal(store.effectiveDefaultMode(), ASK);
});

test('a worker that restarts with a pending downgrade does not bring Full access back', async () => {
  const scheduler = makeScheduler();
  const marker = { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 4, at: NOW - 5 } };
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler, session: marker });
  assert.equal(store.effectiveDefaultMode(), ASK, 'Full access is not honoured while a downgrade is pending');
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false, 'the downgrade is finished after the restart');
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
  assert.equal(store.snapshot().unpersisted, false);
});

test('turning "remember" off downgrades every live chat and is written as an explicit opt-out', async () => {
  const { store, storage } = await started({ accessPreference: record() });
  const hooks = makeHooks({ full: true });
  const result = await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, hooks);
  assert.equal(result.ok, true);
  assert.deepEqual(hooks.calls, ['downgradeAll']);
  const saved = storage.data.accessPreference;
  assert.equal(saved.remember, false);
  assert.equal(saved.mode, ASK);
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().remember, false);
});

test('a failed opt-out is retried and reported like any downgrade', async () => {
  const scheduler = makeScheduler();
  const { store, storage } = await started({ accessPreference: record() }, { scheduler });
  storage.failSet = true;
  storage.failRemove = true;
  const result = await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(result.ok, true);
  assert.equal(result.warning, 'not-cleared');
  assert.equal(store.snapshot().remember, false);
  storage.failSet = false;
  storage.failRemove = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(store.snapshot().unpersisted, false);
});

test('turning "remember" off falls back to removing Full access when the larger write fails', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failSet = true;
  const result = await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.equal(result.warning, 'not-remembered');
  assert.equal('accessPreference' in storage.data, false, 'Full access was removed from storage');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.optOutOnly, true, 'opt-out recovery marker stays until opt-out is saved');
  assert.equal(store.snapshot().remember, false);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal(store.snapshot().optOutUnpersisted, true);
  assert.equal(scheduler.queue.length, 1, 'still schedules retry to persist explicit opt-out');
  storage.failSet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(store.snapshot().optOutUnpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a worker that restarts after fallback removal still restores the pending remember-off opt-out', async () => {
  const scheduler = makeScheduler();
  const marker = { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: null, optOutOnly: true, at: NOW - 5 } };
  const { store, storage, sessionStorage } = await started({}, { scheduler, session: marker });
  assert.equal(store.snapshot().remember, false);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal(store.snapshot().optOutUnpersisted, true);
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(store.snapshot().optOutUnpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('retries repair a failed session-marker write and bind each timer to its own downgrade', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  sessionStorage.failSet = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
  assert.equal(scheduler.queue.length, 1);

  // Session storage recovers while local removal still fails: retry repairs the marker.
  sessionStorage.failSet = false;
  await scheduler.runNext();
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4);
  assert.equal(scheduler.queue.length, 1);
  const oldRetry = scheduler.queue.shift();

  // Supersede with a new Full choice, then fail a second downgrade: the old timer must not retry the new downgrade.
  storage.failRemove = false;
  await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, makeHooks());
  storage.failRemove = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(scheduler.queue.length, 1, 'second downgrade has its own timer');
  storage.failRemove = false;
  await oldRetry.fn();
  assert.equal(store.snapshot().unpersisted, true, 'stale timer from first downgrade was ignored');
  await scheduler.runNext();
  assert.equal(store.snapshot().unpersisted, false);
});

test('repeated revocation keeps its existing recovery marker when the replacement write fails', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4);

  sessionStorage.failSet = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: false }));
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4, 'existing marker was not deleted before replacement succeeded');
});

test('a marker recovered during an unreadable startup does not overwrite a newer confirmed preference once reads recover', async () => {
  const scheduler = makeScheduler();
  const marker = { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 4, at: NOW - 5 } };
  const newer = record({ revision: 9, mode: FULL, remember: true });
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: newer }, session: marker });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);

  storage.failGet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.revision, 9, 'newer record was not deleted');
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a fresh preference write clears restoreFailed from startup', async () => {
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() } });
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  await store.init();
  assert.equal(store.snapshot().restoreFailed, true);

  sessionStorage.failGet = false;
  const elevated = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, makeHooks());
  assert.equal(elevated.ok, true);
  assert.equal(store.snapshot().restoreFailed, false);
  assert.equal(store.effectiveDefaultMode(), FULL);
});

test('startup fails closed when the downgrade marker store cannot be read', async () => {
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() } });
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().restoreFailed, true);
});

test('startup keeps a readable downgrade marker when local storage cannot be read, and completes removal on retry', async () => {
  const scheduler = makeScheduler();
  const marker = { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 4, at: NOW - 5 } };
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() }, session: marker });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().unpersisted, true);
  assert.ok('accessPreferenceDowngrade' in sessionStorage.data, 'readable marker is preserved when local storage fails');
  storage.failGet = false;
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
  assert.equal(store.snapshot().unpersisted, false);
});

test('downgrade journals the session marker before touching local storage and removes it on success', async () => {
  const { store, storage, sessionStorage } = await started({ accessPreference: record() });
  let markerAtRemove = null;
  const origRemove = storage.remove.bind(storage);
  storage.remove = async (keys) => {
    markerAtRemove = structuredClone(sessionStorage.data.accessPreferenceDowngrade ?? null);
    return origRemove(keys);
  };
  const result = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(markerAtRemove?.staleRevision, 4);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a downgrade after an unreadable startup attempts local removal instead of early-returning success', async () => {
  const { storage, sessionStorage } = makeStorage({ initial: { accessPreference: record() } });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: () => 0 });
  await store.init();
  storage.failGet = false;
  const result = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: false }));
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal('accessPreference' in storage.data, false, 'stale grant on disk was removed');
});

test('downgrade retries use the remove fallback and keep retrying the explicit opt-out', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({ accessPreference: record() }, { scheduler });
  storage.failSet = true;
  storage.failRemove = true;
  await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(store.snapshot().unpersisted, true);

  storage.failRemove = false;
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false, 'fallback removed Full access on retry');
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal(store.snapshot().optOutUnpersisted, true);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.optOutOnly, true);

  storage.failSet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(store.snapshot().optOutUnpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a failed elevation on another chat preserves an existing remembered Full-access grant', async () => {
  const { store, storage } = await started({ accessPreference: record() });
  const result = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    { ...makeHooks({ full: true }), applyFull: () => ({ ok: false, reason: 'disposed' }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disposed');
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.equal(storage.data.accessPreference.mode, FULL);
});

test('profile-wide Ask first advances profileRevision even with no stored Full grant', async () => {
  const { store } = await started({});
  const oldRev = store.profileRevision;
  const downgrade = await store.setMode({ mode: ASK, expectedProfileRevision: oldRev }, makeHooks({ full: false }));
  assert.equal(downgrade.ok, true);
  assert.ok(store.profileRevision > oldRev);
  const staleElevate = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: oldRev }, makeHooks());
  assert.equal(staleElevate.ok, false);
  assert.equal(staleElevate.reason, 'stale-profile-revision');
});

test('lowering to Ask first preserves a pending remember-off opt-out', async () => {
  const scheduler = makeScheduler();
  const { store, storage } = await started({ accessPreference: record() }, { scheduler });
  storage.failSet = true;
  storage.failRemove = true;
  await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, makeHooks());
  storage.failSet = false;
  storage.failRemove = false;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
});

test('turning "remember" on without a profile revision is refused', async () => {
  const { store, storage } = await started({ accessPreference: record({ remember: false, mode: ASK }) });
  const result = await store.setRemember({ remember: true, acknowledged: true }, makeHooks({ full: true }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-profile-revision');
  assert.equal(storage.data.accessPreference.remember, false);
});

test('a restarted worker with a pending downgrade moves its revision past the stale record', async () => {
  const scheduler = makeScheduler();
  const marker = { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: 4, at: NOW - 5 } };
  const { store, storage } = await started({ accessPreference: record() }, { scheduler, session: marker });
  assert.ok(store.profileRevision > 4, 'pending downgrade revision advances past the stale stored revision');
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.revision, store.profileRevision);
});

test('turning "remember" on while a chat is in Full access needs the acknowledgment', async () => {
  const { store, storage } = await started({ accessPreference: record({ remember: false, mode: ASK }) });
  const hooks = makeHooks({ full: true });
  const rev = store.profileRevision;
  const refused = await store.setRemember({ remember: true, acknowledged: false, expectedProfileRevision: rev }, hooks);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'needs-acknowledgement');
  assert.equal(storage.data.accessPreference.remember, false, 'nothing changed');
  const accepted = await store.setRemember({ remember: true, acknowledged: true, expectedProfileRevision: rev }, hooks);
  assert.equal(accepted.ok, true);
  assert.equal(storage.data.accessPreference.remember, true);
  assert.equal(storage.data.accessPreference.mode, FULL, 'the live Full access is what is remembered');
});

test('turning "remember" on with no chat in Full access needs no acknowledgment and remembers Ask first', async () => {
  const { store, storage } = await started({ accessPreference: record({ remember: false, mode: ASK }) });
  const result = await store.setRemember({ remember: true, expectedProfileRevision: store.profileRevision }, makeHooks({ full: false }));
  assert.equal(result.ok, true);
  assert.equal(storage.data.accessPreference.remember, true);
  assert.equal(storage.data.accessPreference.mode, ASK);
});

test('a stale "remember" request is refused and answered with the state in force', async () => {
  const { store } = await started({ accessPreference: record() });
  const result = await store.setRemember({ remember: false, expectedProfileRevision: 999 }, makeHooks({ full: true }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-profile-revision');
  assert.equal(result.preference.remember, true);
});

test('only a request through the store changes the record: a changed mode or a replayed value does not', async () => {
  const { store, storage } = await started({});
  // Reading and snapshots never write.
  store.snapshot();
  store.effectiveDefaultMode();
  assert.deepEqual(storage.log, []);
  // A snapshot handed out cannot be used to change the state.
  const state = store.snapshot();
  state.mode = FULL;
  state.remember = false;
  assert.equal(store.snapshot().mode, ASK);
  assert.equal(store.snapshot().remember, true);
});

test('recovery adopting a confirmed record with a different remember scope advances profileRevision strictly past the provisional revision', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: ASK, revision: 5 }) },
    session: { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: 4, at: NOW - 10 } },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  const provisionalRev = store.profileRevision;
  assert.equal(store.snapshot().remember, false);

  storage.failGet = false;
  await scheduler.runNext();
  assert.equal(store.snapshot().remember, true);
  assert.ok(store.profileRevision > provisionalRev, 'profileRevision advances past the provisional revision');

  const staleRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: provisionalRev },
    makeHooks(),
  );
  assert.equal(staleRaise.ok, false);
  assert.equal(staleRaise.reason, 'stale-profile-revision');
  assert.equal(storage.data.accessPreference.mode, ASK, 'session-only acknowledgment was not persisted as remembered Full access');
});

test('turning remember off with an existing Ask-first record recovers and retries the opt-out on restart', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started(
    { accessPreference: record({ remember: true, mode: ASK, revision: 5 }) },
    { scheduler },
  );
  storage.failSet = true;
  const off = await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: false }));
  assert.equal(off.ok, true);
  assert.equal(off.persisted, false);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.kind, 'remember-off');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 5);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.optOutOnly, true);

  storage.failSet = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.snapshot().remember, false);
  assert.equal(restarted.snapshot().unpersisted, false);
  assert.equal(restarted.snapshot().optOutUnpersisted, true);

  await restartedScheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(restarted.snapshot().optOutUnpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('unreadable startup with a numeric remember-off marker still finishes the opt-out when retry sees empty storage', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: 4, at: NOW - 10 } },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.snapshot().remember, false);

  storage.failGet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal(store.snapshot().optOutUnpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a leftover wildcard marker does not revoke a newer confirmed Full-access grant on restart', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6, supersedesMarkerId: 'dg-3-1700000000000-abc' }) },
    session: { accessPreferenceDowngrade: { id: 'dg-3-1700000000000-abc', kind: 'remove', staleRevision: null, maxRevision: 3, at: NOW } },
  });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 200 });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), FULL);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a wildcard marker still revokes a grant whose acknowledgedAt is ahead of the clock unless it explicitly supersedes that downgrade', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6, acknowledgedAt: NOW + 10_000 }) },
    session: {},
  });
  storage.failGet = true;
  storage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  const lowered = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(lowered.ok, true);
  assert.equal(lowered.persisted, false);

  // Storage recovers on restart while the grant with future acknowledgedAt is still on disk.
  storage.failGet = false;
  storage.failRemove = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'future acknowledgedAt alone does not exempt the revoked grant');
  assert.equal(restarted.snapshot().unpersisted, true);

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
});

test('an old grant carrying earlier supersession metadata cannot bypass a new wildcard revocation after unreadable startup', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {
      accessPreference: record({
        remember: true,
        mode: FULL,
        revision: 12,
        acknowledgedAt: NOW - 500,
        supersedesMarkerId: 'dg-10-old-marker',
      }),
    },
    session: {},
  });
  storage.failGet = true;
  storage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  const lowered = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(lowered.ok, true);
  assert.equal(lowered.persisted, false);
  assert.equal(typeof sessionStorage.data.accessPreferenceDowngrade?.id, 'string');
  assert.notEqual(sessionStorage.data.accessPreferenceDowngrade.id, 'dg-10-old-marker');

  storage.failGet = false;
  storage.failRemove = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'new wildcard marker revokes old grant despite old supersedesMarkerId');
  assert.equal(restarted.snapshot().unpersisted, true);

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
});

test('a legacy wildcard marker without an id is upgraded before a new grant supersedes it, or refuses the grant if upgrade fails', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: null, optOutOnly: true, at: NOW - 5 } },
  });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // If upgrading the legacy marker in session storage fails, the new choice is not reported as durably saved.
  sessionStorage.failSet = true;
  const refused = await store.setRemember(
    { remember: true, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks({ full: true }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'storage-failed');

  // Once session storage can upgrade the marker, even if sessionStorage.remove fails, the upgraded id is linked.
  sessionStorage.failSet = false;
  sessionStorage.failRemove = true;
  const accepted = await store.setRemember(
    { remember: true, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks({ full: true }),
  );
  assert.equal(accepted.ok, true);
  const markerId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof markerId, 'string');
  assert.equal(storage.data.accessPreference.supersedesMarkerId, markerId);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'upgraded legacy marker does not revoke the new grant on restart');
});

test('a new grant after a failed startup session-marker read re-reads and binds to the marker before persisting', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: null, maxRevision: 4, at: NOW - 20 } },
  });
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);

  // While the session marker cannot be read, a new grant is refused rather than deleting or ignoring an active marker.
  const whileUnreadable = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(whileUnreadable.ok, false);
  assert.equal(whileUnreadable.reason, 'storage-failed');
  assert.ok('accessPreferenceDowngrade' in sessionStorage.data, 'unreadable marker was not removed before replacement committed');

  // If sessionStorage.get recovers on the first retry but upgrading the legacy marker fails, markerUnknown stays true.
  sessionStorage.failGet = false;
  sessionStorage.failSet = true;
  const upgradeFailed = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(upgradeFailed.ok, false);
  assert.equal(upgradeFailed.reason, 'storage-failed');

  // On the second attempt, upgrading the legacy marker succeeds (even if sessionStorage.remove fails), and the new grant binds to its upgraded id.
  sessionStorage.failSet = false;
  sessionStorage.failRemove = true;
  const raised = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(raised.ok, true);
  const upgradedId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof upgradedId, 'string');
  assert.equal(storage.data.accessPreference.supersedesMarkerId, upgradedId);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'bound grant is not revoked by the leftover marker on restart');
});

test('a new grant after a repeated revocation whose marker write failed writes the pending marker before binding', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    session: {},
  });
  storage.failGet = true;
  storage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // First downgrade writes a wildcard marker in sessionStorage.
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  const firstMarkerId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof firstMarkerId, 'string');

  // Second downgrade fails to write its replacement marker to sessionStorage (while local storage write also fails).
  storage.failSet = true;
  sessionStorage.failSet = true;
  await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: false }));
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.id, firstMarkerId, 'first marker is still on disk');

  // Elevating while sessionStorage.set still fails is refused because the pending marker ID is not on disk.
  storage.failSet = false;
  storage.failGet = false;
  storage.failRemove = false;
  const refused = await store.setRemember(
    { remember: true, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks({ full: true }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'storage-failed');

  // Once sessionStorage.set recovers (even if sessionStorage.remove fails), the pending marker is written and bound.
  sessionStorage.failSet = false;
  sessionStorage.failRemove = true;
  const accepted = await store.setRemember(
    { remember: true, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks({ full: true }),
  );
  assert.equal(accepted.ok, true);
  assert.equal(storage.data.accessPreference.supersedesMarkerId, sessionStorage.data.accessPreferenceDowngrade?.id);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'grant bound to the written marker ID survives restart');
});

test('startup failing to delete a leftover legacy remove marker still upgrades and binds it before the next Full-access grant', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: null, at: NOW - 30 } },
  });
  sessionStorage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.ok('accessPreferenceDowngrade' in sessionStorage.data, 'legacy remove marker survived startup because remove failed');

  const raised = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(raised.ok, true);
  const upgradedId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof upgradedId, 'string');
  assert.equal(storage.data.accessPreference.supersedesMarkerId, upgradedId);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'upgraded and bound leftover marker does not revoke the new grant on restart');
});

test('a failed Full-access binding that discovers an older high-revision marker does not disable pending downgrade retries', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6 }) },
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 8, maxRevision: 8, at: NOW - 50 } },
  });
  storage.failGet = true;
  storage.failRemove = true;
  sessionStorage.failGet = true;
  sessionStorage.failSet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // Downgrade queues a retry at the current profileRevision while both storages fail.
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  const downgradeRev = store.profileRevision;

  // sessionStorage.get recovers so bindToSupersedingMarker reads the older marker (revision 8),
  // while sessionStorage.set still fails so upgrading the pending marker fails.
  sessionStorage.failGet = false;
  const failedRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: downgradeRev },
    makeHooks(),
  );
  assert.equal(failedRaise.ok, false);
  assert.equal(failedRaise.reason, 'storage-failed');
  assert.equal(store.profileRevision, downgradeRev, 'profileRevision was not mutated before replacement committed');

  // Now local storage recovers and the queued downgrade retry still executes and removes the revoked grant.
  storage.failGet = false;
  storage.failRemove = false;
  sessionStorage.failSet = false;
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false, 'pending downgrade retry was not dropped');
});

test('a retry that writes the marker and clears the grant tracks its marker ID even when sessionStorage.remove fails', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    session: {},
  });
  storage.failGet = true;
  storage.failRemove = true;
  sessionStorage.failSet = true;
  sessionStorage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // Initial downgrade fails to write the marker and fails to clear local storage.
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);

  // On retry, sessionStorage.set and local storage succeed, while sessionStorage.remove still fails.
  sessionStorage.failSet = false;
  storage.failGet = false;
  storage.failRemove = false;
  await scheduler.runNext();
  const retryMarkerId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof retryMarkerId, 'string', 'retry wrote the marker');
  assert.equal('accessPreference' in storage.data, false, 'retry cleared local storage');

  // Next Full-access grant binds to retryMarkerId so the leftover marker on disk cannot revoke it on restart.
  const raised = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(raised.ok, true);
  assert.equal(storage.data.accessPreference.supersedesMarkerId, retryMarkerId);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'leftover retry marker does not revoke the bound grant on restart');
});

test('verification retry awaits marker cleanup so a subsequent grant still binds if sessionStorage.remove rejects asynchronously', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: null, at: NOW - 20 } },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // Gate sessionStorage.remove with a deferred promise and an explicit start signal.
  let rejectRemove;
  const originalRemove = sessionStorage.remove;
  const removeStarted = new Promise((resolve) => {
    sessionStorage.remove = (keys) => new Promise((_, reject) => {
      rejectRemove = () => {
        sessionStorage.log.push(['remove', [].concat(keys)]);
        reject(new Error('remove failed'));
      };
      resolve();
    });
  });

  storage.failGet = false;
  const retryPromise = scheduler.runNext();
  await removeStarted;

  // Submit the Full-access grant while verification's sessionStorage.remove is still blocked,
  // and let runnable microtasks drain through a setImmediate turn.
  const raisePromise = store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal('accessPreference' in storage.data, false, 'grant cannot proceed while marker cleanup is in flight');

  // Now fail the deferred marker removal and restore normal remove behavior.
  sessionStorage.remove = originalRemove;
  sessionStorage.failRemove = true;
  rejectRemove();
  await retryPromise;

  const raised = await raisePromise;
  assert.equal(raised.ok, true);
  const upgradedId = sessionStorage.data.accessPreferenceDowngrade?.id;
  assert.equal(typeof upgradedId, 'string');
  assert.equal(storage.data.accessPreference.supersedesMarkerId, upgradedId);

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL);
});

test('applyFull runs synchronously right after storage.set without waiting for marker cleanup', async () => {
  const { storage, sessionStorage } = makeStorage({ initial: {} });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();

  let resolveRemove;
  let appliedBeforeRemoveResolved = false;
  const removeStarted = new Promise((resolve) => {
    const originalRemove = sessionStorage.remove;
    sessionStorage.remove = (keys) => new Promise((res) => {
      resolveRemove = () => {
        sessionStorage.remove = originalRemove;
        res(originalRemove(keys));
      };
      resolve();
    });
  });

  const raisePromise = store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    {
      ...makeHooks(),
      applyFull: () => {
        appliedBeforeRemoveResolved = true;
        return { ok: true, changed: true };
      },
    },
  );
  await removeStarted;
  assert.equal(appliedBeforeRemoveResolved, true, 'applyFull already succeeded before marker cleanup ran');

  resolveRemove();
  const result = await raisePromise;
  assert.equal(result.ok, true);
  assert.equal(store.effectiveDefaultMode(), FULL);
});

test('a rollback after applyFull refusal clears any superseded pending downgrade', async () => {
  const scheduler = makeScheduler();
  const { store, storage } = await started({ accessPreference: record() }, { scheduler });
  storage.failRemove = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(store.snapshot().unpersisted, true);

  // Now storage works, and an elevation supersedes the pending downgrade but applyFull refuses.
  storage.failRemove = false;
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    { ...makeHooks(), applyFull: () => ({ ok: false, reason: 'disposed' }) },
  );
  assert.equal(refused.ok, false);
  assert.equal('accessPreference' in storage.data, false, 'rollback removed the grant');
  assert.equal(store.snapshot().unpersisted, false);

  // Next Full-access request sees no obsolete pending downgrade even if storage.remove fails again.
  storage.failRemove = true;
  const lowered = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks());
  assert.equal(lowered.ok, true);
  assert.equal(lowered.persisted, true);
  assert.equal(store.snapshot().unpersisted, false);
});

test('a refused Full-access grant does not survive a worker restart even when rollback cannot write or remove', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started({}, { scheduler });

  // Rollback fails both sessionStorage.set and storage.remove after applyFull refuses.
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    {
      ...makeHooks(),
      applyFull: () => {
        sessionStorage.failSet = true;
        storage.failRemove = true;
        return { ok: false, reason: 'disposed' };
      },
    },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'disposed');
  assert.equal(storage.data.accessPreference?.mode, FULL, 'rollback removal failed');

  // Worker restarts while the unapplied record is still in local storage: pre-write guard marker revokes it!
  sessionStorage.failSet = false;
  storage.failRemove = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'refused grant is not restored on restart');

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false, 'recovery removed the refused grant');
});

test('a pre-write guard preserves the pending revocation target when the subsequent elevation write fails', async () => {
  const scheduler = makeScheduler();
  const { store, storage, sessionStorage } = await started(
    { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    { scheduler },
  );

  // Downgrade fails to remove the local grant and leaves a pending revocation for revision 4.
  storage.failRemove = true;
  await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4);

  // Elevation writes its pre-write guard, then fails on local storage.set.
  storage.failSet = true;
  const failedRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(failedRaise.ok, false);
  assert.equal(failedRaise.reason, 'storage-failed');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4, 'pending revocation target was preserved');

  // Restart still recognizes revision 4 as revoked and removes it on retry.
  storage.failSet = false;
  storage.failRemove = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'old revoked grant is not restored after failed elevation');

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
});

test('a successful live elevation reports persisted: false when neither guard removal nor fallback rewrite succeeds', async () => {
  const { store, sessionStorage } = await started({});
  const raised = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    {
      ...makeHooks(),
      applyFull: () => {
        sessionStorage.failRemove = true;
        sessionStorage.failSet = true;
        return { ok: true, changed: true };
      },
    },
  );
  assert.equal(raised.ok, true);
  assert.equal(raised.persisted, false);
  assert.equal(raised.warning, 'not-remembered');
  assert.equal(store.effectiveDefaultMode(), ASK, 'new chats still start at Ask first when guard cleanup failed');
  assert.equal(store.snapshot().mode, ASK);
});

test('an elevation during an unverified candidate recovery refuses when local storage is unreadable and preserves candidateRevision', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {
      accessPreference: record({
        remember: true,
        mode: FULL,
        revision: 5,
        supersedesMarkerId: 'dg-5-refused',
      }),
    },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-5-refused',
        kind: 'remove',
        staleRevision: null,
        candidateRevision: 5,
        candidateOnly: true,
        maxRevision: 5,
        at: NOW - 20,
      },
    },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // While local storage remains unreadable, a new elevation cannot verify the pending candidate and is refused.
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'storage-failed');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.candidateRevision, 5, 'unverified candidateRevision was preserved');

  // Once local storage recovers on restart, the refused revision 5 grant is still recognized as revoked.
  storage.failGet = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'refused revision 5 grant is revoked on restart');

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
});

test('a candidate-only guard does not revoke an older valid saved grant with a different revision', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 3 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-6-candidate-only',
        kind: 'remove',
        staleRevision: null,
        candidateRevision: 6,
        candidateOnly: true,
        maxRevision: 6,
        at: NOW - 10,
      },
    },
  });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), FULL, 'unrelated valid grant (revision 3) was not revoked by candidateOnly guard for revision 6');
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('unreadable startup with an optOutOnly guard that also has a candidateRevision retains the candidate and revokes the uncommitted grant on retry', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {
      accessPreference: record({
        remember: true,
        mode: FULL,
        revision: 7,
        supersedesMarkerId: 'dg-7-optout-candidate',
      }),
    },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-7-optout-candidate',
        kind: 'remember-off',
        staleRevision: null,
        candidateRevision: 7,
        optOutOnly: true,
        maxRevision: 7,
        at: NOW - 15,
      },
    },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().unpersisted, true, 'candidateRevision prevents treating Full access as already gone while unreadable');

  storage.failGet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK, 'uncommitted Full-access candidate was revoked and replaced by opt-out');
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('elevation recovery discovering an explicit remember: false opt-out rejects the in-flight remembered elevation as stale-profile-revision', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: false, mode: ASK, revision: 4 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-6-candidate-only',
        kind: 'remove',
        staleRevision: null,
        candidateRevision: 6,
        candidateOnly: true,
        maxRevision: 6,
        at: NOW - 10,
      },
    },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.snapshot().remember, true, 'provisional state defaults to remember: true');

  storage.failGet = false;
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-profile-revision');
  assert.equal(store.snapshot().remember, false, 'explicit remember: false opt-out was restored and not overwritten');
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
});

test('when both storage reads fail at startup, a later elevation verifies and retains a recovered revocation in its replacement guard', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-4-revoked',
        kind: 'remove',
        staleRevision: 4,
        maxRevision: 4,
        at: NOW - 20,
      },
    },
  });
  storage.failGet = true;
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();

  // Session storage becomes readable while local storage is still unreadable: elevation must refuse rather than overwriting the marker.
  sessionStorage.failGet = false;
  const whileLocalUnreadable = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(whileLocalUnreadable.ok, false);
  assert.equal(whileLocalUnreadable.reason, 'storage-failed');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4);

  // Local storage becomes readable for get, while set fails during elevation: the pre-write guard and rollback preserve staleRevision: 4.
  storage.failGet = false;
  storage.failSet = true;
  const writeFailed = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(writeFailed.ok, false);
  assert.equal(writeFailed.reason, 'storage-failed');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4, 'recovered revocation target was retained');
  assert.equal(Boolean(sessionStorage.data.accessPreferenceDowngrade?.candidateOnly), false);

  // A second failed elevation write in the same worker still retains the recovered revocation.
  const secondWriteFailed = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(secondWriteFailed.ok, false);
  assert.equal(secondWriteFailed.reason, 'storage-failed');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 4, 'recovered revocation survived a second failed elevation');

  // Restart still recognizes revision 4 as revoked.
  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK);
});

test('marker-free recovery after an unreadable startup verifies a durable remember: false opt-out and rejects remembered elevation', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: false, mode: ASK, revision: 5 }) },
    session: {},
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.equal(store.snapshot().remember, true, 'provisional state defaults to remember: true');

  storage.failGet = false;
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-profile-revision');
  assert.equal(store.snapshot().remember, false);
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
});

test('a matching remember-off marker recovered after both startup reads fail restores remember: false, rejects the in-flight elevation, and writes the durable opt-out inline', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-6-rem-off',
        kind: 'remember-off',
        staleRevision: 6,
        maxRevision: 6,
        at: NOW - 20,
      },
    },
  });
  storage.failGet = true;
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.snapshot().remember, true);

  storage.failGet = false;
  sessionStorage.failGet = false;
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-profile-revision');
  assert.equal(store.snapshot().remember, false, 'recovered remember-off marker updated consent scope to remember: false');
  assert.equal(storage.data.accessPreference.remember, false, 'durable opt-out was written inline without waiting for a retry timer');
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('marker-only read recovery classifies a matching remember-off marker against the already-loaded local record', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-6-rem-off-session-only',
        kind: 'remember-off',
        staleRevision: 6,
        maxRevision: 6,
        at: NOW - 20,
      },
    },
  });
  // Only sessionStorage.get fails at startup; local storage read succeeds.
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().remember, true);

  sessionStorage.failGet = false;
  storage.failSet = true;
  storage.failRemove = true;
  const refused = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-profile-revision');
  assert.equal(store.snapshot().remember, false, 'marker-only recovery restored remember: false');
  assert.equal(store.snapshot().unpersisted, true, 'inline write failed so retry was queued');

  storage.failSet = false;
  storage.failRemove = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('retrying a pending remember-off opt-out does not call downgradeAll on a newer chat-only Full-access grant', async () => {
  const scheduler = makeScheduler();
  const { store, storage } = await started({ accessPreference: record() }, { scheduler });
  storage.failSet = true;
  storage.failRemove = true;
  const firstHooks = makeHooks({ full: true });
  await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, firstHooks);
  assert.deepEqual(firstHooks.calls, ['downgradeAll']);

  // Now the user grants chat-only Full access while remember is off.
  const chatOnlyHooks = makeHooks({ full: false });
  const chatOnly = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    chatOnlyHooks,
  );
  assert.equal(chatOnly.ok, true);
  assert.equal(chatOnlyHooks.live.full, true);

  // Retrying setRemember({ remember: false }) repairs persistence without calling downgradeAll on the live chat-only grant.
  // First try a failing repair to verify it invalidates the older retry timer even though profileRevision stays the same.
  await store.setRemember(
    { remember: false, expectedProfileRevision: store.profileRevision },
    chatOnlyHooks,
  );
  assert.equal(scheduler.queue.length, 2, 'initial opt-out timer and repair timer are both in the scheduler queue');

  storage.failSet = false;
  storage.failRemove = false;
  // Running the stale timer from the initial opt-out must be a no-op because the repair replaced pending.id.
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.mode, FULL, 'stale timer from before the repair did not fire on the replacement');

  const repair = await store.setRemember(
    { remember: false, expectedProfileRevision: store.profileRevision },
    chatOnlyHooks,
  );
  assert.equal(repair.ok, true);
  assert.equal(repair.persisted, true);
  assert.equal(chatOnlyHooks.live.full, true, 'chat-only Full access was not revoked by persistence repair');
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(storage.data.accessPreference.mode, ASK);
});

test('upgrading a restored legacy marker during a failed elevation does not invalidate its startup retry timer', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 4 }) },
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 4, at: NOW - 15 } },
  });
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.effectiveDefaultMode(), ASK);
  assert.equal(store.snapshot().unpersisted, true);

  // An elevation attempt upgrades the legacy marker in sessionStorage, then fails on local storage.set.
  storage.failSet = true;
  const failedRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(failedRaise.ok, false);
  assert.equal(failedRaise.reason, 'storage-failed');
  assert.equal(typeof sessionStorage.data.accessPreferenceDowngrade?.id, 'string', 'legacy marker was upgraded with an id');

  // The startup retry timer still fires and removes the revoked Full-access record.
  storage.failSet = false;
  await scheduler.runNext();
  assert.equal('accessPreference' in storage.data, false, 'startup retry timer still executed after marker upgrade');
  assert.equal(store.snapshot().unpersisted, false);
});

test('rewriting an ID-less candidate-only marker during an unreadable retry preserves candidateRevision and candidateOnly across restart', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 3 }) },
    session: {
      accessPreferenceDowngrade: {
        kind: 'remove',
        staleRevision: null,
        candidateRevision: 6,
        candidateOnly: true,
        maxRevision: 6,
        at: NOW - 10,
      },
    },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // First retry runs while local storage is still unreadable and upgrades the ID-less marker in sessionStorage.
  await scheduler.runNext();
  assert.equal(typeof sessionStorage.data.accessPreferenceDowngrade?.id, 'string');
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.candidateRevision, 6);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.candidateOnly, true);

  // Worker restarts once local storage is readable: the upgraded candidate-only marker does not revoke unrelated revision 3.
  storage.failGet = false;
  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'unrelated saved grant (revision 3) was preserved on restart');
  assert.equal('accessPreferenceDowngrade' in sessionStorage.data, false);
});

test('a matching wildcard recovery includes the verified local record revision in the allocation floor', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 9 }) },
    session: {
      accessPreferenceDowngrade: {
        id: 'dg-2-wildcard',
        kind: 'remove',
        staleRevision: null,
        maxRevision: 2,
        at: NOW - 20,
      },
    },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  storage.failGet = false;
  const raised = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision },
    makeHooks(),
  );
  assert.equal(raised.ok, true);
  assert.ok(storage.data.accessPreference.revision > 9, 'new grant revision exceeds the verified stored record revision 9');
});

test('a recovered marker revision floor is retained across a failed local preference write', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { id: 'dg-2-exact', kind: 'remove', staleRevision: 2, maxRevision: 2, at: NOW - 30 } },
  });
  storage.failGet = true;
  sessionStorage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.equal(store.profileRevision, 1);

  // First Full-access attempt reads the session marker (staleRevision: 2) while local storage.set fails.
  storage.failGet = false;
  sessionStorage.failGet = false;
  storage.failSet = true;
  const failedRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: 1 },
    makeHooks(),
  );
  assert.equal(failedRaise.ok, false);
  assert.equal(failedRaise.reason, 'storage-failed');

  // Second Full-access attempt succeeds (while sessionStorage.remove fails); it must still use revision > 2.
  storage.failSet = false;
  sessionStorage.failRemove = true;
  const succeededRaise = await store.setMode(
    { mode: FULL, acknowledged: true, expectedProfileRevision: 1 },
    makeHooks(),
  );
  assert.equal(succeededRaise.ok, true);
  assert.ok(storage.data.accessPreference.revision > 2, 'recovered revision floor was retained across the failed write');

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'leftover exact marker with staleRevision 2 does not match the new grant');
});

test('an explicit new revocation after an unreadable startup journals against the current grant on disk', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 6 }) },
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 4, at: NOW - 10 } },
  });
  storage.failGet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  // Storage becomes readable for get, while remove fails during the explicit new revocation.
  storage.failGet = false;
  storage.failRemove = true;
  const lowered = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(lowered.ok, true);
  assert.equal(lowered.persisted, false);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, 6);

  // A worker restart now matches revision 6 and revokes it instead of restoring it.
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK);
  assert.equal(restarted.snapshot().unpersisted, true);

  storage.failRemove = false;
  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
});

test('unknown-revision revocation with repeated read failures and an older high-revision grant does not restore Full access on restart', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: { accessPreference: record({ remember: true, mode: FULL, revision: 12, acknowledgedAt: NOW - 500 }) },
    session: {},
  });
  storage.failGet = true;
  storage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();

  const lowered = await store.setMode({ mode: ASK, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(lowered.ok, true);
  assert.equal(lowered.persisted, false);
  assert.equal(sessionStorage.data.accessPreferenceDowngrade?.staleRevision, null);

  // Storage recovers on restart while the older high-revision grant is still on disk.
  storage.failGet = false;
  storage.failRemove = false;
  const restartedScheduler = makeScheduler();
  const restarted = createAccessPreferenceStore({
    storage,
    sessionStorage,
    now: () => NOW + 50,
    schedule: restartedScheduler.schedule,
  });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), ASK, 'older high-revision grant is revoked, not mistaken for a newer choice');
  assert.equal(restarted.snapshot().unpersisted, true);

  await restartedScheduler.runNext();
  assert.equal('accessPreference' in storage.data, false);
  assert.equal(restarted.snapshot().unpersisted, false);
});

test('a leftover exact marker with empty local storage advances the revision high-water mark so a new grant never reuses its revision', async () => {
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remove', staleRevision: 2, maxRevision: 2, at: NOW - 100 } },
  });
  sessionStorage.failRemove = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW });
  await store.init();
  assert.ok(store.profileRevision >= 2, 'high-water mark from leftover marker is preserved');

  const raised = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: store.profileRevision }, makeHooks());
  assert.equal(raised.ok, true);
  assert.ok(storage.data.accessPreference.revision > 2, 'newly acknowledged grant uses a higher revision than the leftover marker');

  const restarted = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW + 50 });
  await restarted.init();
  assert.equal(restarted.effectiveDefaultMode(), FULL, 'leftover exact marker does not revoke the newer grant');
});

test('verification transitioning from unpersisted Full-access warning to optOutUnpersisted notifies listeners even when the opt-out write fails', async () => {
  const scheduler = makeScheduler();
  const { storage, sessionStorage } = makeStorage({
    initial: {},
    session: { accessPreferenceDowngrade: { kind: 'remember-off', staleRevision: 4, at: NOW - 10 } },
  });
  storage.failGet = true;
  storage.failSet = true;
  const store = createAccessPreferenceStore({ storage, sessionStorage, now: () => NOW, schedule: scheduler.schedule });
  await store.init();
  assert.equal(store.snapshot().unpersisted, true);
  assert.equal(store.snapshot().optOutUnpersisted, false);

  const views = [];
  store.subscribe((view) => views.push(view));

  storage.failGet = false;
  await scheduler.runNext();
  assert.equal(store.snapshot().unpersisted, false);
  assert.equal(store.snapshot().optOutUnpersisted, true);
  assert.ok(views.some((v) => v.unpersisted === false && v.optOutUnpersisted === true), 'panel listener was notified of the updated warning flags');
});
