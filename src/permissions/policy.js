// The one place that says what a session may do.
//
// The worker owns one AccessAuthority per session, and it is the source of
// truth for the access mode and for every approval. The panel and the prompt
// only describe what it says: neither can raise the mode, and nothing outside
// this file decides whether an action runs.
//
// Nothing here is stored. The authority lives in the worker's memory for as
// long as the session does, so a new chat and a restarted worker both start
// at Ask first — a mode can never come back from settings, a transcript or a
// replayed message.
//
// The interface an executor needs is small:
//
//   const { permit, reason } = await authority.authorize({ action, args, tabId, target }, { signal });
//   if (!permit || !authority.grantValid(permit, { action, args, tabId, target })) return;
//   // the action may run
//
// `authorize` asks the user only when the mode and the action say it must.
// Every permit it hands out is bound to that one operation, to the command
// that asked for it, and to the moment it was issued: a mode change, a stop,
// the end of the run, or an aborted command withdraws it.
//
// The metadata of an operation is plain JSON — objects, arrays, strings,
// numbers, booleans and null. Anything else is refused rather than copied in
// a way two different values could look alike.

export const ASK_FIRST = 'ask-first';
export const FULL_ACCESS = 'full-access';
export const MODES = [ASK_FIRST, FULL_ACCESS];

/** What an action is, by the tool that performs it. */
export const OBSERVE = 'observe';
export const INTERACT = 'interact';
export const SENSITIVE = 'sensitive';

/** The two answers a question can get. */
export const ALLOW = 'allow';
export const DENY = 'deny';

// Observations are free in every mode: reading a page, taking a screenshot,
// listing tabs, the notebook and waiting never change anything on the site.
// Interactions and explicit field reads are the user's decision.
// A tool this file does not know counts as an interaction: a new tool has to
// be classified on purpose before it may run unattended.
const OBSERVATIONS = new Set([
  'read_page', 'get_text', 'screenshot', 'list_tabs',
  'note', 'read_notes', 'wait', 'ask_user', 'done',
]);

// An explicit read of one field's value, secret or not.
const SENSITIVE_READS = new Set(['read_field']);

/** Anything but the exact Full-access name is Ask first. */
export function normalizeMode(mode) {
  return mode === FULL_ACCESS ? FULL_ACCESS : ASK_FIRST;
}

/** What kind of action a tool is. Unknown tools are interactions. */
export function classifyAction(tool) {
  if (OBSERVATIONS.has(tool)) return OBSERVE;
  if (SENSITIVE_READS.has(tool)) return SENSITIVE;
  return INTERACT;
}

/** Whether the mode lets this action run without asking the user first. */
export function requiresApproval(mode, action) {
  if (action === OBSERVE) return false;
  return normalizeMode(mode) !== FULL_ACCESS;
}

/** How much authority a kind of action asks for. */
function kindRank(kind) {
  if (kind === OBSERVE) return 0;
  if (kind === INTERACT) return 1;
  if (kind === SENSITIVE) return 2;
  return -1;
}

/**
 * The kind of an action, decided here.
 *
 * The authority classifies the action itself. A caller may only ask for
 * more, never for less: nothing may call a click an observation, and
 * nothing may call a field read a harmless one.
 */
function effectiveKind(action, supplied) {
  const derived = classifyAction(action);
  return kindRank(supplied) > kindRank(derived) ? supplied : derived;
}

/**
 * A fresh, unpredictable id.
 *
 * Nothing the caller can see goes into it, so an id cannot be guessed by
 * knowing the action or the session it belongs to.
 */
function newId(prefix) {
  const source = globalThis.crypto;
  let raw;
  if (typeof source?.randomUUID === 'function') {
    raw = source.randomUUID();
  } else if (typeof source?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    raw = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    throw new Error('no random source is available for a request id');
  }
  return `${prefix}-${raw}`;
}

