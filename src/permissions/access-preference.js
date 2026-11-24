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

function makeMarkerId(at, revision) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return `dg-${revision}-${at}-${token}`;
}

/** The record as it is stored, or null when it is not a record this version wrote. */
  function readableRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== ACCESS_PREFERENCE_VERSION) return null;
  if (typeof raw.remember !== 'boolean') return null;
  if (!MODES.includes(raw.mode)) return null;
  // A choice nobody acknowledged is not a choice.
  if (typeof raw.acknowledgedAt !== 'number' || !Number.isFinite(raw.acknowledgedAt) || raw.acknowledgedAt <= 0) return null;
  const revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
  const supersedesMarkerId = typeof raw.supersedesMarkerId === 'string' && raw.supersedesMarkerId ? raw.supersedesMarkerId : null;
  return { remember: raw.remember, mode: raw.mode, revision, acknowledgedAt: raw.acknowledgedAt, supersedesMarkerId };
}

/** The marker of a downgrade that is not stored yet, or null. */
function readableMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'remove' && raw.kind !== 'remember-off') return null;
  const stale = Number.isInteger(raw.staleRevision) ? raw.staleRevision : null;
  const candidate = Number.isInteger(raw.candidateRevision) ? raw.candidateRevision : null;
  const maxRevision = Number.isInteger(raw.maxRevision) ? raw.maxRevision : null;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  return { kind: raw.kind, staleRevision: stale, candidateRevision: candidate, optOutOnly: raw.optOutOnly === true, maxRevision, at, id };
}

/**
 * Decides whether a recovered downgrade marker still applies to the readable
 * record currently in `chrome.storage.local` (or `null` when storage is empty).
 */
