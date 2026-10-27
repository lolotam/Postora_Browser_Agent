// The panel side of one dedicated approval: Allow once, or Deny.
//
// This is not the access mode (that lives in `access.js`) and it is not a
// generic question to the user. It is one named action that the worker wants
// to run, and the user answers it once, with one of two buttons.
//
// The worker is the only authority. This module never decides that an action
// may run, never holds a permission of its own, and never keeps a decision
// for later: it draws what the worker asked for, and it removes a card only
// when the worker says the request is settled or when the worker replays the
// list of the requests that are still live.
//
// Every card is bound to the request it came from:
//
//   - the id, the chat and the policy revision are the ones the request was
//     made with, never the ones that happen to be current when the button is
//     pressed;
//   - the connection is the one that delivered the request, compared by
//     identity, so a card from a worker that is gone cannot be answered;
//   - the answer is sent with the chat and the connection it belongs to, so
//     the parent can check them again after it has picked a session.
//
// Nothing here reads or writes the composer, the files, the history or the
// settings. The module draws in the container it is given and sends one
// message; the words come from the translator it is given.
//
// The focus is never taken. A request that arrives while the user is writing
// must not swallow the Enter that was meant for the draft, and the Allow
// button must never be one Enter away by accident. The card is announced
// instead (the parent gives the container a live region), and the user goes
// to it when they are ready.
//
// The words it asks for, so both languages can be written once:
//
//   access.approval.title      the heading of the card
//   access.approval.action     {action}  the tool that wants to run
//   access.approval.site       {origin}  the site the action is about
//   access.approval.target     {label}   what the action is about to touch
//   access.approval.terminal   that this action may type into a web terminal
//   access.approval.allow      the button that allows this one action
//   access.approval.deny       the button that refuses it
//   access.approval.waiting    the status while the answer is not given yet
//   access.approval.answering  the status while the answer is on its way
//   access.approval.sendError  the answer did not reach the worker

export const REQUEST_EVENT = 'access-request';
export const SETTLED_EVENT = 'access-request-settled';
export const APPROVAL_RESPONSE = 'access-approval';

/** How much of the worker's text is drawn. A long value is still a value. */
const MAX_ACTION = 64;
const MAX_FIELD = 300;

/** The actions that can type into a terminal that runs inside a web page. */
const TERMINAL_ACTIONS = new Set(['insert_text', 'press_key', 'type_text']);

/**
 * The panel helper for dedicated approvals.
 *
 * The panel hands it everything it needs — where to draw, how to say things,
 * which chat is on screen, which connection is live, which policy revision is
 * in force and how to send a message — and it decides nothing by itself.
 */