/**
 * A copy of plain JSON metadata.
 *
 * The copy is what gets approved, so a caller that keeps using its own
 * object cannot change what the user said yes to.
 *
 * Only plain JSON is accepted. A Map, a Set, a Date, a class instance, a
 * value that refers to itself — none of them is something a tool can send,
 * and a copy of them could not be compared faithfully, so they are refused
 * instead of being copied into something that two different values look
 * alike.
 *
 * A key named `__proto__` stays what it is: data. It is copied as an own
 * property, so it never reaches the prototype of the copy.
 */
function cloneJson(value, path = 'metadata', ancestors = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`the ${path} must be a finite number`);
    return value;
  }
  if (type !== 'object') {
    throw new TypeError(`the ${path} must be plain JSON, not ${type}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`the ${path} must not refer to itself`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`the ${path}[${index}] must not be a hole`);
        copy.push(cloneJson(value[index], `${path}[${index}]`, ancestors));
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`the ${path} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new TypeError(`the ${path} must not carry a symbol`);
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) {
      throw new TypeError(`the ${path} must only carry plain data`);
    }
    const copy = prototype === null ? Object.create(null) : {};
    for (const key of keys) {
      // defineProperty, not assignment: a key named `__proto__` is data and
      // must not become the prototype of the copy.
      Object.defineProperty(copy, key, {
        value: cloneJson(value[key], `${path}.${key}`, ancestors),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/** Whether two plain values are the same value, deeply. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameValue(a[key], b[key])) return false;
  }
  return true;
}

/** Freezes a value and everything inside it. */
function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

/**
 * The authority of one session: its access mode, the revision of that mode,
 * and the approvals waiting for an answer.
 *
 * The revision moves whenever the mode moves. An approval belongs to the
 * revision it was asked under, so an answer that arrives after the mode
 * changed is stale and grants nothing.
 */
export class AccessAuthority {
  /** The session this authority speaks for. Bound once, never changed. */
  #sessionId;

  /** The mode in force. */
  #mode = ASK_FIRST;

  /** The revision of the mode. It only ever grows. */
  #revision = 1;

  /**
   * How many times the work was cancelled.
   *
   * An authorization that is waiting for the user holds the generation it
   * started in: a stop that arrives while it waits must not be able to hand
   * out a permit afterwards.
   */
  #generation = 0;

  /** The approvals waiting for an answer: id -> { request, settle, detach }. */
  #pending = new Map();

  /** The permits handed out: id -> record. Only this map makes one real. */
  #permits = new Map();

  /** Told about every mode change. */
  #onChange;

  /** Told about every question that is asked. */
  #onRequest;

  /**
   * `sessionId` is required: an authority without a session has nothing to
   * bind an approval to, and a missing session must never be able to answer
   * a question.
   */
  constructor({ sessionId, onChange = () => {}, onRequest = () => {} } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('AccessAuthority needs the session it belongs to');
    }
    this.#sessionId = sessionId;
    this.#onChange = typeof onChange === 'function' ? onChange : () => {};
    this.#onRequest = typeof onRequest === 'function' ? onRequest : () => {};
  }

  /** The session this authority speaks for. */
  get sessionId() {
    return this.#sessionId;
  }

  /** The mode in force. */
  get mode() {
    return this.#mode;
  }

  /** The revision of the mode. */
  get revision() {
    return this.#revision;
  }

  /** How many questions are waiting for an answer. */
  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * What the UI shows and what the tools ask about: the mode, its revision
   * and the session they belong to.
   *
   * The result is a fresh, frozen snapshot. Changing it changes nothing.
   */
  state() {
    return Object.freeze({
      sessionId: this.#sessionId,
      mode: this.#mode,
      revision: this.#revision,
    });
  }

  /**
   * Raises or lowers the mode.
   *
   * Full access needs three things at once: a request from our own UI
   * (`trusted`), the acknowledgment of the warning the user read
   * (`acknowledged`), and the revision the caller last saw
   * (`expectedRevision`). Anything else — a mode in a message, a page that
   * asks for it, a saved setting — leaves the mode where it is. Lowering to
   * Ask first is always allowed: it only takes authority away.
   */
  setMode(next, { trusted = false, acknowledged = false, expectedRevision = null } = {}) {
    if (next !== ASK_FIRST && next !== FULL_ACCESS) {
      return { ok: false, changed: false, reason: 'invalid-mode', ...this.state() };
    }
    if (next === FULL_ACCESS) {
      if (trusted !== true || acknowledged !== true) {
        return { ok: false, changed: false, reason: 'not-acknowledged', ...this.state() };
      }
      if (typeof expectedRevision !== 'number' || expectedRevision !== this.#revision) {
        return { ok: false, changed: false, reason: 'stale-revision', ...this.state() };
      }
    }
    if (next === this.#mode) {
      return { ok: true, changed: false, ...this.state() };
    }
    this.#mode = next;
    this.#revision += 1;
    this.#generation += 1;
    // The approvals and the permits of the old mode do not survive it.
    this.cancelPending('mode-changed');
    this.revokePermits('mode-changed');
    const state = this.state();
    this.#notify(state);
    return { ok: true, changed: true, ...state };
  }

  /**
   * Puts the session back to Ask first, whatever it was.
   *
   * The internal reset of the worker: it needs no warning to be
   * acknowledged, because it only ever takes authority away. It always moves
   * the revision on, so anything that was allowed under the old mode stops
   * being allowed.
   */
  reset(reason = 'reset') {
    const changed = this.#mode !== ASK_FIRST;
    this.#mode = ASK_FIRST;
    this.#revision += 1;
    this.#generation += 1;
    this.cancelPending(reason);
    this.revokePermits(reason);
    const state = this.state();
    this.#notify(state);
    return { ok: true, changed, ...state };
  }

  /**
   * Asks the user to allow one action. The request binds the session, the
   * policy revision and the action itself, so an answer that arrives late,
   * for another session or for another action cannot be used.
   *
   * The arguments and the target are copied, so the caller cannot change
   * what was asked about after the question was asked.
   */
  requestApproval({
    action,
    args = null,
    tabId = null,
    target = null,
    describe = null,
    kind = null,
    signal = null,
  } = {}) {
    const id = newId('req');
    const request = Object.freeze({
      id,
      sessionId: this.#sessionId,
      revision: this.#revision,
      mode: this.#mode,
      action: typeof action === 'string' ? action : '',
      kind: effectiveKind(action, kind),
      args: deepFreeze(cloneJson(args)),
      tabId: tabId ?? null,
      target: deepFreeze(cloneJson(target)),
      describe: typeof describe === 'string' ? describe : null,
    });
    let settle = () => {};
    const promise = new Promise((resolve) => { settle = resolve; });
    const entry = { request, settle, detach: null };
    if (signal?.aborted) {
      // The work is already over: the question is answered before it is asked.
      settle({ approved: false, reason: 'aborted', request });
      return { id, request, promise };
    }
    this.#pending.set(id, entry);
    if (signal) {
      const onAbort = () => this.#withdraw(id, 'aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detach = () => signal.removeEventListener('abort', onAbort);
    }
    try {
      this.#onRequest(request);
    } catch {
      // A panel that cannot show the question must not break the authority.
    }
    return { id, request, promise };
  }

  /**
   * The answer to one question.
   *
   * Only a live id, the exact session, the exact revision and a real
   * allow/deny are accepted, and only the first answer counts: a second one
   * finds nothing left to answer. A refused answer leaves the question
   * waiting, so a wrong message cannot consume the user's decision.
   */
  respondApproval({ id, decision, revision = null, sessionId = null } = {}) {
    const entry = typeof id === 'string' ? this.#pending.get(id) : undefined;
    if (!entry) return { ok: false, reason: 'unknown-request' };
    if (typeof sessionId !== 'string' || sessionId !== this.#sessionId) {
      return { ok: false, reason: 'wrong-session' };
    }
    if (typeof revision !== 'number' || revision !== entry.request.revision) {
      return { ok: false, reason: 'stale-revision' };
    }
    if (decision !== ALLOW && decision !== DENY) {
      return { ok: false, reason: 'malformed-decision' };
    }
    this.#pending.delete(id);
    if (entry.detach) entry.detach();
    entry.settle({
      approved: decision === ALLOW,
      reason: decision === ALLOW ? 'allowed' : 'denied',
      request: entry.request,
    });
    return { ok: true };
  }

  /** Withdraws every waiting question: a stop, a mode change or a lost panel. */
  cancelPending(reason = 'cancelled') {
    if (!this.#pending.size) return 0;
    const entries = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const entry of entries) {
      if (entry.detach) entry.detach();
      entry.settle({ approved: false, reason, request: entry.request });
    }
    return entries.length;
  }

  /**
   * Withdraws every permit that was handed out.
   *
   * The records are released, not just marked: a long session must not keep
   * the arguments and secrets of every action it ever allowed. Their abort
   * listeners go with them.
   */
  revokePermits(reason = 'revoked') {
    const records = Array.from(this.#permits.values());
    this.#permits.clear();
    for (const record of records) {
      if (record.detach) record.detach();
      record.revoked = true;
      record.reason = reason;
    }
    return records.length;
  }

  /**
   * A stop or an abort: nothing waits for an answer, nothing that was
   * allowed may run any more, and nothing that is on its way to an answer
   * may still be allowed afterwards.
   *
   * The mode stays as it is: a stop takes authority away for now, and the
   * session may go on with the mode it had.
   */
  cancel(reason = 'cancelled') {
    this.#generation += 1;
    return {
      pending: this.cancelPending(reason),
      permits: this.revokePermits(reason),
    };
  }

  /** The run is over: no question waits and no permit survives it. */
  finish(reason = 'finished') {
    return this.cancel(reason);
  }

  /**
   * The one call an executor makes.
   *
   * An observation, and every supported action under Full access, is allowed
   * right away. An interaction or a sensitive read under Ask first waits for
   * the user, and is allowed only if the user said yes to that very action.
   *
   * The command's signal is honoured in every mode: a command that was
   * aborted gets no permit, and a permit that was already issued is
   * withdrawn when the command is aborted afterwards.
   *
   * Resolves to `{ permit, reason, source }`: a permit to act on, or nothing
   * and the reason why.
   */
  async authorize(operation = {}, { signal = null } = {}) {
    const op = this.#capture(operation);
    if (!op.action) return { permit: null, reason: 'unknown-action', source: null };
    if (signal?.aborted) return { permit: null, reason: 'aborted', source: null };
    const generation = this.#generation;
    if (op.kind === OBSERVE) {
      return { permit: this.#issuePermit(op, 'observation', signal), reason: null, source: 'observation' };
    }
    if (this.#mode === FULL_ACCESS) {
      return { permit: this.#issuePermit(op, 'full-access', signal), reason: null, source: 'full-access' };
    }
    const { promise } = this.requestApproval({
      action: op.action,
      kind: op.kind,
      args: op.args,
      tabId: op.tabId,
      target: op.target,
      describe: op.describe,
      signal,
    });
    const answer = await promise;
    if (!answer.approved) return { permit: null, reason: answer.reason ?? 'denied', source: null };
    // The work was stopped while the user was answering: the answer is too
    // late to allow anything.
    if (generation !== this.#generation) return { permit: null, reason: 'cancelled', source: null };
    if (answer.request.revision !== this.#revision) {
      return { permit: null, reason: 'stale-revision', source: null };
    }
    if (signal?.aborted) return { permit: null, reason: 'aborted', source: null };
    return { permit: this.#issuePermit(op, 'user-approval', signal), reason: null, source: 'user-approval' };
  }

  /**
   * Whether a grant may be used.
   *
   * Only a permit this authority actually issued is valid: the object is
   * checked against the permits it holds, not against the session and the
   * revision it carries, which anyone can write down. A permit is bound to
   * its own operation, so it cannot be spent on another action, another
   * argument or another tab, and it stops being valid as soon as the mode
   * moves, the run is cancelled, the command is aborted or the run ends.
   */
  grantValid(grant, operation = null) {
    if (!grant || typeof grant !== 'object') return false;
    const id = grant.id;
    if (typeof id !== 'string') return false;
    const record = this.#permits.get(id);
    if (!record) return false;
    if (record.revoked) return false;
    if (record.sessionId !== this.#sessionId) return false;
    if (record.revision !== this.#revision) return false;
    if (grant.sessionId !== record.sessionId) return false;
    if (grant.revision !== record.revision) return false;
    if (operation !== null && operation !== undefined) {
      let op;
      try {
        op = this.#capture(operation);
      } catch {
        // Metadata the authority cannot bind cannot be a valid grant either.
        return false;
      }
      if (!this.#matches(record, op)) return false;
    }
    return true;
  }

  /** The operation as it is recorded: copied, classified and normalized. */
  #capture(operation = {}) {
    const action = typeof operation?.action === 'string' ? operation.action : '';
    const tabId = operation?.tabId ?? null;
    if (tabId !== null && typeof tabId !== 'number' && typeof tabId !== 'string') {
      throw new TypeError('the tab of an operation must be a number or a string');
    }
    return {
      action,
      kind: effectiveKind(action, operation?.kind),
      args: cloneJson(operation?.args ?? null),
      tabId,
      target: cloneJson(operation?.target ?? null),
      describe: typeof operation?.describe === 'string' ? operation.describe : null,
    };
  }

  /** Whether an operation is the one a permit was issued for. */
  #matches(record, op) {
    if (op.action !== record.action) return false;
    if (op.kind !== record.kind) return false;
    if (op.tabId !== record.tabId) return false;
    if (!sameValue(op.target, record.target)) return false;
    if (!sameValue(op.args, record.args)) return false;
    return true;
  }

  /** Records a permit and hands out a copy of it. */
  #issuePermit(operation, source, signal = null) {
    const id = newId('permit');
    const record = {
      id,
      sessionId: this.#sessionId,
      revision: this.#revision,
      action: operation.action,
      kind: operation.kind,
      args: deepFreeze(cloneJson(operation.args)),
      tabId: operation.tabId ?? null,
      target: deepFreeze(cloneJson(operation.target)),
      source,
      revoked: false,
      reason: null,
      detach: null,
    };
    this.#permits.set(id, record);
    if (signal) {
      // The permit belongs to the command that asked for it: an aborted
      // command may not act on it.
      const onAbort = () => this.#revokePermit(id, 'aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      record.detach = () => signal.removeEventListener('abort', onAbort);
    }
    return Object.freeze({
      id: record.id,
      sessionId: record.sessionId,
      revision: record.revision,
      action: record.action,
      kind: record.kind,
      args: record.args,
      tabId: record.tabId,
      target: record.target,
      source,
      approved: true,
    });
  }

  /** Withdraws one permit and lets go of what it held. */
  #revokePermit(id, reason = 'revoked') {
    const record = this.#permits.get(id);
    if (!record) return false;
    this.#permits.delete(id);
    if (record.detach) record.detach();
    record.revoked = true;
    record.reason = reason;
    return true;
  }

  /** Withdraws one question without touching the others. */
  #withdraw(id, reason) {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    this.#pending.delete(id);
    if (entry.detach) entry.detach();
    entry.settle({ approved: false, reason, request: entry.request });
    return true;
  }

  /** Tells the UI about a mode change, without letting it break the mode. */
  #notify(state) {
    try {
      this.#onChange(state);
    } catch {
      // The panel's problem is not the mode's problem.
    }
  }
}
