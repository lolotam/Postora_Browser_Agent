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
  const result = await store.setMode({ mode: FULL, acknowledged: true, expectedProfileRevision: before }, hooks);
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
  const result = await store.setRemember({ remember: false, expectedProfileRevision: store.profileRevision }, makeHooks({ full: true }));
  assert.equal(result.ok, true);
  assert.equal(result.warning, 'not-cleared');
  assert.equal(store.snapshot().remember, false);
  storage.failSet = false;
  await scheduler.runNext();
  assert.equal(storage.data.accessPreference.remember, false);
  assert.equal(store.snapshot().unpersisted, false);
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
