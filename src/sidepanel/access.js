// The chat access-mode control.
//
// One selection, near the composer: Ask first or Full access. The panel never
// decides the mode itself — it asks the worker and shows what the worker
// confirms, so a mode that was never confirmed never appears as Full access.
//
// The warning is the user's explicit acknowledgment: Full access is only
// asked for after the user read it and confirmed it — for one chat, read
// against one policy revision. A warning that was opened for another chat, or
// before the policy moved on, sends nothing at all; it is never quietly
// rebuilt for the chat that is selected later.

import { ASK_FIRST, FULL_ACCESS } from '../permissions/policy.js';

export const ACCESS_CHANGE = 'access-mode';

/** The modes the worker can confirm. Anything else is not a mode at all. */
const MODES = [ASK_FIRST, FULL_ACCESS];

/**
 * What the control shows for the mode the worker confirmed. `risk` is the
 * hover/accessible description of what Full access allows; it is empty in
 * Ask first. The visible Full access label and consent remain explicit.
 *
 * A mode the panel does not know is not shown as Ask first either: the view
 * is empty, so an unknown mode is never an automatic downgrade.
 */
export function accessView(state, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const mode = state?.mode ?? ASK_FIRST;
  if (!MODES.includes(mode)) return null;
  const full = mode === FULL_ACCESS;
  const revision = Number.isInteger(state?.revision) && state.revision > 0 ? state.revision : 0;
  const sessionId = typeof state?.sessionId === 'string' && state.sessionId !== '' ? state.sessionId : null;
  const view = {
    sessionId,
    mode,
    revision,
    selectValue: mode,
    label: translate(full ? 'access.full' : 'access.askFirst'),
    status: translate(full ? 'access.state.full' : 'access.state.askFirst'),
    risk: full ? translate('access.state.fullRisk') : '',
  };
  return view;
}

/**
 * The message the panel sends for a choice.
 *
 * Full access needs the warning acknowledged and says which chat and which
 * policy revision it is about, so the worker can refuse a request that was
 * made for another chat or against a policy that has moved on. Without that
 * metadata the request is not an elevation at all: the message is nothing.
 *
 * Asking first is always allowed: it only takes authority away.
 */
export function accessRequest(mode, { acknowledged = false, sessionId = null, expectedRevision = null, expectedProfileRevision = null } = {}) {
  if (!MODES.includes(mode)) return null;
  const chat = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : null;
  const revision = typeof expectedRevision === 'number' && Number.isFinite(expectedRevision) && expectedRevision > 0
    ? expectedRevision
    : null;
  if (mode === FULL_ACCESS) {
    if (acknowledged !== true) return null;
    if (!chat || !revision) return null;
  }
  const profileRevision = Number.isInteger(expectedProfileRevision) && expectedProfileRevision > 0 ? expectedProfileRevision : null;
  return {
    type: ACCESS_CHANGE,
    mode,
    acknowledged: mode === FULL_ACCESS,
    sessionId: chat,
    expectedRevision: revision,
    // The profile's own revision, when the worker told it: the worker refuses
    // a request that was made against a profile that has moved on.
    ...(profileRevision ? { expectedProfileRevision: profileRevision } : {}),
  };
}

/**
 * The remembered choice of the profile, as the worker told it, or nothing at
 * all when what arrived is not one. The panel never writes it.
 */
export function preferenceOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isInteger(value.profileRevision) || value.profileRevision <= 0) return null;
  if (typeof value.remember !== 'boolean') return null;
  return {
    remember: value.remember,
    mode: MODES.includes(value.mode) ? value.mode : ASK_FIRST,
    profileRevision: value.profileRevision,
    restoreFailed: value.restoreFailed === true,
    unpersisted: value.unpersisted === true,
  };
}

/** The words for a reason the worker gave for a refusal or a warning, or '' when the panel has none. */
export function preferenceNoticeKey(reason) {
  switch (reason) {
    case 'storage-failed': return 'access.notice.storageFailed';
    case 'not-cleared': return 'access.notice.notCleared';
    case 'not-remembered': return 'access.notice.notRemembered';
    case 'protection-unavailable': return 'access.notice.protectionUnavailable';
    case 'stale-profile-revision': return 'access.notice.stale';
    case 'needs-acknowledgement': return 'access.notice.needsAcknowledgement';
    default: return '';
  }
}

