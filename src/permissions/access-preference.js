// The access mode the owner chose, remembered for this browser profile.
//
// One record under its own `chrome.storage.local` key. It is not part of the
// settings, so a settings save, a backup, a Drive backup, an import, a
// transcript or a session body can never carry it. Only the worker reads and
// writes it, and only because a verified side panel asked.
//
// What is remembered, and what is not:
//  - Full access is remembered only while "remember" is on, only for new chats
//    and a restarted worker, and only when the worker could first close the
//    storage to content scripts (`TRUSTED_CONTEXTS`). Otherwise every chat
//    starts at Ask first.
//  - The `localExecution` field is reserved. Whatever is stored there is
//    ignored: PowerShell, project commands, project writes and page JavaScript
//    always ask.
//  - Taking authority away is applied to the live chats first and stored
//    afterwards. A downgrade that cannot be stored is retried for its own
//    revision only, and never comes back with a restart of the worker.
//
// Every change goes through one queue and names the profile revision the
// panel last saw. The worker applies the change to its chats through `hooks`:
// the store owns the record, the worker owns the chats.

import { ASK_FIRST, FULL_ACCESS } from './policy.js';

export const ACCESS_PREFERENCE_KEY = 'accessPreference';
export const ACCESS_PREFERENCE_VERSION = 1;
/** Written to `chrome.storage.session` while a downgrade is not stored yet. */
export const ACCESS_DOWNGRADE_MARKER_KEY = 'accessPreferenceDowngrade';

const RETRY_DELAYS_MS = [2000, 10000, 60000];
const MODES = [ASK_FIRST, FULL_ACCESS];

/** The record as it is stored, or null when it is not a record this version wrote. */
function readableRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== ACCESS_PREFERENCE_VERSION) return null;
  if (typeof raw.remember !== 'boolean') return null;
  if (!MODES.includes(raw.mode)) return null;
  // A choice nobody acknowledged is not a choice.
  if (typeof raw.acknowledgedAt !== 'number' || !Number.isFinite(raw.acknowledgedAt) || raw.acknowledgedAt <= 0) return null;
  const revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
  return { remember: raw.remember, mode: raw.mode, revision };
}

/** The marker of a downgrade that is not stored yet, or null. */
function readableMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'remove' && raw.kind !== 'remember-off') return null;
  const stale = Number.isInteger(raw.staleRevision) ? raw.staleRevision : null;
  return { kind: raw.kind, staleRevision: stale };
}