function classifyMarker(marker, record) {
  if (!record) {
    if (marker.kind === 'remember-off') {
      return { matches: true, fullAlreadyGone: true };
    }
    return { matches: false, fullAlreadyGone: true };
  }
  if (marker.kind === 'remember-off' && record.remember === false && record.mode === ASK_FIRST) {
    return { matches: false, fullAlreadyGone: true };
  }
  if (marker.candidateRevision !== null && record.revision === marker.candidateRevision) {
    return {
      matches: true,
      fullAlreadyGone: record.mode !== FULL_ACCESS,
    };
  }
  if (marker.staleRevision !== null) {
    return {
      matches: record.revision === marker.staleRevision,
      fullAlreadyGone: record.mode !== FULL_ACCESS,
    };
  }
  const newerThanMarker =
    marker.id !== null
    && record.supersedesMarkerId !== null
    && record.supersedesMarkerId === marker.id;
  if (newerThanMarker) {
    return { matches: false, fullAlreadyGone: record.mode !== FULL_ACCESS };
  }
  const matches = record.mode === FULL_ACCESS || (marker.kind === 'remember-off' && record.remember);
  return { matches, fullAlreadyGone: record.mode !== FULL_ACCESS };
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
  let storageUnknown = false;
  let markerUnknown = false;
  let startPromise = null;
  // A downgrade that is not in storage yet: { kind, forRevision, staleRevision }.
  let pending = null;
  let lastMarkerId = null;
  let markerRevisionFloor = 1;
  let unpersisted = false;
  let optOutUnpersisted = false;
  const listeners = new Set();

  // ---------- reading ----------

  function effectiveDefaultMode() {
    if (!started || !protectedOk || !state.remember || pending || storageUnknown) return ASK_FIRST;
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
      optOutUnpersisted,
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
    storageUnknown = unreadable;
    if (record) {
      state.remember = record.remember;
      state.mode = record.mode;
      state.profileRevision = record.revision;
      state.stored = record;
      if (record.supersedesMarkerId !== null) {
        lastMarkerId = record.supersedesMarkerId;
      }
    }
    let marker = null;
    let markerUnreadable = false;
    try {
      if (!sessionStorage?.get) {
        markerUnreadable = true;
      } else {
        const got = await sessionStorage.get(ACCESS_DOWNGRADE_MARKER_KEY);
        marker = readableMarker(got?.[ACCESS_DOWNGRADE_MARKER_KEY]);
      }
    } catch {
      markerUnreadable = true;
    }
    markerUnknown = markerUnreadable;
    const markerUncertainForFull = markerUnreadable && Boolean(record?.remember) && record?.mode === FULL_ACCESS;
    if (markerUncertainForFull) {
      // Cannot verify whether a downgrade marker is pending: fail closed.
      state.mode = ASK_FIRST;
    }
    if (marker) {
      // Preserve the revision high-water mark even when local storage is empty
      // so a leftover marker whose sessionStorage.remove failed can never match
      // a newly acknowledged grant that reuses an old revision number.
      if (marker.id !== null) {
        lastMarkerId = marker.id;
      }
      state.profileRevision = Math.max(
        state.profileRevision,
        record?.revision ?? 1,
        marker.staleRevision ?? 1,
        marker.candidateRevision ?? 1,
        marker.maxRevision ?? 1,
      );
      // The marker belongs to the record it was made for. A record that was
      // written since is a newer choice, and the marker is old news.
      const classification = unreadable ? { matches: true, fullAlreadyGone: marker.optOutOnly } : classifyMarker(marker, record);
      if (classification.matches) {
        const { fullAlreadyGone } = classification;
        state.profileRevision += 1;
        pending = {
          id: marker.id,
          kind: marker.kind,
          forRevision: state.profileRevision,
          staleRevision: fullAlreadyGone ? null : (record?.revision ?? marker.staleRevision),
          candidateRevision: fullAlreadyGone ? null : marker.candidateRevision,
          maxRevision: marker.maxRevision ?? state.profileRevision,
          at: marker.at,
          fullCleared: fullAlreadyGone,
          markerWritten: true,
          needsVerification: unreadable,
        };
        if (marker.kind === 'remember-off') state.remember = false;
        state.mode = ASK_FIRST;
        unpersisted = !fullAlreadyGone;
        optOutUnpersisted = fullAlreadyGone && marker.kind === 'remember-off';
      } else if (!unreadable) {
        const removed = await forgetMarker();
        if (!removed) markerUnknown = true;
      }
    }
    restoreFailed = unreadable || markerUncertainForFull || (!protectedOk && Boolean(record?.remember) && record?.mode === FULL_ACCESS);
    started = true;
    if (pending) scheduleRetry(0, pending.forRevision);
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

  function recordFor({ remember, mode, revision, supersedesMarkerId = null }) {
    return {
      remember,
      mode,
      localExecution: false,
      revision,
      acknowledgedAt: now(),
      ...(supersedesMarkerId !== null ? { supersedesMarkerId } : {}),
      version: ACCESS_PREFERENCE_VERSION,
    };
  }

  function forgetMarker() {
    try {
      return Promise.resolve(sessionStorage.remove(ACCESS_DOWNGRADE_MARKER_KEY)).then(
        () => true,
        () => {
          markerUnknown = true;
          return false;
        },
      );
    } catch {
      markerUnknown = true;
      return Promise.resolve(false);
    }
  }

  async function writeMarker(value) {
    try {
      if (!sessionStorage?.set) return false;
      await sessionStorage.set({ [ACCESS_DOWNGRADE_MARKER_KEY]: value });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensures any active or previously unreadable downgrade marker in
   * `chrome.storage.session` is read and upgraded with a unique `id` before
   * persisting a new choice that supersedes it.
   */
  async function bindToSupersedingMarker() {
    let minRevision = Math.max(state.profileRevision, markerRevisionFloor);
    if (markerUnknown) {
      if (!sessionStorage?.get) return { ok: false };
      let currentMarker = null;
      try {
        const got = await sessionStorage.get(ACCESS_DOWNGRADE_MARKER_KEY);
        currentMarker = readableMarker(got?.[ACCESS_DOWNGRADE_MARKER_KEY]);
      } catch {
        return { ok: false };
      }
      if (currentMarker) {
        markerRevisionFloor = Math.max(
          markerRevisionFloor,
          currentMarker.staleRevision ?? 1,
          currentMarker.candidateRevision ?? 1,
          currentMarker.maxRevision ?? 1,
        );
        minRevision = Math.max(minRevision, markerRevisionFloor);
        if (!currentMarker.id) {
          const upgradedId = makeMarkerId(currentMarker.at ?? now(), minRevision);
          const upgraded = await writeMarker({
            ...currentMarker,
            id: upgradedId,
            maxRevision: currentMarker.maxRevision ?? minRevision,
            at: currentMarker.at ?? now(),
          });
          if (!upgraded) return { ok: false };
          currentMarker.id = upgradedId;
        }
        lastMarkerId = currentMarker.id;
      }
      markerUnknown = false;
    }
    if (pending && (!pending.id || !pending.markerWritten)) {
      const upgradedId = pending.id ?? makeMarkerId(pending.at ?? now(), pending.forRevision);
      const mayHaveFull = !pending.fullCleared;
      const upgraded = await writeMarker({
        id: upgradedId,
        kind: pending.kind,
        staleRevision: pending.staleRevision,
        maxRevision: pending.maxRevision ?? pending.forRevision,
        ...(mayHaveFull ? {} : { optOutOnly: true }),
        at: pending.at ?? now(),
      });
      if (!upgraded) return { ok: false };
      pending.id = upgradedId;
      pending.markerWritten = true;
      lastMarkerId = upgradedId;
    }
    const confirmedMarkerId = pending ? (pending.markerWritten ? pending.id : lastMarkerId) : lastMarkerId;
    return { ok: true, supersedesMarkerId: confirmedMarkerId, minRevision };
  }

  /** The newer choice settles the old downgrade: its retries stop. */
  async function supersede({ keepMarker = false } = {}) {
    if (!keepMarker) await forgetMarker();
    if (!pending && !unpersisted && !optOutUnpersisted) return;
    pending = null;
    unpersisted = false;
    optOutUnpersisted = false;
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

  async function attemptClear(kind, revision, mayHaveFull) {
    try {
      await clearOnce(kind, revision);
      settleStored(kind, revision);
      storageUnknown = false;
      restoreFailed = false;
      return { persisted: true, fullCleared: true };
    } catch {
      if (kind === 'remember-off' && mayHaveFull) {
        try {
          await storage.remove(ACCESS_PREFERENCE_KEY);
          state.stored = null;
          storageUnknown = false;
          restoreFailed = false;
          return { persisted: false, fullCleared: true, warning: 'not-remembered' };
        } catch {
          // Even the smaller write failed; Full access may still be stored.
        }
      }
      return {
        persisted: false,
        fullCleared: !mayHaveFull,
        warning: mayHaveFull ? 'not-cleared' : 'not-remembered',
      };
    }
  }

  /**
   * Stores a downgrade that was already applied to the live chats. A failure
   * is not an error: the downgrade is in force, it is retried for this
   * revision only, and the panel is told that it was not stored.
   */
  async function clearStored(kind, priorStaleRevision = null, priorFullPending = false, priorUnverified = false) {
    if ((storageUnknown || priorUnverified) && !state.stored) {
      try {
        const got = await storage.get(ACCESS_PREFERENCE_KEY);
        const current = readableRecord(got?.[ACCESS_PREFERENCE_KEY]);
        state.stored = current;
        storageUnknown = false;
        if (current && current.revision >= state.profileRevision) {
          state.profileRevision = current.revision + 1;
        }
      } catch {
        storageUnknown = true;
      }
    }
    const revision = state.profileRevision;
    const storedStale = state.stored ? state.stored.revision : null;
    const staleRevision = storedStale ?? priorStaleRevision;
    const mayHaveFull =
      (state.stored?.mode === FULL_ACCESS && state.stored.remember)
      || (priorStaleRevision !== null && !state.stored)
      || storageUnknown
      || (priorFullPending && !state.stored);
    const needsMarker = mayHaveFull || kind === 'remember-off';
    const markerAt = now();
    const markerId = makeMarkerId(markerAt, revision);
    let markerWritten = false;
    // Journal before touching local storage so a worker stop mid-write cannot
    // resurrect a revoked Full-access grant on restart.
    if (needsMarker) {
      markerWritten = await writeMarker({
        id: markerId,
        kind,
        staleRevision,
        maxRevision: revision,
        ...(mayHaveFull ? {} : { optOutOnly: true }),
        at: markerAt,
      });
      if (markerWritten) lastMarkerId = markerId;
    }
    const outcome = await attemptClear(kind, revision, mayHaveFull);
    if (outcome.persisted) {
      unpersisted = false;
      optOutUnpersisted = false;
      await forgetMarker();
      return { persisted: true };
    }
    if (outcome.fullCleared) {
      unpersisted = false;
      if (kind === 'remember-off') {
        optOutUnpersisted = true;
        const optOutMarkerWritten = mayHaveFull
          ? await writeMarker({
            id: markerId,
            kind: 'remember-off',
            staleRevision: null,
            maxRevision: revision,
            optOutOnly: true,
            at: markerAt,
          })
          : markerWritten;
        if (optOutMarkerWritten) lastMarkerId = markerId;
        pending = {
          id: markerId,
          kind,
          forRevision: revision,
          staleRevision: mayHaveFull ? null : staleRevision,
          maxRevision: revision,
          at: markerAt,
          fullCleared: true,
          markerWritten: optOutMarkerWritten,
          needsVerification: false,
        };
        scheduleRetry(0, revision);
      } else {
        optOutUnpersisted = false;
        await forgetMarker();
      }
      return { persisted: false, warning: 'not-remembered' };
    }
    pending = {
      id: markerId,
      kind,
      forRevision: revision,
      staleRevision,
      maxRevision: revision,
      at: markerAt,
      fullCleared: false,
      markerWritten,
      needsVerification: false,
    };
    unpersisted = true;
    optOutUnpersisted = false;
    scheduleRetry(0, revision);
    return { persisted: false, warning: 'not-cleared' };
  }

  function scheduleRetry(index, forRevision) {
    const delay = retryDelaysMs[index];
    if (delay === undefined) return;
    schedule(() => enqueue(() => retry(index, forRevision)), delay);
  }

  async function retry(index, expectedForRevision) {
    // A newer choice owns the record now: a late retry must not touch it.
    if (!pending || pending.forRevision !== expectedForRevision || pending.forRevision !== state.profileRevision) return;
    if (pending.needsVerification) {
      let current = null;
      try {
        const got = await storage.get(ACCESS_PREFERENCE_KEY);
        current = readableRecord(got?.[ACCESS_PREFERENCE_KEY]);
        storageUnknown = false;
      } catch {
        if (!pending.markerWritten) {
          if (!pending.id) pending.id = makeMarkerId(pending.at ?? now(), pending.forRevision);
          pending.markerWritten = await writeMarker({
            id: pending.id,
            kind: pending.kind,
            staleRevision: pending.staleRevision,
            maxRevision: pending.maxRevision,
            ...(pending.fullCleared ? { optOutOnly: true } : {}),
            at: pending.at ?? now(),
          });
          if (pending.markerWritten) lastMarkerId = pending.id;
        }
        scheduleRetry(index + 1, expectedForRevision);
        return;
      }
      const { matches: stillMatches, fullAlreadyGone } = classifyMarker(pending, current);
      if (!stillMatches) {
        const scopeChanged = Boolean(current && (current.remember !== state.remember || current.mode !== state.mode));
        state.stored = current;
        if (current) {
          state.remember = current.remember;
          state.mode = current.mode;
          state.profileRevision = scopeChanged
            ? Math.max(state.profileRevision, current.revision) + 1
            : Math.max(state.profileRevision, current.revision);
        }
        restoreFailed = !protectedOk && Boolean(current?.remember) && current?.mode === FULL_ACCESS;
        pending = null;
        unpersisted = false;
        optOutUnpersisted = false;
        await forgetMarker();
        notify();
        return;
      }
      const nextUnpersisted = !fullAlreadyGone;
      const nextOptOutUnpersisted = fullAlreadyGone && pending.kind === 'remember-off';
      const warningChanged =
        restoreFailed !== false
        || unpersisted !== nextUnpersisted
        || optOutUnpersisted !== nextOptOutUnpersisted;
      state.stored = current;
      restoreFailed = false;
      pending.needsVerification = false;
      pending.fullCleared = fullAlreadyGone;
      unpersisted = nextUnpersisted;
      optOutUnpersisted = nextOptOutUnpersisted;
      if (fullAlreadyGone) {
        pending.staleRevision = current ? current.revision : null;
      } else if (current) {
        pending.staleRevision = current.revision;
      }
      if (warningChanged) notify();
    }
    const { kind, forRevision } = pending;
    const mayHaveFull = !pending.fullCleared;
    if (!pending.markerWritten) {
      if (!pending.id) pending.id = makeMarkerId(pending.at ?? now(), forRevision);
      pending.markerWritten = await writeMarker({
        id: pending.id,
        kind,
        staleRevision: pending.staleRevision,
        maxRevision: pending.maxRevision ?? forRevision,
        ...(mayHaveFull ? {} : { optOutOnly: true }),
        at: pending.at ?? now(),
      });
      if (pending.markerWritten) lastMarkerId = pending.id;
    }
    const outcome = await attemptClear(kind, forRevision, mayHaveFull);
    if (outcome.persisted) {
      pending = null;
      unpersisted = false;
      optOutUnpersisted = false;
      await forgetMarker();
      notify();
      return;
    }
    if (outcome.fullCleared && mayHaveFull) {
      unpersisted = false;
      if (kind === 'remember-off') {
        optOutUnpersisted = true;
        if (!pending.id) pending.id = makeMarkerId(pending.at ?? now(), forRevision);
        const optOutMarkerWritten = await writeMarker({
          id: pending.id,
          kind: 'remember-off',
          staleRevision: null,
          maxRevision: pending.maxRevision ?? forRevision,
          optOutOnly: true,
          at: pending.at ?? now(),
        });
        if (optOutMarkerWritten) lastMarkerId = pending.id;
        pending = {
          ...pending,
          staleRevision: null,
          fullCleared: true,
          markerWritten: optOutMarkerWritten,
        };
        notify();
        scheduleRetry(index + 1, expectedForRevision);
      } else {
        optOutUnpersisted = false;
        pending = null;
        await forgetMarker();
        notify();
      }
      return;
    }
    scheduleRetry(index + 1, expectedForRevision);
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
    const hadRememberedFull =
      state.mode === FULL_ACCESS
      && state.stored?.remember === true
      && state.stored?.mode === FULL_ACCESS
      && !pending
      && !storageUnknown
      && !markerUnknown;
    if (hadRememberedFull) {
      const applied = hooks?.applyFull?.();
      if (!applied?.ok) return refuse(applied?.reason ?? 'refused');
      return { ok: true, changed: Boolean(applied.changed), persisted: true, preference: snapshot() };
    }
    const bound = await bindToSupersedingMarker();
    if (!bound.ok) return refuse('storage-failed');
    const revision = Math.max(state.profileRevision, bound.minRevision, pending?.maxRevision ?? 0) + 1;
    let { supersedesMarkerId } = bound;
    let wrotePreWriteGuard = false;
    const priorPending = pending ? { ...pending } : null;
    if (sessionStorage?.set) {
      const guardId = supersedesMarkerId ?? makeMarkerId(now(), revision);
      const guarded = await writeMarker({
        id: guardId,
        kind: priorPending?.kind ?? 'remove',
        staleRevision: priorPending ? priorPending.staleRevision : null,
        candidateRevision: revision,
        maxRevision: Math.max(revision, priorPending?.maxRevision ?? 0),
        ...(priorPending?.fullCleared ? { optOutOnly: true } : {}),
        at: now(),
      });
      if (!guarded && priorPending) return refuse('storage-failed');
      if (guarded) {
        wrotePreWriteGuard = true;
        lastMarkerId = guardId;
        supersedesMarkerId = guardId;
      }
    }
    const next = recordFor({ remember: true, mode: FULL_ACCESS, revision, supersedesMarkerId });
    try {
      // Written first: a Full access that was not stored is not remembered.
      await storage.set({ [ACCESS_PREFERENCE_KEY]: next });
    } catch {
      if (wrotePreWriteGuard) {
        if (priorPending) {
          await writeMarker({
            id: priorPending.id,
            kind: priorPending.kind,
            staleRevision: priorPending.staleRevision,
            maxRevision: priorPending.maxRevision ?? priorPending.forRevision,
            ...(priorPending.fullCleared ? { optOutOnly: true } : {}),
            at: priorPending.at ?? now(),
          });
        } else {
          await forgetMarker();
        }
      }
      return refuse('storage-failed');
    }
    state.mode = FULL_ACCESS;
    state.profileRevision = revision;
    state.stored = {
      remember: true,
      mode: FULL_ACCESS,
      revision,
      acknowledgedAt: next.acknowledgedAt,
      supersedesMarkerId,
    };
    storageUnknown = false;
    restoreFailed = false;
    if (pending || unpersisted || optOutUnpersisted) {
      pending = null;
      unpersisted = false;
      optOutUnpersisted = false;
    }
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
    let guardCleared = await forgetMarker();
    if (!guardCleared && wrotePreWriteGuard) {
      guardCleared = await writeMarker({
        id: supersedesMarkerId,
        kind: 'remove',
        staleRevision: null,
        maxRevision: revision - 1,
        at: now(),
      });
    }
    if (!guardCleared && wrotePreWriteGuard) {
      return { ok: true, changed: Boolean(applied.changed), persisted: false, warning: 'not-remembered', preference: snapshot() };
    }
    return { ok: true, changed: Boolean(applied.changed), persisted: true, preference: snapshot() };
  }

  async function lower(hooks) {
    // Applied first, to every live chat: taking authority away does not wait
    // for a disk.
    hooks?.downgradeAll?.();
    const kind = state.remember ? 'remove' : 'remember-off';
    const hasPendingOptOut = Boolean(pending && pending.kind === 'remember-off');
    const priorUnverified = Boolean(pending && pending.needsVerification);
    const priorStale = pending && !pending.fullCleared && !priorUnverified ? pending.staleRevision : null;
    const priorFullPending = Boolean(pending && !pending.fullCleared);
    const needsOptOutWrite = !state.remember && (state.stored?.remember !== false || state.stored?.mode !== ASK_FIRST);
    const mayBeStored =
      state.mode === FULL_ACCESS
      || (state.stored?.mode === FULL_ACCESS && state.stored.remember)
      || storageUnknown
      || priorFullPending;
    state.mode = ASK_FIRST;
    // Always advance the profile revision on an accepted profile-wide
    // revocation so earlier elevation warnings in any chat become stale.
    state.profileRevision += 1;
    if (!mayBeStored && !pending && !needsOptOutWrite) {
      notify();
      return { ok: true, changed: false, persisted: true, preference: snapshot() };
    }
    supersede({ keepMarker: true });
    const result = await clearStored(hasPendingOptOut ? 'remember-off' : kind, priorStale, priorFullPending, priorUnverified);
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
    const priorUnverified = Boolean(pending && pending.needsVerification);
    const priorStale = pending && !pending.fullCleared && !priorUnverified ? pending.staleRevision : null;
    const priorFullPending = Boolean(pending && !pending.fullCleared);
    hooks?.downgradeAll?.();
    state.remember = false;
    state.mode = ASK_FIRST;
    state.profileRevision += 1;
    supersede({ keepMarker: true });
    // The smallest write is the explicit opt-out: a restart can tell
    // "opted out" from "never chose".
    const result = await clearStored('remember-off', priorStale, priorFullPending, priorUnverified);
    notify();
    return { ok: true, changed: true, ...result, preference: snapshot() };
  }

  /** "Remember" on: a Full access that is on is remembered only with the acknowledgment. */
  async function turnRememberOn({ acknowledged }, hooks) {
    const anyFull = Boolean(hooks?.anyFull?.());
    if (anyFull && acknowledged !== true) return refuse('needs-acknowledgement');
    const bound = await bindToSupersedingMarker();
    if (!bound.ok) return refuse('storage-failed');
    const revision = Math.max(state.profileRevision, bound.minRevision, pending?.maxRevision ?? 0) + 1;
    const { supersedesMarkerId } = bound;
    const next = recordFor({
      remember: true,
      mode: anyFull && protectedOk ? FULL_ACCESS : ASK_FIRST,
      revision,
      supersedesMarkerId,
    });
    try {
      await storage.set({ [ACCESS_PREFERENCE_KEY]: next });
    } catch {
      return refuse('storage-failed');
    }
    state.remember = true;
    state.mode = next.mode;
    state.profileRevision = revision;
    state.stored = {
      remember: true,
      mode: next.mode,
      revision,
      acknowledgedAt: next.acknowledgedAt,
      supersedesMarkerId,
    };
    storageUnknown = false;
    restoreFailed = false;
    await supersede();
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
      if (remember && typeof expectedProfileRevision !== 'number') return refuse('stale-profile-revision');
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