/**
 * Wires the control to the page.
 *
 * `elements` holds the pieces of the panel: the select, the state line, the
 * risk label, the voice-screen indicator, and the warning dialog with its
 * checkbox and buttons. `request` sends a message to the worker and returns
 * whether it went out. `getSessionId` tells the control which chat it is
 * about right now — it is asked every time, not once when the control is
 * built, because the chat can change under it.
 */
export function createAccessUi({ elements, t, request, getSessionId } = {}) {
  const { select, state, risk, voice, warning, acknowledge, acknowledgeText, scope, remember, confirm, cancel } = elements ?? {};
  let translator = typeof t === 'function' ? t : (key) => key;
  const sender = typeof request === 'function' ? request : null;
  const sessionGetter = typeof getSessionId === 'function' ? getSessionId : null;

  // What the worker confirmed for the chat this control is about. The panel
  // never writes here itself.
  let confirmedSession = null;
  let confirmedMode = ASK_FIRST;
  let confirmedRevision = 0;
  let connected = true;
  let pending = null; // an elevation that is on its way to the worker
  let lastFailure = null;
  // What the profile remembers, as the worker told it. It carries the revision
  // a request is bound to, so it is dropped with the connection.
  let preference = null;

  // The warning belongs to the chat and the revision it was opened for.
  // `purpose` is what the acknowledgment is for: Full access in this chat, or
  // remembering Full access that is already on (the "remember" switch).
  const warningState = { isOpen: false, sessionId: null, revision: 0, acknowledged: false, purpose: 'elevate', onConfirm: null };

  /** The worker's snapshot, or nothing at all when the state is not one. */
  function snapshotOf(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') return null;
    if (!MODES.includes(value.mode)) return null;
    if (!Number.isInteger(value.revision) || value.revision <= 0) return null;
    return { sessionId: value.sessionId, mode: value.mode, revision: value.revision };
  }

  /** The chat the control is about, as the panel sees it right now. */
  function currentSession() {
    if (!sessionGetter) return null;
    const value = sessionGetter();
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /** The chat the control is about; without a getter, the last confirmed one. */
  function boundSession() {
    if (sessionGetter) return currentSession();
    return confirmedSession;
  }

  /** The view of the mode the worker confirmed. */
  function view() {
    return accessView({ sessionId: confirmedSession, mode: confirmedMode, revision: confirmedRevision }, translator);
  }

  /** Draws the mode the worker confirmed. Nothing else may change it. */
  function render() {
    const confirmed = view();
    if (select) {
      select.value = confirmed.selectValue;
      select.title = confirmed.risk || confirmed.status;
      select.classList?.toggle('risk', confirmed.mode === FULL_ACCESS);
    }
    if (state) state.textContent = confirmed.status;
    if (risk) {
      risk.textContent = confirmed.risk;
      risk.hidden = !confirmed.risk;
    }
    if (voice) {
      voice.textContent = confirmed.label;
      voice.title = confirmed.status;
      voice.classList?.toggle('risk', confirmed.mode === FULL_ACCESS);
      voice.hidden = false;
    }
    return confirmed;
  }

  /** The control goes back to the confirmed mode: the worker decides, not the control. */
  function restore() {
    if (select) select.value = confirmedMode === FULL_ACCESS ? FULL_ACCESS : ASK_FIRST;
  }

  /** The warning is gone: nothing was sent, the confirmed mode stays. */
  function dismissWarning({ focus = true } = {}) {
    warningState.isOpen = false;
    warningState.acknowledged = false;
    warningState.purpose = 'elevate';
    warningState.onConfirm = null;
    if (acknowledge) acknowledge.checked = false;
    if (confirm) confirm.disabled = true;
    restore();
    warning?.close?.();
    if (focus) select?.focus?.();
  }

  /**
   * What the warning says about its reach. With "remember" on, Full access
   * also applies to new chats and survives a restart; with it off, it is for
   * this chat only. Local commands ask in both cases.
   */
  function renderScope(remembered) {
    if (scope) scope.textContent = translator(remembered ? 'access.warning.scopeRemembered' : 'access.warning.scopeChatOnly');
    if (acknowledgeText) acknowledgeText.textContent = translator(remembered ? 'access.warning.acknowledgeRemembered' : 'access.warning.acknowledge');
  }

  /** Whether Full access reaches new chats now: "remember" is on, or unknown. */
  function remembering() {
    return preference?.remember !== false;
  }

  /** The user picked Full access: the warning opens for this chat, right now. */
  function openWarning() {
    warningState.isOpen = true;
    warningState.purpose = 'elevate';
    warningState.onConfirm = null;
    warningState.sessionId = boundSession();
    warningState.revision = confirmedRevision;
    warningState.acknowledged = false;
    if (acknowledge) acknowledge.checked = false;
    if (confirm) confirm.disabled = true;
    renderScope(remembering());
    warning?.showModal?.();
  }

  /**
   * "Remember my choice" is turned on while Full access is on: the same
   * warning opens, and only an explicit acknowledgment lets `onConfirm` run.
   * Nothing is sent by the control itself.
   */
  function askRememberAcknowledgement(onConfirm) {
    if (typeof onConfirm !== 'function' || !connected) return false;
    warningState.isOpen = true;
    warningState.purpose = 'remember';
    warningState.onConfirm = onConfirm;
    warningState.sessionId = boundSession();
    warningState.revision = confirmedRevision;
    warningState.acknowledged = false;
    if (acknowledge) acknowledge.checked = false;
    if (confirm) confirm.disabled = true;
    renderScope(true);
    warning?.showModal?.();
    return true;
  }

  /** The send went nowhere: the control keeps the mode the worker confirmed. */
  function onSendFailed(failure) {
    lastFailure = failure ?? null;
    pending = null;
    restore();
  }

  /**
   * Sends a message and survives a worker that is not there. A rejected
   * request is a failed request, never an unhandled rejection and never a
   * badge the worker never confirmed.
   */
  function sendMessage(message) {
    if (!message || !sender) return false;
    let result;
    try {
      result = sender(message);
    } catch (failure) {
      onSendFailed(failure);
      return false;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        (ok) => { if (ok === false) onSendFailed(null); },
        (failure) => { onSendFailed(failure); },
      );
    } else if (result === false) {
      onSendFailed(null);
    }
    return true;
  }

  /** A choice in the control: Full access asks first, Ask first goes out at once. */
  function choose(value) {
    const wanted = value === FULL_ACCESS ? FULL_ACCESS : ASK_FIRST;
    restore();
    if (wanted === confirmedMode) return;
    if (wanted === FULL_ACCESS) {
      openWarning();
      return;
    }
    const message = accessRequest(ASK_FIRST, {
      sessionId: boundSession(),
      expectedRevision: confirmedRevision > 0 ? confirmedRevision : null,
      expectedProfileRevision: preference?.profileRevision ?? null,
    });
    if (message) sendMessage(message);
  }

  /**
   * The user confirmed the warning. It only counts when it is still the
   * warning this chat and this revision were asked for: a warning that was
   * opened for another chat, or before the policy moved on, sends nothing.
   */
  function confirmWarning() {
    if (!warningState.isOpen) { restore(); return; }
    if (!connected) { dismissWarning(); return; }
    if (warningState.acknowledged !== true) { dismissWarning(); return; }
    if (acknowledge && acknowledge.checked !== true) { dismissWarning(); return; }
    if (warningState.purpose === 'remember') {
      // The acknowledgment was read for turning "remember" on, in this chat
      // and under this policy: a chat or a policy that moved on is not it.
      const onConfirm = warningState.onConfirm;
      const chat = boundSession();
      if (!onConfirm || !chat || chat !== warningState.sessionId || warningState.revision !== confirmedRevision) { dismissWarning(); return; }
      warning?.close?.();
      dismissWarning({ focus: false });
      onConfirm();
      return;
    }
    const chat = boundSession();
    if (!chat || chat !== warningState.sessionId) { dismissWarning(); return; }
    if (confirmedSession !== null && confirmedSession !== warningState.sessionId) { dismissWarning(); return; }
    if (warningState.revision !== confirmedRevision || confirmedRevision <= 0) { dismissWarning(); return; }
    const message = accessRequest(FULL_ACCESS, {
      acknowledged: true,
      sessionId: warningState.sessionId,
      expectedRevision: warningState.revision,
      expectedProfileRevision: preference?.profileRevision ?? null,
    });
    if (!message) { dismissWarning(); return; }
    // The warning has done its work; the worker still has to confirm it.
    warningState.isOpen = false;
    warningState.acknowledged = false;
    if (acknowledge) acknowledge.checked = false;
    if (confirm) confirm.disabled = true;
    warning?.close?.();
    restore();
    select?.focus?.();
    pending = { mode: FULL_ACCESS, sessionId: warningState.sessionId, revision: warningState.revision };
    sendMessage(message);
  }

  /**
   * The worker said what the mode is. Anything that is not a snapshot for
   * this chat, or that is older than what the worker already said, is
   * ignored — the control never shows a mode the worker has not confirmed.
   */
  function apply(next) {
    const snapshot = snapshotOf(next);
    if (!snapshot) return view();
    // The profile's remembered choice rides on the worker's state for this chat.
    if (next.accessPreference !== undefined) applyPreference(next.accessPreference);
    const chat = currentSession();
    // No chat is selected: there is nothing this state could belong to.
    if (sessionGetter && !chat) return view();
    if (chat && snapshot.sessionId !== chat) return view(); // another chat's state
    if (confirmedSession !== null && confirmedSession !== snapshot.sessionId) {
      // The chat changed: what we knew belonged to the old chat.
      dismissWarning({ focus: false });
      confirmedMode = ASK_FIRST;
      confirmedRevision = 0;
      pending = null;
    }
    if (snapshot.revision <= confirmedRevision) {
      // The same state again, or an older one: nothing changes, and a warning
      // that is still current stays open.
      if (snapshot.revision === confirmedRevision && snapshot.mode === confirmedMode) render();
      return view();
    }
    confirmedSession = snapshot.sessionId;
    confirmedMode = snapshot.mode;
    confirmedRevision = snapshot.revision;
    pending = null;
    connected = true;
    // The policy the warning was read against is gone: the warning is
    // obsolete, and a confirmation of it would be a dead confirmation.
    dismissWarning({ focus: false });
    render();
    return view();
  }

  /** The worker told what the profile remembers: a newer revision replaces an older one. */
  function applyPreference(next) {
    const known = preferenceOf(next);
    if (!known) return preference;
    if (preference && known.profileRevision < preference.profileRevision) return preference;
    const rememberChanged = preference !== null && preference.remember !== known.remember;
    preference = known;
    // The switch shows what the worker confirmed, and nothing else.
    if (remember) remember.checked = known.remember;
    // The warning was read against the old setting of "remember".
    if (rememberChanged && warningState.isOpen && warningState.purpose === 'elevate') renderScope(remembering());
    return preference;
  }

  /**
   * The connection is gone. Everything the panel thought it knew is dropped:
   * the control goes back to Ask first and waits for the worker to replay the
   * state, and nothing is sent while it waits.
   */
  function reset() {
    connected = false;
    pending = null;
    preference = null;
    confirmedMode = ASK_FIRST;
    confirmedRevision = 0;
    dismissWarning({ focus: false });
    render();
    return view();
  }

  /**
   * The worker is back. The panel waits for the state it sends; it does not
   * send the elevation again, and it does not trust what it knew before.
   */
  function reconnect() {
    connected = true;
    dismissWarning({ focus: false });
    render();
    return view();
  }

  /** The panel changed language: the words change, the mode does not. */
  function updateLanguage(nextT) {
    if (typeof nextT === 'function') translator = nextT;
    if (warningState.isOpen) renderScope(warningState.purpose === 'remember' ? true : remembering());
    render();
    return view();
  }

  if (select) select.addEventListener('change', () => choose(select.value));
  if (acknowledge) {
    acknowledge.addEventListener('change', () => {
      const checked = acknowledge.checked === true;
      if (!warningState.isOpen) {
        // There is no warning to read: the box means nothing.
        warningState.acknowledged = false;
        acknowledge.checked = false;
        if (confirm) confirm.disabled = true;
        return;
      }
      warningState.acknowledged = checked;
      if (confirm) confirm.disabled = !checked;
    });
  }
  if (confirm) {
    confirm.addEventListener('click', () => {
      confirmWarning();
    });
  }
  if (cancel) cancel.addEventListener('click', () => dismissWarning());
  if (warning) {
    // Escape closes the warning: it is a refusal, not an elevation.
    warning.addEventListener('cancel', () => dismissWarning());
    // The browser may close the dialog on its own, later than we expect.
    warning.addEventListener('close', () => {
      if (!warningState.isOpen) return; // we closed it ourselves
      if (warning.open) return; // a newer warning is open now
      dismissWarning();
    });
  }

  render();

  return {
    apply,
    applyPreference,
    askRememberAcknowledgement,
    restore,
    render,
    updateLanguage,
    reset,
    reconnect,
    get confirmed() { return view(); },
    get pending() { return pending; },
    get preference() { return preference; },
    get connected() { return connected; },
    get lastFailure() { return lastFailure; },
  };
}