export function createPermissionUi({ container, t, getSessionId, getConnection, getRevision, send } = {}) {
  const doc = container?.ownerDocument ?? null;
  let translator = typeof t === 'function' ? t : (key) => key;
  const sessionGetter = typeof getSessionId === 'function' ? getSessionId : null;
  const connectionGetter = typeof getConnection === 'function' ? getConnection : null;
  const revisionGetter = typeof getRevision === 'function' ? getRevision : null;
  const sender = typeof send === 'function' ? send : null;

  /** The live requests, by id. */
  const records = new Map();
  /** A number for the heading ids, so two cards never share one. */
  let sequence = 0;

  /** The chat that is on screen now, or nothing. */
  function currentSession() {
    if (!sessionGetter) return null;
    const value = sessionGetter();
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /** The policy revision in force now, or nothing. */
  function currentRevision() {
    if (!revisionGetter) return null;
    const value = revisionGetter();
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /** The connection that is live now, or nothing. */
  function currentConnection() {
    if (!connectionGetter) return null;
    const value = connectionGetter();
    return value === null || value === undefined ? null : value;
  }

  /** The text of a field, cut to a length that can be drawn. */
  function clip(text, max) {
    if (typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) : text;
  }

  /**
   * The request as this module understands it, or nothing.
   *
   * Only the fields the worker publishes are read: the id, the chat, the
   * revision, the action, and the safe description of the action. Anything
   * else in the message is not drawn, not kept and not answered.
   */
  function readRequest(value) {
    if (!value || typeof value !== 'object') return null;
    let raw = value;
    if (typeof value.type === 'string') {
      if (value.type !== REQUEST_EVENT) return null;
      raw = value.request;
    }
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id.trim() === '') return null;
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
    if (sessionId.trim() === '') return null;
    const revision = raw.revision;
    if (!Number.isInteger(revision) || revision <= 0) return null;
    if (typeof raw.action !== 'string') return null;
    return {
      id,
      sessionId,
      revision,
      action: raw.action,
      kind: typeof raw.kind === 'string' ? raw.kind : '',
      origin: typeof raw.origin === 'string' ? raw.origin : '',
      label: typeof raw.label === 'string' ? raw.label : '',
    };
  }

  /** Whether the record still belongs to the chat, the revision and the wire it came on. */
  function contextLive(record) {
    if (!record) return false;
    const session = currentSession();
    if (!session || session !== record.sessionId) return false;
    const revision = currentRevision();
    if (!revision || revision !== record.revision) return false;
    const connection = currentConnection();
    if (!connection || connection !== record.port) return false;
    return true;
  }

  /** Whether the card is still in the container it was drawn in. */
  function attached(record) {
    return Boolean(record?.node?.card?.parentNode === container);
  }

  /** The card of one request: a group with a heading, a status and two buttons. */
  function buildCard(record) {
    const card = doc.createElement('div');
    card.className = 'permission-request';
    card.setAttribute('role', 'group');
    const headingId = `permission-title-${sequence += 1}`;
    card.setAttribute('aria-labelledby', headingId);

    const title = doc.createElement('h3');
    title.className = 'permission-title';
    title.id = headingId;

    const action = doc.createElement('p');
    action.className = 'permission-action';

    const site = doc.createElement('p');
    site.className = 'permission-site';

    const target = doc.createElement('p');
    target.className = 'permission-target';

    const terminal = doc.createElement('p');
    terminal.className = 'permission-terminal';

    const actions = doc.createElement('div');
    actions.className = 'permission-actions';

    const allow = doc.createElement('button');
    allow.type = 'button';
    allow.className = 'primary permission-allow';

    const deny = doc.createElement('button');
    deny.type = 'button';
    deny.className = 'ghost permission-deny';

    const status = doc.createElement('p');
    status.className = 'permission-status';
    status.setAttribute('role', 'status');

    const error = doc.createElement('p');
    error.className = 'permission-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    actions.append(allow, deny);
    card.append(title, action, site, target, terminal, actions, status, error);

    record.node = { card, title, action, site, target, terminal, allow, deny, status, error };
    allow.addEventListener('click', () => { respond(record, 'allow'); });
    deny.addEventListener('click', () => { respond(record, 'deny'); });
    return record;
  }

  /** The words of a card, in the language of the panel. */
  function paint(record) {
    const node = record.node;
    node.title.textContent = translator('access.approval.title');
    node.action.textContent = translator('access.approval.action', { action: clip(record.action, MAX_ACTION) });
    node.action.hidden = !record.action;
    node.site.textContent = translator('access.approval.site', { origin: clip(record.origin, MAX_FIELD) });
    node.site.hidden = !record.origin;
    node.target.textContent = translator('access.approval.target', { label: clip(record.label, MAX_FIELD) });
    node.target.hidden = !record.label;
    node.terminal.textContent = translator('access.approval.terminal');
    node.terminal.hidden = !TERMINAL_ACTIONS.has(record.action);
    node.allow.textContent = translator('access.approval.allow');
    node.deny.textContent = translator('access.approval.deny');
    node.status.textContent = translator(record.sending ? 'access.approval.answering' : 'access.approval.waiting');
    node.error.textContent = record.errorKey ? translator(record.errorKey) : '';
    node.error.hidden = !record.errorKey;
  }

  /** The buttons answer only while the request can still be answered. */
  function syncButtons(record) {
    const blocked = record.sending || !contextLive(record);
    record.node.allow.disabled = blocked;
    record.node.deny.disabled = blocked;
  }

  /**
   * Every card is looked at again.
   *
   * The chat, the revision and the connection can move under a card without
   * saying anything to it. When something does come, the cards that no longer
   * belong to the context that is live now are shown as closed.
   */
  function refreshStates() {
    for (const record of records.values()) syncButtons(record);
  }

  /** A new record for a request the worker made. */
  function makeRecord(request, port) {
    const record = {
      id: request.id,
      sessionId: request.sessionId,
      revision: request.revision,
      action: request.action,
      kind: request.kind,
      origin: request.origin,
      label: request.label,
      port,
      sending: false,
      errorKey: null,
      node: null,
    };
    buildCard(record);
    return record;
  }

  /** The card goes away with the request it was drawn for. */
  function removeCard(record) {
    const card = record?.node?.card;
    if (!card) return;
    card.parentNode?.removeChild(card);
  }

  /**
   * The user answered. The answer is built from the request the card was
   * drawn for, and it is sent on the connection that delivered it.
   *
   * Nothing is marked as allowed and nothing is removed here: the worker
   * settles the request, and only then the card goes away.
   */
  function respond(record, decision) {
    if (!record || record.sending) return false;
    if (records.get(record.id) !== record) return false;
    if (!attached(record)) return false;
    if (!contextLive(record)) {
      // The chat, the revision or the worker moved on: this card is about a
      // context that is gone, and it answers nothing.
      refreshStates();
      return false;
    }
    record.sending = true;
    record.errorKey = null;
    syncButtons(record);
    paint(record);
    const message = Object.freeze({
      type: APPROVAL_RESPONSE,
      id: record.id,
      sessionId: record.sessionId,
      revision: record.revision,
      decision,
    });
    const port = record.port;
    let result;
    try {
      result = sender
        ? sender(message, { expectedSessionId: record.sessionId, expectedPort: port })
        : false;
    } catch {
      failSend(record);
      return false;
    }
    if (result && typeof result.then === 'function') {
      result.then((ok) => { if (ok === false) failSend(record); }, () => failSend(record));
    } else if (result === false) {
      failSend(record);
    }
    return true;
  }

  /**
   * The answer did not go out.
   *
   * A failure that arrives after the request was settled, replaced or reset
   * changes nothing: it does not bring the card back and it does not touch
   * another request that is still live.
   */
  function failSend(record) {
    if (!record) return;
    if (records.get(record.id) !== record) return;
    record.sending = false;
    record.errorKey = 'access.approval.sendError';
    paint(record);
    syncButtons(record);
  }

  /**
   * The worker asked for one action to be allowed or denied.
   *
   * A request for another chat, for another revision, or one that arrives on
   * no live connection is not drawn at all.
   *
   * An id is one request in the panel's world. The card for an id is drawn
   * once and keeps the request it was drawn for: a repeat of it does not make
   * a second card, does not change what the card says, and does not touch an
   * answer that is already on its way. An id that comes back with something
   * else in it is not a new grant, so it is not adopted either.
   */
  function apply(value) {
    const request = readRequest(value);
    if (!request) return false;
    const session = currentSession();
    const revision = currentRevision();
    const connection = currentConnection();
    if (!session || !revision || !connection) return false;
    if (request.sessionId !== session) return false;
    if (request.revision !== revision) return false;
    if (records.has(request.id)) return false;
    const record = makeRecord(request, connection);
    records.set(record.id, record);
    container.appendChild(record.node.card);
    paint(record);
    refreshStates();
    // The focus is not taken. A request that arrives while the user is
    // writing must not swallow the Enter that was meant for the draft, and
    // the answer that is one keypress away must not be one Enter away by
    // accident. The card is announced instead, and the user goes to it.
    return true;
  }

  /**
   * The worker says which requests are still live.
   *
   * The list is the authority about what is live now:
   *
   *   - a request that is not for the chat that is on screen, or not for the
   *     revision in force, is not drawn;
   *   - a request whose id is not in the list is gone;
   *   - a card that is not for the chat or the revision in force any more is
   *     gone too, whatever the list says about its id;
   *   - a request whose id is already on screen keeps the card it has, and
   *     the answer that is already on its way is not touched by a repeat of
   *     it. An id that comes back with something else in it is not adopted:
   *     an id is one request, and it is not a new grant.
   *
   * A card keeps the connection that delivered its request, even when the
   * worker that is here now is another one. The panel never refills a card
   * with the connection that happens to be live now: a request of an old
   * context cannot be answered, and the panel starts over instead. It clears
   * its cards when the worker is gone, and the worker says what is live
   * again when it comes back.
   */
  function replay(list) {
    const items = Array.isArray(list)
      ? list
      : Array.isArray(list?.permissions) ? list.permissions : [];
    const session = currentSession();
    const revision = currentRevision();
    const connection = currentConnection();
    const mentioned = new Set();
    const current = new Map();
    for (const item of items) {
      const request = readRequest(item);
      if (!request) continue;
      mentioned.add(request.id);
      if (!session || !revision || !connection) continue;
      if (request.sessionId !== session) continue;
      if (request.revision !== revision) continue;
      if (current.has(request.id)) continue;
      current.set(request.id, request);
    }
    for (const [id, record] of [...records]) {
      const live = record.sessionId === session && record.revision === revision;
      if (mentioned.has(id) && live) continue;
      records.delete(id);
      removeCard(record);
    }
    for (const [id, request] of current) {
      // The same id again: the card stays as it is, and an answer that is
      // already on its way is not woken up by a repeat of it.
      if (records.has(id)) continue;
      const record = makeRecord(request, connection);
      records.set(record.id, record);
      container.appendChild(record.node.card);
      paint(record);
    }
    refreshStates();
    return records.size;
  }

  /**
   * The worker says the request is settled.
   *
   * Only the exact request is settled: the same id, the same chat, the same
   * revision, on the connection that is live now. An unknown, a repeated or
   * a stale settlement removes nothing.
   */
  function settle(event) {
    if (!event || typeof event !== 'object') return false;
    if (typeof event.type === 'string' && event.type !== SETTLED_EVENT) return false;
    const id = typeof event.id === 'string' ? event.id : '';
    if (id.trim() === '') return false;
    const record = records.get(id);
    if (!record) return false;
    if (typeof event.sessionId !== 'string' || event.sessionId !== record.sessionId) return false;
    if (!Number.isInteger(event.revision) || event.revision !== record.revision) return false;
    const connection = currentConnection();
    if (!connection || connection !== record.port) return false;
    records.delete(id);
    removeCard(record);
    return true;
  }

  /** The worker is gone, or the chat changed: every card goes with it. */
  function reset() {
    for (const record of [...records.values()]) removeCard(record);
    records.clear();
  }

  /**
   * The panel changed language: the words change, the requests do not.
   *
   * No card is built again and no answer that is on its way is woken up.
   */
  function updateLanguage(next) {
    if (typeof next === 'function') translator = next;
    for (const record of records.values()) paint(record);
    return records.size;
  }

  return {
    apply,
    settle,
    replay,
    reset,
    updateLanguage,
    /** The live requests, as plain data, for the panel and for the tests. */
    get requests() {
      return [...records.values()].map((record) => ({
        id: record.id,
        sessionId: record.sessionId,
        revision: record.revision,
        action: record.action,
        kind: record.kind,
        origin: record.origin,
        label: record.label,
        sending: record.sending,
        errorKey: record.errorKey,
      }));
    },
    /** How many requests are waiting for an answer. */
    get count() {
      return records.size;
    },
  };
}