export function createAccessPreferenceStore({
  storage = globalThis.chrome?.storage?.local,
  sessionStorage = globalThis.chrome?.storage?.session,
  now = () => Date.now(),
  // Not part of the stored contract: a test runs the retries by hand.
  schedule = (fn, ms) => setTimeout(fn, ms),
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  // What is in force. `mode` is what new chats may start with.
  const state = {
    remember: true,
    mode: ASK_FIRST,
    profileRevision: 1,
    // The record that is really in storage, or null when there is none.
    stored: null,
  };
  let started = false;
  let protectedOk = false;
  let restoreFailed = false;
  let startPromise = null;
  // A downgrade that is not in storage yet: { kind, forRevision, staleRevision }.
  let pending = null;
  let unpersisted = false;
  const listeners = new Set();

  // ---------- reading ----------

  function effectiveDefaultMode() {
    if (!started || !protectedOk || !state.remember || pending) return ASK_FIRST;
    return state.mode;
  }

  function snapshot() {
    return {
      remember: state.remember,
      mode: effectiveDefaultMode(),
      // Reserved: PowerShell, project commands, project writes and page
      // JavaScript always ask in this delivery.
      localExecution: false,
      profileRevision: state.profileRevision,
      restoreFailed,
      unpersisted,
      protected: protectedOk,
    };
  }

  function notify() {
    const view = snapshot();
    for (const listener of [...listeners]) {
      try { listener({ ...view }); } catch { /* a listener never breaks the store */ }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------- one queue ----------

  let tail = Promise.resolve();
  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  // ---------- start ----------

  async function start() {
    try {
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      protectedOk = true;
    } catch {
      protectedOk = false;
    }
    let record = null;
    let unreadable = false;
    try {
      const got = await storage.get(ACCESS_PREFERENCE_KEY);
      record = readableRecord(got?.[ACCESS_PREFERENCE_KEY]);
    } catch {
      unreadable = true;
    }
    if (record) {
      state.remember = record.remember;
      state.mode = record.mode;
      state.profileRevision = record.revision;
      state.stored = record;
    }
    let marker = null;
    try {
      const got = await sessionStorage.get(ACCESS_DOWNGRADE_MARKER_KEY);
      marker = readableMarker(got?.[ACCESS_DOWNGRADE_MARKER_KEY]);
    } catch { /* no marker */ }
    if (marker) {
      // The marker belongs to the record it was made for. A record that was
      // written since is a newer choice, and the marker is old news.
      if (record && marker.staleRevision !== null && record.revision === marker.staleRevision) {
        pending = { kind: marker.kind, forRevision: state.profileRevision, staleRevision: marker.staleRevision };
        if (marker.kind === 'remember-off') state.remember = false;
        state.mode = ASK_FIRST;
        unpersisted = true;
      } else {
        forgetMarker();
      }
    }
    restoreFailed = unreadable || (!protectedOk && Boolean(record?.remember) && record?.mode === FULL_ACCESS);
    started = true;
    if (pending) scheduleRetry(0);
  }

  /** Starts the store once. It never rejects: a failure is a store that asks. */
  function init() {
    if (!startPromise) {
      startPromise = start().catch(() => {
        started = true;
        protectedOk = false;
        restoreFailed = true;
      });
    }
    return startPromise;
  }

  // ---------- writing ----------

  function recordFor({ remember, mode, revision }) {
    return {
      remember,
      mode,
      localExecution: false,
      revision,
      acknowledgedAt: now(),
      version: ACCESS_PREFERENCE_VERSION,
    };
  }

  function forgetMarker() {
    try {
      Promise.resolve(sessionStorage.remove(ACCESS_DOWNGRADE_MARKER_KEY)).catch(() => {});
    } catch { /* the marker is only a help */ }
  }

  async function writeMarker(value) {
    try { await sessionStorage.set({ [ACCESS_DOWNGRADE_MARKER_KEY]: value }); } catch { /* best effort */ }
  }

  /** The newer choice settles the old downgrade: its retries stop. */
  function supersede() {
    if (!pending && !unpersisted) return;
    pending = null;
    unpersisted = false;
    forgetMarker();
  }

  function refuse(reason, extra = {}) {
    return { ok: false, changed: false, reason, persisted: false, preference: snapshot(), ...extra };
  }

  function staleRequest(expected) {
    return typeof expected === 'number' && expected !== state.profileRevision;
  }

  /** What a durable downgrade writes: the smallest write that removes Full access. */
  function clearOnce(kind, revision) {
    if (kind === 'remove') return storage.remove(ACCESS_PREFERENCE_KEY);
    return storage.set({ [ACCESS_PREFERENCE_KEY]: recordFor({ remember: false, mode: ASK_FIRST, revision }) });
  }

  function settleStored(kind, revision) {
    state.stored = kind === 'remove' ? null : { remember: false, mode: ASK_FIRST, revision };
  }

  /**
   * Stores a downgrade that was already applied to the live chats. A failure
   * is not an error: the downgrade is in force, it is retried for this
   * revision only, and the panel is told that it was not stored.
   */
  async function clearStored(kind) {
    const revision = state.profileRevision;
    const staleRevision = state.stored?.mode === FULL_ACCESS && state.stored.remember ? state.stored.revision : null;
    try {
      await clearOnce(kind, revision);
      settleStored(kind, revision);
      return { persisted: true };
    } catch {
      if (staleRevision === null) return { persisted: false, warning: 'not-remembered' };
      pending = { kind, forRevision: revision, staleRevision };
      unpersisted = true;
      await writeMarker({ kind, staleRevision, at: now() });
      scheduleRetry(0);
      return { persisted: false, warning: 'not-cleared' };
    }
  }

  function scheduleRetry(index) {
    const delay = retryDelaysMs[index];
    if (delay === undefined) return;
    schedule(() => enqueue(() => retry(index)), delay);
  }

  async function retry(index) {
    // A newer choice owns the record now: a late retry must not touch it.
    if (!pending || pending.forRevision !== state.profileRevision) return;
    const { kind, forRevision } = pending;
    try {
      await clearOnce(kind, forRevision);
    } catch {
      scheduleRetry(index + 1);
      return;
    }
    settleStored(kind, forRevision);
    pending = null;
    unpersisted = false;
    forgetMarker();
    notify();
  }

  // ---------- changes ----------

  /** Everything after the checks of a Full access request. */
  async function raise(hooks) {
    const refusal = hooks?.precheckFull?.();
    if (refusal) return refuse(refusal.reason ?? 'refused');
    if (!state.remember || !protectedOk) {
      // For this chat only: nothing is written.
      const applied = hooks?.applyFull?.();
      if (!applied?.ok) return refuse(applied?.reason ?? 'refused');
      const warning = state.remember && !protectedOk ? 'protection-unavailable' : undefined;
      return { ok: true, changed: Boolean(applied.changed), persisted: false, ...(warning ? { warning } : {}), preference: snapshot() };
    }
    const revision = state.profileRevision + 1;
    const next = recordFor({ remember: true, mode: FULL_ACCESS, revision });
    try {
      // Written first: a Full access that was not stored is not remembered.
      await storage.set({ [ACCESS_PREFERENCE_KEY]: next });
    } catch {
      return refuse('storage-failed');
    }
    state.mode = FULL_ACCESS;
    state.profileRevision = revision;
    state.stored = { remember: true, mode: FULL_ACCESS, revision };
    supersede();
    const applied = hooks?.applyFull?.();
    if (!applied?.ok) {
      // No chat took it: it must not stay remembered.
      state.mode = ASK_FIRST;
      state.profileRevision += 1;
      await clearStored('remove');
      notify();
      return refuse(applied?.reason ?? 'refused');
    }
    notify();
    return { ok: true, changed: Boolean(applied.changed), persisted: true, preference: snapshot() };
  }

  async function lower(hooks) {
    // Applied first, to every live chat: taking authority away does not wait
    // for a disk.
    hooks?.downgradeAll?.();
    const wasRemembered = state.mode === FULL_ACCESS || (state.stored?.mode === FULL_ACCESS && state.stored.remember);
    state.mode = ASK_FIRST;
    if (!wasRemembered && !pending) {
      notify();
      return { ok: true, changed: false, persisted: true, preference: snapshot() };
    }
    state.profileRevision += 1;
    supersede();
    const result = await clearStored('remove');
    notify();
    return { ok: true, changed: true, ...result, preference: snapshot() };
  }

  /** Full access or Ask first, for the chat that asked. */
  function setMode(request, hooks) {
    return enqueue(async () => {
      await init();
      const { mode, acknowledged, expectedProfileRevision } = request ?? {};
      if (!MODES.includes(mode)) return refuse('invalid-mode');
      if (mode === FULL_ACCESS && acknowledged !== true) return refuse('not-acknowledged');
      if (mode === FULL_ACCESS && typeof expectedProfileRevision !== 'number') return refuse('stale-profile-revision');
      if (staleRequest(expectedProfileRevision)) return refuse('stale-profile-revision');
      return mode === FULL_ACCESS ? raise(hooks) : lower(hooks);
    });
  }

  /** "Remember" off: every live chat goes back to Ask first, and the opt-out is written. */
  async function turnRememberOff(hooks) {
    hooks?.downgradeAll?.();
    state.remember = false;
    state.mode = ASK_FIRST;
    state.profileRevision += 1;
    supersede();
    // The smallest write is the explicit opt-out: a restart can tell
    // "opted out" from "never chose".
    const result = await clearStored('remember-off');
    notify();
    return { ok: true, changed: true, ...result, preference: snapshot() };
  }

  /** "Remember" on: a Full access that is on is remembered only with the acknowledgment. */
  async function turnRememberOn({ acknowledged }, hooks) {
    const anyFull = Boolean(hooks?.anyFull?.());
    if (anyFull && acknowledged !== true) return refuse('needs-acknowledgement');
    const revision = state.profileRevision + 1;
    const next = recordFor({ remember: true, mode: anyFull && protectedOk ? FULL_ACCESS : ASK_FIRST, revision });
    try {
      await storage.set({ [ACCESS_PREFERENCE_KEY]: next });
    } catch {
      return refuse('storage-failed');
    }
    state.remember = true;
    state.mode = next.mode;
    state.profileRevision = revision;
    state.stored = { remember: true, mode: next.mode, revision };
    supersede();
    notify();
    return {
      ok: true,
      changed: true,
      persisted: true,
      ...(anyFull && !protectedOk ? { warning: 'protection-unavailable' } : {}),
      preference: snapshot(),
    };
  }

  /** The "remember my choice" switch. */
  function setRemember(request, hooks) {
    return enqueue(async () => {
      await init();
      const { remember, acknowledged, expectedProfileRevision } = request ?? {};
      if (typeof remember !== 'boolean') return refuse('invalid-remember');
      if (staleRequest(expectedProfileRevision)) return refuse('stale-profile-revision');
      if (remember === state.remember) return { ok: true, changed: false, persisted: true, preference: snapshot() };
      return remember ? turnRememberOn({ acknowledged }, hooks) : turnRememberOff(hooks);
    });
  }

  return {
    init,
    get ready() { return init(); },
    get profileRevision() { return state.profileRevision; },
    effectiveDefaultMode,
    snapshot,
    subscribe,
    setMode,
    setRemember,
  };
}
