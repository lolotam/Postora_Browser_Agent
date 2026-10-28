import { renderMarkdown, reportFileName } from './markdown.js';
import { MIC_PANEL, MIC_WINDOW, micListenTarget, speechLang, voiceErrorKey } from './voice.js';
import { currentLanguage, resolveLanguage, setLanguage, t } from './i18n.js';
import { createAccessUi } from './access.js';
import { createPermissionUi } from './permissions.js';
import { ASK_FIRST, FULL_ACCESS } from '../permissions/policy.js';
import { escapeAttr } from './model-picker.js';
import { createModelDialog } from './model-dialog.js';
import { createSettingsNav } from './settings-nav.js';
import { createSettingsSaver, settingsEdits } from './settings-save.js';
import { authMessage, authView, backupAuthView, changedProviders, withLoginEvent } from './auth-ui.js';
import { createKeyStore } from './key-store.js';
import { createProviderForm } from './provider-form.js';
import { request } from './request.js';
import { bindTestButton } from './test-button.js';
import { FEEDBACK_FORM_ID, afterDismissal, afterRating, sendFeedback, shouldAskForRating } from '../lib/feedback.js';
import { googleAccount, signInWithGoogle, signOutOfGoogle } from '../lib/google-account.js';
import { ACCOUNT_PROVIDERS, PROVIDER_LABELS, RECOMMENDED_SETUP, recommendedSlots, settingsProblem, slotSettings } from '../lib/settings.js';
import { STORE_BUILD } from '../lib/build.js';
import { packFiles } from '../lib/read-file.js';
import { FILE_LIMITS, readLocalFile } from './attach.js';
import { createFastAsk } from '../fast/clients.js';
import { approvalText as approvalMessage } from '../voice/voice-approval.js';
import { createVoiceController } from '../voice/voice-controller.js';
import { runFastCommand } from '../voice/voice-runner.js';
import { SECRET_TOKENS } from '../voice/voice-safety.js';
import { createChromeBrowser } from '../voice/voice-browser.js';

const $ = (id) => document.getElementById(id);

// The question that waits for an answer, and its number: a question that
// arrives while another one is being answered is a different question.
// `answering` is the number of the question whose answer is on its way: the
// question is answered once, and a second answer to it is refused.
const ui = { thread: null, pending: [], running: false, question: null, questionId: 0, answering: null, liveText: null, liveReasoning: null, trace: null, steps: new Map(), replayed: false, notices: [], stats: newStats() };
const MAX_NOTICES = 3;
let settings = null;
let presets = {};
let fastPresets = {};
let fastModels = [];
let fastFallbackModels = [];
// What each fast slot's list request is doing, so the shared model dialog can
// say "loading" or show the refusal instead of a silent empty list.
const fastListState = { fast: { loading: false, error: '' }, fastFallback: { loading: false, error: '' } };
const loads = { fast: 0, fastFallback: 0 }; // newest request wins when lists load concurrently
// The account providers: what the panel knows about each one's sign-in, the
// attempt it waits for, and the message its section shows.
const authState = { chatgpt: null, claude: null, grok: null };
const authAttempt = { chatgpt: null, claude: null, grok: null };
const authNote = { chatgpt: '', claude: '', grok: '' };

setLanguage(resolveLanguage('auto', chrome.i18n.getUILanguage()));

// ---------- chat ----------

// The panel shows one session; the port name tells the worker which.
// The worker can be stopped while the panel stays open, which closes the port,
// so it reconnects lazily on the next message instead of looping on restarts.
let port = null;
let sessionId = null;
let sessionList = [];
let sessionListRefresh = 0;
// The worker was gone and the panel is connected again: its sign-in state may
// have been lost with it.
let reconnected = false;

function connect() {
  // The port name carries the panel: the worker gives the tabs this panel
  // holds back when the port closes.
  const myPort = chrome.runtime.connect({ name: `panel:${sessionId}:${voicePanelId}` });
  const mySession = sessionId;
  port = myPort;
  // A new connection knows nothing yet: what the worker confirmed belonged to
  // the old one, and the new worker has to say what the mode is now.
  accessUi.reset();
  accessUi.reconnect();
  // The approvals of the old connection are gone with it: a card of a worker
  // that is not there any more answers nothing.
  resetApprovals();
  // Every listener keeps the port and the chat it was made for: a late message
  // or a late disconnect from a port that is gone changes nothing.
  myPort.onMessage.addListener((event) => {
    if (myPort !== port || mySession !== sessionId) return;
    onEvent(event);
  });
  // The worker is gone: the task it was running is gone with it.
  myPort.onDisconnect.addListener(() => {
    if (myPort !== port) return;
    port = null;
    reconnected = true;
    // The worker took its authority with it: nothing is confirmed any more,
    // and nothing is sent until a new worker says what the mode is.
    accessUi.reset();
    // The approvals go with it: the cards of a worker that is gone answer
    // nothing, and they are not on the screen either.
    resetApprovals();
    cancelVoiceTask(t('voice.cancelled'));
    // The claims of this panel are given back: the worker may be gone, and a
    // tab that nobody holds is free again.
    releaseVoiceClaims();
  });
  // The worker may have restarted and lost the sign-in it was in the middle of.
  if (reconnected) {
    reconnected = false;
    refreshAuthStates().catch(() => {});
  }
}

// Picking the session (as the panel opens, or after a tab switch) takes a round
// trip to the worker. A message sent meanwhile waits for it: sent at once, it would
// go to no session yet, or to the one the panel is leaving, and vanish from view.
let picking = null;

function pick(choose) {
  const run = choose().finally(() => {
    if (picking === run) picking = null;
  });
  picking = run;
  return run;
}

// ---------- access mode ----------

// The mode of this chat: Ask first or Full access. The panel never decides it:
// it asks the worker and shows what the worker confirmed, so a mode that was
// never confirmed never appears as Full access. The control is built once and
// asks which chat it is about every time, because the chat can change under it.
let accessErrorKey = '';

const accessUi = createAccessUi({
  elements: {
    select: $('accessSelect'),
    state: $('accessState'),
    risk: $('accessRisk'),
    voice: $('voiceAccess'),
    warning: $('accessWarning'),
    acknowledge: $('accessAcknowledge'),
    confirm: $('accessConfirm'),
    cancel: $('accessCancel'),
  },
  t,
  request: (message) => requestAccess(message),
  getSessionId: () => sessionId,
});

/**
 * The mode is a request to the worker, about the chat the message names.
 *
 * The chat is bound to the message: a chat that is chosen while the message is
 * on its way is not the chat the user agreed to, so the message goes nowhere
 * rather than to the wrong chat. The failure is shown where the mode is shown,
 * and it is raised again so the control keeps the mode the worker confirmed.
 */
async function requestAccess(message) {
  const expectedPort = port;
  try {
    await send(message, { expectedSessionId: message.sessionId, expectedPort });
    return true;
  } catch (err) {
    accessErrorKey = 'access.error.send';
    renderAccessError();
    throw err;
  }
}

/** The reason the last mode request did not go out, in the panel's language. */
function renderAccessError() {
  const node = $('accessError');
  if (!node) return;
  node.textContent = accessErrorKey ? t(accessErrorKey) : '';
  node.hidden = !accessErrorKey;
}

/**
 * The worker said what the mode is. The state is the worker's own, and it is
 * only read when it is about the chat the panel is on.
 */
function applyAccessState(state) {
  accessUi.apply(state);
  if (!state || state.sessionId !== sessionId) return;
  // The worker spoke about the mode: the panel is in step with it again.
  accessErrorKey = '';
  renderAccessError();
  handOverAccessIntent();
}

// The choice the user made while the worker was not there. It belongs to the
// chat it was made for, and it is only a choice: the control opens a new
// warning for it, and the warning is read before anything is asked for.
let accessIntent = null;
let accessIntentTimer = null;
let accessIntentRetried = false;
// The handover itself: the control is the one that acts on the choice.
let accessHandover = false;

/**
 * The choice of the access control, seen before the control sees it.
 *
 * The control needs the mode the worker confirmed: a choice that is made
 * while the worker is gone, or before it has said what the mode of this chat
 * is, cannot be bound to a chat and a policy revision. Such a choice waits:
 * the panel asks the worker again and hands the choice to the control when
 * the worker has said what the mode is. The control never shows a mode the
 * worker has not confirmed, and the warning it opens is always a new one.
 */
document.addEventListener('change', (event) => {
  if (event.target !== $('accessSelect')) return;
  if (accessHandover) return; // this change is the handover of a waiting choice
  const mode = event.target.value === FULL_ACCESS ? FULL_ACCESS : ASK_FIRST;
  if (accessUi.connected && accessUi.confirmed.revision > 0) return; // the control can act on it
  // The control must not act on a choice it cannot bind: the choice waits.
  event.stopPropagation();
  event.stopImmediatePropagation();
  accessIntent = { sessionId, mode };
  accessIntentRetried = false;
  accessUi.restore(); // the selection goes back to the mode the worker confirmed
  connectForAccess();
  waitForAccessState();
}, true);

/** The worker is asked again, and the panel waits for the state it sends. */
function connectForAccess() {
  if (port) return; // there is a connection, and its state is on its way
  try {
    connect();
  } catch (err) {
    accessErrorKey = 'access.error.connect';
    renderAccessError();
  }
}

/** The state the panel waits for did not come: the port may be gone. */
function accessIntentTimeout() {
  accessIntentTimer = null;
  if (!accessIntent) return;
  if (!accessIntentRetried) {
    // The port the panel had may be gone without the panel having been told:
    // the worker was stopped. A new one is opened for the chat that is on.
    accessIntentRetried = true;
    port?.disconnect();
    port = null;
    connectForAccess();
    waitForAccessState();
    return;
  }
  // The worker does not answer: the choice is dropped, and the panel says so
  // where the mode is shown. Nothing was asked for.
  clearAccessIntent();
  accessErrorKey = 'access.error.connect';
  renderAccessError();
}

/** How long the panel waits for the state of the worker it asked again. */
function waitForAccessState() {
  clearTimeout(accessIntentTimer);
  accessIntentTimer = setTimeout(accessIntentTimeout, 2500);
}

/** A choice that waits is dropped: the chat it was made for is gone. */
function clearAccessIntent() {
  accessIntent = null;
  accessIntentRetried = false;
  clearTimeout(accessIntentTimer);
  accessIntentTimer = null;
}

/**
 * The choice that waited is handed to the control: the worker has said what
 * the mode of this chat is, and the warning the control opens is a new one,
 * bound to that chat and that revision. Nothing is sent, and nothing is
 * remembered of an older choice.
 */
function handOverAccessIntent() {
  if (!accessIntent || accessIntent.sessionId !== sessionId) return;
  if (!accessUi.connected || accessUi.confirmed.revision <= 0) return;
  const mode = accessIntent.mode;
  clearAccessIntent();
  accessHandover = true;
  const select = $('accessSelect');
  select.value = mode;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  accessHandover = false;
}

async function send(message, { signal, expectedSessionId, expectedPort } = {}) {
  while (picking) await picking.catch(() => {});
  if (!sessionId) await showTabSession(); // the lookup on open failed; the message still needs a session
  signal?.throwIfAborted();
  if (expectedSessionId !== undefined && expectedSessionId !== sessionId) {
    throw new DOMException('Session changed', 'AbortError');
  }
  // A consent read on one connection cannot be sent on a restarted worker's
  // connection, even if its new session revision happens to be the same.
  if (expectedPort !== undefined && (!expectedPort || expectedPort !== port)) {
    throw new DOMException('Connection changed', 'AbortError');
  }
  if (!port) connect();
  port.postMessage(message);
}

// ---------- approvals ----------

// The actions the worker asks the user about. One card per request, drawn in
// the one place both screens can see: the chat and the voice screen share it,
// so there is one authority for an action and one answer for it.
//
// The worker owns the request. The panel draws what the worker published — the
// action, the site and the name of the target — and nothing else: the
// arguments, the value and the permit are never on the screen.
const permissionUi = createPermissionUi({
  container: $('approvals'),
  t: approvalWords,
  getSessionId: () => sessionId,
  getConnection: () => port,
  getRevision: () => accessUi.confirmed.revision,
  // The answer goes out on the connection and for the chat the card was drawn
  // for. The helper holds both of them, and they are handed on as they are.
  send: (message, options) => send(message, options),
});

/** The requests that are live, by their id: what the worker still waits for. */
const permissionRequests = new Map();

/**
 * The words of a card.
 *
 * The name of a tool is translated when the panel knows it: an Arabic panel
 * should not ask about a "type_text". A tool it does not know keeps the name
 * it has, which is the only honest thing to show.
 */
function approvalWords(key, vars = {}) {
  if (key === 'access.approval.action' && typeof vars?.action === 'string') {
    const nameKey = `access.approval.actionName.${vars.action}`;
    const name = t(nameKey);
    if (name !== nameKey) return t(key, { ...vars, action: name });
  }
  return t(key, vars);
}

/** The shared area is only on the screen while something waits in it. */
function syncApprovals() {
  const node = $('approvals');
  if (node) node.hidden = permissionUi.count === 0;
}

/**
 * The worker asks for one action to be allowed.
 *
 * The request belongs to the chat, the revision and the connection it was made
 * with, and the card is drawn for it alone. A request of another chat, of
 * another revision, or one that arrives on no live connection is not drawn.
 */
function applyAccessRequest(event) {
  const drawn = permissionUi.apply(event);
  const request = event?.request;
  if (drawn && request && typeof request.id === 'string') permissionRequests.set(request.id, request);
  syncApprovals();
}

/**
 * The request is settled: the card goes with it.
 *
 * A settlement may arrive before the mode it was asked under is confirmed
 * again — the worker says that a request ended before it says what the mode is
 * now — so it is processed as it comes, and the cards that are left are the
 * ones the worker still waits for.
 */
function settleAccessRequest(event) {
  const settled = permissionUi.settle(event);
  // The cache follows the card: a settlement that is not the one of this
  // request — another chat, another revision, another connection — changes
  // nothing, and the request it names stays where it was.
  if (settled) {
    const id = event?.id;
    if (typeof id === 'string') permissionRequests.delete(id);
  }
  syncApprovals();
}

/**
 * The worker said what the mode is now.
 *
 * A mode that moved takes the approvals of the old mode with it: the cards
 * that were asked under it are gone, and the ones that are asked under the new
 * mode are drawn again.
 */
function refreshApprovals() {
  permissionUi.replay([...permissionRequests.values()]);
  syncApprovals();
}

/**
 * The worker replays the state of the chat.
 *
 * The mode comes before the approvals: a card belongs to the revision the
 * worker confirmed, so the mode is applied first and the requests are drawn
 * under it. What the worker still waits for is what is left; the history of
 * the chat is not a request.
 */
function applyAccessReplay(state, permissions) {
  applyAccessState(state);
  permissionRequests.clear();
  for (const request of Array.isArray(permissions) ? permissions : []) {
    if (request && typeof request.id === 'string') permissionRequests.set(request.id, request);
  }
  permissionUi.replay(permissions);
  syncApprovals();
}

/** The worker is gone, or the chat changed: every card goes with it. */
function resetApprovals() {
  permissionRequests.clear();
  permissionUi.reset();
  syncApprovals();
}

function onEvent(event) {
  switch (event.type) {
    case 'replay':
      // A restarted worker replays the transcript. It is history: it is drawn
      // again, but it does not act on what is on screen now.
      if (!ui.replayed || event.events?.length) {
        clearMessages();
        replaying = true;
        ui.replayed = false; // the finals of the history are not live ones
        event.events.forEach(onEvent);
        ui.replayed = true;
        replaying = false;
      }
      setRunning(event.running);
      if (event.question) setQuestion(event.question);
      ui.pending = event.pending ?? [];
      renderPending();
      // The worker's own state, sent with the replay: the mode that is really
      // in force for this chat now, not a moment of the conversation, and the
      // requests it still waits for under it.
      applyAccessReplay(event.access, event.permissions);
      break;
    case 'access-state':
      // The worker says what the mode is now. A state that belongs to the
      // replayed history is not a state of this chat: it changes nothing.
      if (replaying) break;
      applyAccessState(event);
      // A mode that moved takes the approvals of the old mode with it.
      refreshApprovals();
      break;
    case 'access-request':
      // The worker asks for one action to be allowed. Only the connection that
      // is live now may ask: a request of a worker that is gone, or one that
      // belongs to the history, is not a question that waits for an answer.
      if (replaying) break;
      applyAccessRequest(event);
      break;
    case 'access-request-settled':
      // The request is over: the card goes with it.
      if (replaying) break;
      settleAccessRequest(event);
      break;
    case 'status':
      setRunning(event.running);
      if (!event.running) {
        // The task ended without a report: it did not succeed.
        const entry = voiceEntryFor(event);
        if (entry) {
          entry.setErr(t('voice.failed'));
          finishVoiceTask();
        }
      }
      break;
    case 'user': {
      const node = add(event.steer ? 'msg user steer' : 'msg user', event.text);
      if (event.steer) node.dataset.tag = t('msg.steered');
      // An answer to ask_user or a message sent while working is part of the task.
      if (!event.answer && !event.steer) ui.stats = newStats(event.at);
      break;
    }
    case 'pending-added':
      ui.pending.push(event.item);
      renderPending();
      break;
    case 'pending-removed':
      ui.pending = ui.pending.filter((m) => m.id !== event.id);
      renderPending();
      break;
    case 'turn-end':
      addTurn(event);
      break;
    case 'usage':
      if (event.source === 'fast' && event.usage) {
        ui.stats.fastIn += event.usage.input;
        ui.stats.fastOut += event.usage.output;
      }
      break;
    case 'thinking':
      openThread(event.step);
      break;
    case 'reasoning-delta':
      ui.liveReasoning ??= threadPart('msg reasoning');
      ui.liveReasoning.textContent += event.delta;
      if (ui.thread) {
        ui.thread.reasoning += event.delta;
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      scrollDown();
      break;
    case 'text-delta':
      ui.liveText ??= threadPart('msg assistant');
      ui.liveText.textContent += event.delta;
      scrollDown();
      break;
    case 'text-reset':
      ui.liveText?.remove();
      ui.liveText = null;
      break;
    case 'assistant-text':
      (ui.liveText ?? threadPart('msg assistant')).innerHTML = renderMarkdown(event.text);
      ui.liveText = null;
      if (ui.thread) {
        ui.thread.text = event.text;
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      break;
    case 'turn-interrupted':
      ui.thread?.box.classList.add('interrupted');
      closeThread();
      break;
    case 'tool-start':
      if (event.fast) closeThread(); // the fast layer acts between model turns
      if (ui.thread) {
        ui.thread.tools.push(event.name);
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      addStep(event);
      voiceEntryFor(event)?.setStatus(`${t('status.running')} · ${event.name}`, 'thinking');
      break;
    case 'fast-handoff':
      closeThread();
      traceBlock().append(Object.assign(document.createElement('div'), { className: 'step handoff', textContent: `⚡→🧠 ${event.reason}` }));
      scrollDown();
      break;
    case 'tool-end': {
      // Sessions saved before call ids existed match by step and name.
      const row = ui.steps.get(event.callId ?? event.step + event.name);
      if (row) {
        row.classList.toggle('fail', !event.ok);
        row.querySelector('.mark').textContent = event.ok ? '✓' : '✗';
        row.title = event.summary;
        if (Number.isFinite(event.ms)) row.append(span('time', formatDuration(event.ms)));
      }
      const voiceEntry = voiceEntryFor(event);
      if (voiceEntry) {
        const mark = event.ok ? '✓' : '✗';
        voiceEntry.setStatus(`${mark} ${event.summary || event.name}`, event.ok ? 'ok' : 'err');
      }
      break;
    }
    case 'ask':
      closeThread();
      if (replaying) {
        // A question from the history: it is shown, but it is not a question
        // that is waiting for an answer, and it changes nothing on screen.
        add('msg ask', event.question);
        break;
      }
      // The question has to be answered: the chat is shown, so it is never
      // hidden behind the voice screen.
      showChat();
      setQuestion(event.question);
      // The task waits for the answer, but the command that started it is
      // over: the screen is free again, so the answer may be given by voice,
      // and no new task is started for it. The entry of the command keeps
      // the events of the task.
      settleVoiceCommand();
      voiceEntryFor(event)?.setStatus(t('status.waiting'), 'thinking');
      break;
    case 'final': {
      ui.liveText?.remove();
      ui.liveText = null;
      const node = add(`msg final${event.success ? '' : ' partial'}`, '');
      node.innerHTML = renderMarkdown(event.report);
      const heading = document.createElement('h3');
      heading.textContent = t(event.success ? 'report.final' : 'report.partial');
      node.prepend(heading);
      const totals = totalsLine(event.at);
      if (totals) node.append(totals);
      node.append(reportActions(event.report));
      if (ui.replayed) askForRating(); // live finals only, not the history replayed on open
      const voiceEntry = voiceEntryFor(event);
      if (voiceEntry) {
        // A report that says the task failed is never shown as a success.
        if (event.success) {
          voiceEntry.setOk(t('voice.success'));
          voiceController?.speak(t('voice.doneSpoken'));
        } else {
          voiceEntry.setErr(t('voice.partial'));
          voiceController?.speak(t('voice.partialSpoken'));
        }
        finishVoiceTask();
      }
      break;
    }
    case 'error':
      add('msg error', event.message);
      voiceEntryFor(event)?.setErr(event.message);
      if (!replaying) finishVoiceTask();
      break;
    case 'stopped':
      add('msg error', t('msg.stopped'));
      voiceEntryFor(event)?.setErr(t('voice.cancelled'));
      if (!replaying) finishVoiceTask();
      break;
    case 'notice':
      ui.notices.push(event);
      renderNotices();
      break;
    case 'notice-dismissed':
      ui.notices = ui.notices.filter((n) => n.id !== event.id);
      renderNotices();
      break;
    case 'sessions-changed':
      refreshSessions();
      break;
    case 'session-missing':
      showTabSession();
      break;
    case 'auth-success':
      authNote[event.provider] = '';
      refreshAuthState(event.provider).catch(() => {});
      break;
    case 'auth-event':
      // The worker opened the sign-in page, or it has a device code to show.
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      authAttempt[event.provider] = event.attemptId;
      if (event.kind === 'device_code') showDeviceCode(event.provider, event.userCode, event.verificationUrl);
      break;
    case 'auth-prompt':
      // The flow asks for the code the provider's page shows.
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      authAttempt[event.provider] = event.attemptId;
      showCodePrompt(event.provider, true);
      break;
    case 'auth-error':
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      showAuthError(event.provider, event.message, event.code);
      break;
    default:
      break;
  }
}

/** A message inside the current turn's thread, or in the chat when there is none. */
function threadPart(className) {
  if (!ui.thread) return add(className, '');
  const node = Object.assign(document.createElement('div'), { className, dir: 'auto' });
  if (ui.thread.trace) ui.thread.body.insertBefore(node, ui.thread.trace);
  else ui.thread.body.append(node);
  scrollDown();
  return node;
}

/** A message in the chat itself (the user, a report, an error): the open thread closes. */
function add(className, text) {
  closeThread();
  $('emptyState').hidden = true;
  ui.trace = null;
  const node = document.createElement('div');
  node.className = className;
  node.dir = 'auto';
  node.textContent = text;
  $('messages').append(node);
  scrollDown();
  return node;
}

/**
 * Consecutive tool steps and fast-layer hand-overs share one trace block: inside the
 * current model turn's thread, or on its own for fast-layer steps between turns.
 */
function traceBlock() {
  $('emptyState').hidden = true;
  if (ui.thread) {
    if (!ui.thread.trace) {
      ui.thread.trace = Object.assign(document.createElement('div'), { className: 'trace' });
      ui.thread.body.append(ui.thread.trace);
    }
    return ui.thread.trace;
  }
  if (!ui.trace) {
    ui.trace = document.createElement('div');
    ui.trace.className = 'trace';
    $('messages').append(ui.trace);
  }
  return ui.trace;
}

/**
 * One model turn as a thread: a single collapsible line (its first thought, or its
 * text or tools) holding the reasoning, any text and the turn's tool steps. Open
 * while the turn works; it closes when the next turn starts or the task ends,
 * unless the user opened or closed it by hand.
 */
function openThread(step) {
  closeThread();
  $('emptyState').hidden = true;
  ui.trace = null;
  const box = Object.assign(document.createElement('details'), { className: 'thread', open: true });
  const summary = document.createElement('summary');
  const title = span('title', t('thread.thinking'));
  title.dir = 'auto';
  const meta = span('meta', '');
  summary.append(title, meta);
  const body = Object.assign(document.createElement('div'), { className: 'thread-body' });
  box.append(summary, body);
  $('messages').append(box);
  const thread = { box, title, meta, body, step, reasoning: '', text: '', tools: [], trace: null, userToggled: false };
  summary.addEventListener('click', () => { thread.userToggled = true; });
  ui.thread = thread;
  scrollDown();
}

function closeThread() {
  const thread = ui.thread;
  if (!thread) return;
  if (!thread.userToggled) thread.box.open = false;
  thread.title.textContent = threadTitle(thread);
  ui.thread = null;
  ui.liveReasoning = null;
  ui.liveText = null;
}

/** The thread's line: its first sentence of thought, else its text, else its tools. */
function threadTitle(thread) {
  const first = (text) => text.trim().split(/(?<=[.!?؟])\s|\n/)[0].trim();
  const line = first(thread.reasoning) || first(thread.text) || [...new Set(thread.tools)].join(', ');
  if (!line) return t('thread.step', { n: thread.step ?? '' });
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function addStep({ step, callId, name, args, fast }) {
  const row = document.createElement('div');
  row.className = fast ? 'step fast' : 'step';
  const compact = JSON.stringify(args ?? {}).replace(/^\{|\}$/g, '');
  row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="args"></span>';
  row.querySelector('.name').textContent = `${step}. ${name}`;
  row.querySelector('.args').textContent = compact;
  traceBlock().append(row);
  ui.steps.set(callId ?? step + name, row);
  scrollDown();
}

function newStats(start = null) {
  return { start, input: 0, output: 0, missing: 0, turns: 0, fastIn: 0, fastOut: 0 };
}

function span(className, text) {
  return Object.assign(document.createElement('span'), { className, textContent: text });
}

const number = (n) => n.toLocaleString('en-US');

/** 0.4s, 12.3s, 2m 05s. */
function formatDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** One model turn in the trace: who answered, how long it thought, and its tokens. */
function addTurn({ model, ms, retryWaitMs, usage }) {
  ui.stats.turns += 1;
  if (usage) {
    ui.stats.input += usage.input;
    ui.stats.output += usage.output;
  } else {
    ui.stats.missing += 1;
  }
  const tokens = usage ? t('stats.tokens', { input: number(usage.input), output: number(usage.output) }) : '';
  const waited = retryWaitMs ? t('stats.retryWait', { time: formatDuration(retryWaitMs) }) : '';
  const time = Number.isFinite(ms) ? formatDuration(ms) : '';
  if (ui.thread) {
    // On the thread's own line: the model, its time and its tokens.
    ui.thread.meta.textContent = [time, tokens, waited].filter(Boolean).join(' · ');
    ui.thread.meta.title = model || '';
    return;
  }
  const row = document.createElement('div');
  row.className = 'step turn';
  row.append(span('mark', '◆'), span('name', model || 'model'));
  row.append(span('args', [tokens, waited].filter(Boolean).join(' · ')));
  if (time) row.append(span('time', time));
  traceBlock().append(row);
  scrollDown();
}

/** Under the final report: the whole task's time and tokens. */
function totalsLine(end) {
  const { start, input, output, missing, turns, fastIn, fastOut } = ui.stats;
  if (!start || !end) return null; // sessions saved before timings existed
  const parts = [t('stats.total', { time: formatDuration(end - start) })];
  if (turns > missing) parts.push(t('stats.totalTokens', { input: number(input), output: number(output) }) + (missing ? ` ${t('stats.partial')}` : ''));
  if (fastIn || fastOut) parts.push(t('stats.fast', { input: number(fastIn), output: number(fastOut) }));
  return Object.assign(document.createElement('div'), { className: 'totals', textContent: parts.join(' · ') });
}

/** Copy and Markdown export, in the report's lower corner. */
function reportActions(markdown) {
  const bar = document.createElement('div');
  bar.className = 'report-actions';
  const copy = reportButton('report.copy', copySquares());
  const save = reportButton('report.export', Object.assign(document.createElement('span'), { className: 'md', textContent: 'md' }));
  copy.addEventListener('click', async () => {
    try {
      await copyText(markdown);
      showCopied(copy);
    } catch {
      copy.dataset.i18nTitle = 'report.copyFailed';
      copy.title = t('report.copyFailed');
      copy.setAttribute('aria-label', copy.title);
    }
  });
  save.addEventListener('click', () => {
    const title = sessionLabel(sessionList.find((s) => s.id === sessionId));
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const name = reportFileName(title, new Date().toISOString().slice(0, 10), t('session.untitled'));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  bar.append(copy, save);
  return bar;
}

function reportButton(labelKey, child) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.dataset.i18nTitle = labelKey;
  button.title = t(labelKey);
  button.setAttribute('aria-label', button.title);
  button.append(child);
  return button;
}

/** Two overlapping squares, the usual copy mark. */
function copySquares() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="5.4" y="5.4" width="8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"></rect><path d="M10.4 4.6V3.4A1.4 1.4 0 0 0 9 2H3.4A1.4 1.4 0 0 0 2 3.4V9A1.4 1.4 0 0 0 3.4 10.4H4.6" fill="none" stroke="currentColor" stroke-width="1.4"></path>';
  return svg;
}

function showCopied(button) {
  button.classList.add('copied');
  button.dataset.i18nTitle = 'report.copied';
  button.title = t('report.copied');
  button.setAttribute('aria-label', button.title);
  const mark = Object.assign(document.createElement('span'), { className: 'tick', textContent: '✓' });
  button.replaceChildren(mark);
  setTimeout(() => {
    button.classList.remove('copied');
    button.dataset.i18nTitle = 'report.copy';
    button.title = t('report.copy');
    button.setAttribute('aria-label', button.title);
    button.replaceChildren(copySquares());
  }, 1500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The side panel sometimes has no clipboard permission; the selection fallback still works.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function clearMessages() {
  ui.thread = null;
  $('messages').querySelectorAll('.msg, .trace, .thread').forEach((n) => n.remove());
  ui.pending = [];
  renderPending();
  ui.steps.clear();
  ui.trace = null;
  ui.notices = [];
  renderNotices();
}

const NOTICE_TEXT = { switched: 'notice.switched', 'both-failed': 'notice.bothFailed', 'fast-switched': 'notice.fastSwitched', 'fast-unavailable': 'notice.fastUnavailable', retrying: 'notice.retrying' };

/** Newest first; the full provider error is in the tooltip. */
function renderNotices() {
  $('notices').replaceChildren(...ui.notices.slice(-MAX_NOTICES).reverse().map((notice) => {
    const reason = notice.code && notice.code !== 'other' ? t(`failure.${notice.code}`) : notice.reason;
    const row = document.createElement('div');
    row.className = `notice ${notice.level}`;
    row.title = notice.detail ?? '';
    row.dir = 'auto';
    const text = document.createElement('span');
    text.textContent = `⚠ ${t(NOTICE_TEXT[notice.kind] ?? 'notice.switched', { from: notice.from ?? '', to: notice.to ?? '', reason })}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ghost icon';
    close.textContent = '×';
    close.setAttribute('aria-label', t('notice.dismiss'));
    close.addEventListener('click', () => send({ type: 'dismiss-notice', id: notice.id }));
    row.append(text, close);
    return row;
  }));
}

const PENDING_CHIP = { 'next-step': 'pending.nextStep', interrupt: 'pending.interrupt', queue: 'pending.queue' };

/** Messages waiting to be read, above the composer, each with Send now and Remove. */
function renderPending() {
  const list = $('pending');
  list.hidden = !ui.pending.length;
  list.replaceChildren(...ui.pending.map((m) => {
    const row = document.createElement('li');
    const text = span('text', m.text);
    text.dir = 'auto';
    text.title = m.text;
    row.append(text, span('chip', t(m.now ? 'pending.interrupt' : PENDING_CHIP[m.mode] ?? 'pending.nextStep')));
    if (!m.now) {
      const now = Object.assign(document.createElement('button'), { type: 'button', textContent: '⚡', title: t('pending.sendNow') });
      now.setAttribute('aria-label', t('pending.sendNow'));
      now.addEventListener('click', () => send({ type: 'steer-now', id: m.id }));
      row.append(now);
    }
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: t('pending.remove') });
    remove.setAttribute('aria-label', t('pending.remove'));
    remove.addEventListener('click', () => send({ type: 'steer-cancel', id: m.id }));
    row.append(remove);
    return row;
  }));
}

function setQuestion(question) {
  ui.question = question;
  ui.questionId += 1;
  add('msg ask', question);
  showPendingQuestion(question);
  $('hint').textContent = t('status.waiting');
  $('sendBtn').hidden = false;
  $('input').focus();
}

/**
 * A question that is waiting for an answer stays visible in the voice screen:
 * it is never hidden behind it, and the user can go back to the chat to
 * answer it there.
 */
function showPendingQuestion(question) {
  const box = $('voicePending');
  if (!box) return;
  if (!question) {
    box.hidden = true;
    return;
  }
  $('voicePendingText').textContent = question;
  box.hidden = false;
}

/**
 * The question that was answered is gone: the card is hidden, the panel waits
 * for the task again and the send button goes away with it. A question that
 * arrived while the answer was on its way is a different one: it keeps its
 * card, its hint and its button.
 */
function clearAnsweredQuestion(questionId) {
  if (ui.questionId !== questionId) return false;
  ui.question = null;
  showPendingQuestion(null);
  $('hint').textContent = t('status.running');
  $('sendBtn').hidden = true;
  return true;
}

/**
 * The answer to a question went out (or failed): the question may be
 * answered again. Only the answer that is on its way is released, so a newer
 * question keeps its own.
 */
function releaseAnswer(questionId) {
  if (ui.answering === questionId) ui.answering = null;
}

function setRunning(running) {
  ui.running = running;
  if (!running) closeThread();
  $('statusDot').classList.toggle('running', running);
  $('stopBtn').hidden = !running;
  $('workspaceStopBtn').hidden = !running || ($('settingsView').hidden && $('voiceView').hidden);
  $('sendBtn').hidden = false; // while running, a message steers the task (see steerMode)
  if (!running) {
    ui.question = null;
    showPendingQuestion(null);
    $('hint').textContent = '';
  } else if (!ui.question) {
    $('hint').textContent = t('status.running');
  }
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

let attachments = [];

function fileWarning(file) {
  if (file.warning === 'too-big') return t('composer.fileBig', { name: file.name });
  if (file.warning === 'unreadable-image') return t('composer.fileBad', { name: file.name });
  return file.warning || '';
}

function renderFiles() {
  const list = $('fileChips');
  list.hidden = attachments.length === 0;
  list.replaceChildren(...attachments.map((file) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'text';
    name.textContent = file.pending ? `${file.name}…` : file.name;
    const warning = fileWarning(file);
    if (warning) name.title = warning;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = t('composer.removeFile');
    remove.setAttribute('aria-label', t('composer.removeFile'));
    remove.addEventListener('click', () => {
      attachments = attachments.filter((item) => item.id !== file.id);
      renderFiles();
    });
    li.append(name, remove);
    return li;
  }));
}

async function addFiles(files) {
  const room = FILE_LIMITS.maxFiles - attachments.length;
  if (files.length > room) $('hint').textContent = t('composer.fileMany', { n: FILE_LIMITS.maxFiles });
  for (const file of files.slice(0, Math.max(0, room))) {
    const id = crypto.randomUUID();
    attachments.push({ id, name: file.name, pending: true, text: '', warning: '', images: [] });
    renderFiles();
    try {
      const read = await readLocalFile(file);
      const slot = attachments.find((item) => item.id === id);
      if (slot) Object.assign(slot, read, { pending: false, id });
    } catch {
      const slot = attachments.find((item) => item.id === id);
      if (slot) Object.assign(slot, { pending: false, warning: 'unreadable-image' });
    }
    renderFiles();
  }
}

function submitComposer(text, { tabId, signal, expectedSessionId } = {}) {
  signal?.throwIfAborted();
  const value = text.trim();
  if (!value && !attachments.length) return Promise.resolve(false);
  if (attachments.some((file) => file.pending)) {
    $('hint').textContent = t('composer.reading');
    return Promise.resolve(false);
  }
  const packed = packFiles(value, attachments, t('composer.filesTask'));
  if (!packed) {
    $('hint').textContent = t('composer.fileNone');
    return Promise.resolve(false);
  }
  // The question that is answered is remembered by its number: it is only
  // cleared when the answer really went out, and only when it is still the
  // question that waits.
  const questionId = ui.questionId;
  const answering = Boolean(ui.question);
  // One question is answered once: while the answer is on its way, another
  // answer to the same question is refused, and the draft of the user is left
  // alone. The guard is taken before anything is cleared or sent.
  if (answering && ui.answering === questionId) return Promise.resolve(false);
  if (answering) ui.answering = questionId;
  attachments = [];
  renderFiles();
  $('input').value = '';
  const message = { text: packed.task, display: packed.display, images: packed.images };
  const options = { signal, expectedSessionId };
  let sent;
  if (ui.question) {
    sent = send({ type: 'answer', ...message }, options);
  } else if (ui.running) {
    sent = send({ type: 'steer', ...message, mode: settings?.steerMode ?? 'next-step' }, options);
  } else {
    // The tab the task works on: the one the voice command was meant for.
    sent = send({ type: 'run', ...message, ...(tabId ? { tabId } : {}) }, options);
  }
  return sent.then(() => {
    if (answering) clearAnsweredQuestion(questionId);
    releaseAnswer(questionId);
    return true;
  }, (err) => {
    // The answer did not go out: the question stays, and it may be answered
    // again.
    releaseAnswer(questionId);
    throw err;
  });
}

/**
 * A voice command is a message of its own: it never takes the files the user
 * attached, it never clears what they wrote, and it never waits for a file
 * that is still being read. It answers the question that is waiting, or it
 * starts a task.
 */
function sendVoiceMessage(text, { tabId, signal, expectedSessionId } = {}) {
  signal?.throwIfAborted();
  const value = String(text ?? '').trim();
  if (!value) return Promise.resolve(false);
  const message = { text: value, display: value, images: [] };
  const options = { signal, expectedSessionId };
  let sent;
  // The question that is answered is remembered by its number: it is only
  // cleared when the answer really went out, and only when it is still the
  // question that waits.
  const questionId = ui.questionId;
  const answering = Boolean(ui.question);
  // The same guard as the composer: one question is answered once, and the
  // answer of the voice and the answer of the keyboard do not both go out.
  if (answering && ui.answering === questionId) return Promise.resolve(false);
  if (answering) ui.answering = questionId;
  if (ui.question) {
    sent = send({ type: 'answer', ...message }, options);
  } else if (ui.running) {
    sent = send({ type: 'steer', ...message, mode: settings?.steerMode ?? 'next-step' }, options);
  } else {
    // The tab the task works on: the one the voice command was meant for.
    sent = send({ type: 'run', ...message, ...(tabId ? { tabId } : {}) }, options);
  }
  return sent.then(() => {
    if (answering) clearAnsweredQuestion(questionId);
    releaseAnswer(questionId);
    return true;
  }, (err) => {
    releaseAnswer(questionId);
    throw err;
  });
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  submitComposer($('input').value).catch(() => {});
});
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});
$('composerBox').addEventListener('dragover', (event) => {
  event.preventDefault();
  $('composerBox').classList.add('dropping');
});
$('composerBox').addEventListener('dragleave', () => $('composerBox').classList.remove('dropping'));
$('composerBox').addEventListener('drop', (event) => {
  event.preventDefault();
  $('composerBox').classList.remove('dropping');
  addFiles([...event.dataTransfer.files]);
});

// ---------- voice control ----------

// The pages the extension may not work on: its own pages and Chrome's.
const RESTRICTED_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/;

// 'prompt' until Chrome reports the extension's own microphone permission.
let micPermission = 'prompt';
// Set when the side panel is allowed the microphone and recognition still refuses.
let panelMicBroken = false;
let micWindowId = null;
// Every microphone window carries the epoch it was opened with. A window from
// an earlier command cannot answer the current one, and a panel only stops the
// window it opened.
// Each panel gets a distinct counter range; two panels must not share epoch 1.
let micEpoch = crypto.getRandomValues(new Uint32Array(1))[0] * 1048576;
let micCaptureOpen = false;
let voiceViewToken = 0;
// The tab the voice commands act on. The microphone window takes the focus, so
// the tab is remembered before that window opens.
let voiceOrigin = null;
// Every panel has its own id: the claim it takes on a tab belongs to it, and
// no other panel may take it away.
const voicePanelId = crypto.randomUUID();
// The command the worker is running for this panel, and the log entry it owns.
let voiceTask = null;
let voiceController = null;
let voiceState = 'idle';
// The approval that is waiting for the user, so it can be withdrawn.
let voiceApproval = null;
// The history the worker replayed is not a live event.
let replaying = false;

function watchMicrophone() {
  const query = navigator.permissions?.query;
  if (!query) {
    micPermission = 'unknown';
    return;
  }
  query.call(navigator.permissions, { name: 'microphone' }).then((status) => {
    micPermission = status.state;
    status.onchange = () => { micPermission = status.state; };
  }).catch(() => { micPermission = 'unknown'; });
}

function relayMic(kind) {
  chrome.runtime.sendMessage({ source: MIC_PANEL, kind, epoch: micEpoch }).catch(() => {});
}

/** The tab the user is looking at, when the extension may work on it. */
async function userTab() {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused && !RESTRICTED_URL.test(focused.url ?? '')) {
    return { id: focused.id, windowId: focused.windowId, url: focused.url || '', title: focused.title || '' };
  }
  // The window that has the focus may be one the extension cannot work on
  // (the microphone's own window, on its way out): the tab of the window the
  // panel is in is the one the user is looking at.
  const [own] = windowId == null ? [] : await chrome.tabs.query({ active: true, windowId });
  if (!own || RESTRICTED_URL.test(own.url ?? '')) return null;
  return { id: own.id, windowId: own.windowId, url: own.url || '', title: own.title || '' };
}

/**
 * The tab the voice commands act on. While the microphone window is open it
 * has the focus, so the tab the user was on is the one that is remembered.
 * The window that has the focus may be one the extension cannot work on (the
 * microphone's own window, on its way out): the tab of the window the panel
 * is in is the one the user is looking at.
 */
async function voiceTarget() {
  if (micCaptureOpen) return voiceOrigin;
  const tab = await userTab();
  voiceOrigin = tab;
  return voiceOrigin;
}

/** Gives every tab this panel holds back, so another command may use it. */
async function releaseVoiceClaims() {
  try {
    await request('voice-release-all', { panelId: voicePanelId });
  } catch {
    /* the worker is gone: the claims are gone with it */
  }
}

/** The microphone window: a real window, so Chrome can ask for the microphone. */
async function openMicWindow({ continuous = false } = {}) {
  $('voiceLive').textContent = t(micPermission === 'denied' ? 'composer.micDenied' : 'composer.micAsk');
  if (micWindowId != null) {
    try {
      await chrome.windows.update(micWindowId, { focused: true });
      return;
    } catch { micWindowId = null; }
  }
  // The window takes the focus: the tab the command belongs to is remembered
  // before it opens.
  const epoch = ++micEpoch;
  await voiceTarget();
  if (micEpoch !== epoch) return;
  micCaptureOpen = true;
  const url = chrome.runtime.getURL(`src/sidepanel/mic.html?lang=${encodeURIComponent(currentLanguage())}&epoch=${epoch}&continuous=${continuous ? '1' : '0'}`);
  let created;
  try {
    created = await chrome.windows.create({ url, type: 'popup', width: 420, height: 360, focused: true });
  } catch {
    if (micEpoch === epoch) {
      micCaptureOpen = false;
      voiceController?.handleCaptureEnded();
    }
    $('voiceLive').textContent = t('composer.micFailed');
    return;
  }
  // The capture may have been stopped while the window was being created: the
  // window that arrived late is closed again, so it does not keep recording.
  if (micEpoch !== epoch) {
    chrome.windows.remove(created.id).catch(() => {});
    return;
  }
  micWindowId = created?.id ?? null;
}

function closeMicWindow() {
  const epoch = micEpoch;
  micWindowId = null;
  micCaptureOpen = false;
  micEpoch += 1; // what the old window says from now on is stale
  chrome.runtime.sendMessage({ source: MIC_PANEL, kind: 'cancel', epoch }).catch(() => {});
}

/** What the microphone window heard. Only the window of this epoch counts. */
function onMicMessage(message) {
  if (message?.source !== MIC_WINDOW || Number(message.epoch) !== micEpoch) return;
  if (message.kind === 'partial') {
    voiceController?.handlePartial(message.text || '');
    return;
  }
  if (message.kind === 'moved') {
    // The window moved to a tab, where Chrome can ask for the microphone.
    $('voiceLive').textContent = t('composer.micAsk');
    // The permission tab owns the relay now; closing the old popup is not an end.
    micWindowId = null;
    return;
  }
  if (message.kind === 'final' || message.kind === 'end') {
    const text = String(message.text || '').trim();
    if (!text) {
      $('voiceLive').textContent = t('composer.micEmpty');
      return;
    }
    voiceController?.handleFinal(text);
    return;
  }
  if (message.kind === 'ended') {
    // The window stopped listening: the capture is over.
    voiceController?.handleCaptureEnded();
    return;
  }
  if (message.kind === 'error') {
    voiceController?.handleError(message.code);
  }
}

// ---------- the voice screen ----------

/** One line of the activity log: the command, and what came of it. */
function voiceLogEntry(command) {
  const log = $('voiceLog');
  const li = document.createElement('li');
  li.className = 'voice-entry';
  const cmd = document.createElement('div');
  cmd.className = 'voice-entry-cmd';
  cmd.dir = 'auto';
  cmd.textContent = command;
  const detail = document.createElement('div');
  detail.className = 'voice-entry-detail';
  const status = document.createElement('span');
  status.className = 'voice-entry-status';
  status.textContent = t('voice.executing');
  detail.append(status);
  li.append(cmd, detail);
  log.prepend(li);
  return {
    node: li,
    setStatus(text, state) {
      status.textContent = text;
      li.className = `voice-entry${state ? ` ${state}` : ''}`;
    },
    addDecision(action, confidence, ms) {
      const badge = document.createElement('span');
      badge.className = 'voice-entry-badge';
      const pct = Math.round((confidence ?? 0) * 100);
      badge.textContent = `${action} · ${t('voice.confidence', { pct })}${Number.isFinite(ms) ? ` · ${ms}ms` : ''}`;
      detail.append(badge);
    },
    addNote(text) {
      const note = document.createElement('span');
      note.className = 'voice-entry-note';
      note.textContent = text;
      detail.append(note);
    },
    setOk(text, ms) {
      status.textContent = `✓ ${text}`;
      li.className = 'voice-entry ok';
      if (Number.isFinite(ms)) {
        const time = document.createElement('span');
        time.className = 'muted';
        time.textContent = `${ms}ms`;
        detail.append(time);
      }
    },
    setErr(text) {
      status.textContent = `✗ ${text}`;
      li.className = 'voice-entry err';
    },
  };
}

function setVoiceState(state) {
  voiceState = state;
  const stateEl = $('voiceState');
  if (!stateEl) return;
  stateEl.textContent = t(`voice.state${state.charAt(0).toUpperCase()}${state.slice(1)}`);
  stateEl.className = `pill voice-pill${state === 'idle' ? '' : ` ${state}`}`;
  $('voiceMicBtn')?.classList.toggle('on', state === 'listening');
}

/** What the microphone could not do, said in the panel's language. */
function voiceFailure(code) {
  const key = code === 'not-supported' ? 'composer.micMissing'
    : code === 'restart-limit' ? 'voice.micRestarts'
      : voiceErrorKey(code);
  if (!key) return;
  $('voiceLive').textContent = t(key);
}

/** The voice output, spoken by the browser. It is never a command of its own. */
function speakNow(text, { onEnd } = {}) {
  const synth = window.speechSynthesis;
  if (!synth) {
    onEnd?.();
    return;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.lang = currentLanguage() === 'ar' ? 'ar-EG' : 'en-US';
    utterance.onend = () => onEnd?.();
    utterance.onerror = () => onEnd?.();
    synth.speak(utterance);
  } catch {
    onEnd?.();
  }
}

const VOICE_PREF_KEYS = ['voiceHandsfree', 'voiceSpeak'];

async function loadVoicePrefs() {
  const saved = await chrome.storage.local.get(VOICE_PREF_KEYS).catch(() => ({}));
  return { handsFree: saved.voiceHandsfree !== false, speakReplies: saved.voiceSpeak === true };
}

async function saveVoicePrefs(prefs) {
  await chrome.storage.local.set({
    voiceHandsfree: Boolean(prefs.handsFree),
    voiceSpeak: Boolean(prefs.speakReplies),
  }).catch(() => {});
}

function createVoice() {
  return createVoiceController({
    createRecognition: () => {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) return null;
      const rec = new Ctor();
      rec.lang = speechLang(currentLanguage());
      return rec;
    },
    // The side panel cannot ask Chrome for the microphone; a real window can.
    canListenInPanel: () => !panelMicBroken && micListenTarget(micPermission) === 'panel',
    openMicWindow,
    closeMicWindow,
    // The voice output holds the microphone window as well.
    pauseCapture: () => { if (micCaptureOpen) relayMic('pause'); },
    resumeCapture: () => { if (micCaptureOpen) relayMic('resume'); },
    say: speakNow,
    stopSpeech: () => { try { window.speechSynthesis?.cancel(); } catch { /* no speech */ } },
    speaking: () => Boolean(window.speechSynthesis?.speaking),
    onState: setVoiceState,
    onTranscript: (text, { final }) => {
      const live = $('voiceLive');
      live.textContent = text;
      live.classList.toggle('final', Boolean(final));
    },
    onCommand: (text, { signal, entry }) => runVoiceCommand(text, { signal, entry }),
    onLog: voiceLogEntry,
    loadPrefs: loadVoicePrefs,
    savePrefs: saveVoicePrefs,
    onFailure: voiceFailure,
    onMicBlocked: () => { panelMicBroken = true; },
    // A command that is dropped before it runs says so in the panel's language.
    cancelledText: () => t('voice.cancelled'),
  });
}

function syncVoiceToggles() {
  const prefs = voiceController?.prefs;
  if (!prefs) return;
  $('voiceHandsfree').checked = prefs.handsFree;
  $('voiceSpeak').checked = prefs.speakReplies;
}

/** The texts of the voice screen that are drawn, not translated in place. */
function updateVoiceLabels() {
  $('voiceLog')?.setAttribute('data-empty', t('voice.emptyLog'));
  const engine = $('voiceEngineTag');
  if (engine) engine.textContent = (settings?.voiceEngine ?? 'postora') === 'fast_only' ? t('voice.engineFastOnly') : t('voice.enginePostora');
  setVoiceState(voiceState);
  syncVoiceToggles();
}

/** The voice screen is shown: the microphone may start listening. */
async function openVoice() {
  const token = ++voiceViewToken;
  $('voiceView').hidden = false;
  $('chatView').hidden = true;
  $('settingsView').hidden = true;
  syncHeaderContext();
  // The shared approval region docks beside the voice input, where a spoken
  // or typed answer reaches it.
  placeApprovals('voice');
  voiceController ??= createVoice();
  // A question that is waiting for an answer is shown in the voice screen too:
  // it must never be hidden behind it.
  showPendingQuestion(ui.question);
  await voiceTarget();
  if (token !== voiceViewToken || $('voiceView').hidden) return;
  await voiceController.open();
  updateVoiceLabels();
  if (voiceController.listening) $('voiceLive').textContent = t('voice.listeningNow');
}

/** The voice screen is left: the microphone stops and the voice output stops. */
function closeVoice({ cancel = false } = {}) {
  voiceViewToken += 1;
  if ($('voiceView').hidden) return;
  $('voiceView').hidden = true;
  $('chatView').hidden = false;
  syncHeaderContext();
  placeApprovals('chat');
  voiceController?.close();
  voiceApproval?.();
  if (cancel) {
    voiceController?.cancelCommand();
    // Only a task the worker is running for this command is stopped: a fast
    // command never asked the worker to do anything.
    if (voiceTask) {
      cancelVoiceTask(t('voice.cancelled'));
      send({ type: 'stop' }).catch(() => {});
    }
  }
}

/** The chat is shown, so a question can be answered in it. */
function showChat() {
  closeVoice();
}

// ---------- the commands ----------

/** The log entry of the command the worker is running, when this event is its. */
function voiceEntryFor(event) {
  if (replaying) return null;
  const task = voiceTask;
  if (!task) return null;
  if (task.sessionId !== sessionId) return null;
  // The history that was replayed on open is older than the command.
  if (Number.isFinite(event?.at) && event.at < task.startedAt) return null;
  return task.entry;
}

function finishVoiceTask() {
  const task = voiceTask;
  if (!task) return;
  voiceTask = null;
  task.resolve?.();
}

/**
 * The command that is running asks a question: the task waits for the answer,
 * but the command itself is over. The screen is free again, so the answer may
 * be given by voice. The entry keeps the events of the task, so the task is
 * still shown where it belongs.
 */
function settleVoiceCommand() {
  voiceTask?.resolve?.();
}

function cancelVoiceTask(message) {
  const task = voiceTask;
  if (!task) return;
  voiceTask = null;
  task.entry?.setErr?.(message || t('voice.cancelled'));
  task.resolve?.();
}

/** Runs one spoken command on the engine the user chose. */
async function runVoiceCommand(text, { signal, entry }) {
  if (signal.aborted) return;
  // A question that waits for an answer may be answered by voice while the
  // task is still working: the answer belongs to that question, not to a new
  // command. Every other command is refused while the session is busy.
  const answering = Boolean(ui.question);
  if (ui.running && !answering) {
    entry.setErr(t('voice.busy'));
    return;
  }
  if (answering) {
    // The answer goes to the question that waits. No fresh task is started
    // for it: the task that asked is still running, and it is the one that
    // continues when the answer arrives.
    try {
      const sent = await sendVoiceMessage(text, { signal, expectedSessionId: sessionId });
      if (signal.aborted) return;
      if (!sent) entry.setErr(t('voice.failed'));
      else {
        // The answer belongs to the task in the chat, and so does its
        // report: the panel hands the screen back to the chat.
        showChat();
        entry.setOk(t('voice.success'));
      }
    } catch (err) {
      // Only a cancellation of this command is silent: every other failure is
      // a failure the user has to see.
      if (signal.aborted) return;
      entry.setErr(String(err?.message ?? err));
    }
    return;
  }
  if ((settings?.voiceEngine ?? 'postora') === 'fast_only') {
    return runFastVoiceCommand(text, { signal, entry });
  }
  // Postora: the worker runs the task and its events fill the log entry. A
  // session that is already working on something is not steered by a voice
  // command: the result would belong to a task the user did not ask for.
  return new Promise((resolve) => {
    const task = { entry, text, startedAt: Date.now(), sessionId, resolve };
    voiceTask = task;
    voiceTarget().then((target) => {
      if (signal.aborted || voiceTask !== task || sessionId !== task.sessionId) {
        resolve();
        return;
      }
      return sendVoiceMessage(text, { tabId: target?.id, signal, expectedSessionId: task.sessionId }).then((sent) => {
        if (!sent) {
          entry.setErr(t('voice.failed'));
          if (voiceTask === task) finishVoiceTask();
        }
      }, (err) => {
        // A command that was cancelled says so; the screen is closed and
        // nothing of it may be written into it. The task is finished anyway,
        // or the command would keep the screen busy for ever.
        if (signal.aborted) {
          if (voiceTask === task) finishVoiceTask();
          return;
        }
        if (voiceTask === task) {
          // The task never left the panel: the command must not stay open,
          // and the failure is shown. An abort that this command did not ask
          // for is a failure too: a provider or a browser that timed out.
          entry.setErr(String(err?.message ?? err));
          finishVoiceTask();
          return;
        }
        // The command was stopped for another reason (the session was left,
        // the screen was closed): its entry keeps what it says, and the
        // command must not keep the screen busy.
        task.resolve?.();
      });
    }).catch((err) => {
      // A command that was cancelled is not a failure of the page: nothing of
      // it may be written into the screen.
      if (signal.aborted) {
        if (voiceTask === task) finishVoiceTask();
        return;
      }
      if (voiceTask === task) {
        entry.setErr(err?.message ? String(err.message) : t('voice.failed'));
        finishVoiceTask();
        return;
      }
      task.resolve?.();
    });
  });
}

/** The fast layer runs the command itself, without the main model. */
async function runFastVoiceCommand(text, { signal, entry }) {
  const fast = settings?.fast ?? {};
  if (!fast.apiKey) {
    entry.setErr(t('err.fastKey'));
    return;
  }
  if (!fast.baseUrl) {
    entry.setErr(t('err.fastUrl'));
    return;
  }
  // The same provider-aware client the fast layer uses: the configured
  // provider, model, endpoint and key, with the configured backup.
  const ask = createFastAsk(fast, (notice) => entry.addNote(notice.kind === 'fast-unavailable'
    ? t('notice.fastUnavailable', notice) : `${notice.from} → ${notice.to}`));
  const browser = createChromeBrowser({ sessionId, target: voiceTarget, panelId: voicePanelId });
  let result;
  try {
    result = await runFastCommand({
      ask,
      browser,
      command: text,
      emit: (event) => {
        if (event.kind === 'decision') entry.addDecision(voiceActionName(event.action), event.confidence, event.ms);
      },
      approve: askVoiceApproval,
      signal,
      secretTokens: SECRET_TOKENS,
      t,
    });
  } catch (err) {
    // A command that was cancelled is not a failure of the page: the screen
    // may be closed already, and nothing of it may be written into it. An
    // abort that this command did not ask for is a failure of the provider or
    // of the browser, and it is shown.
    if (signal.aborted) return;
    entry.setErr(String(err?.message ?? err));
    return;
  }
  // A command that was cancelled while it was running reports nothing: the
  // screen is not changed and nothing is spoken behind the user's back.
  if (signal.aborted) return;
  // The tab the command ended on is the one the next command acts on: the
  // microphone window takes the focus, so the tab has to be remembered.
  if (result.closedTarget) voiceOrigin = null;
  else if (result.target) voiceOrigin = result.target;
  if (result.ok) {
    entry.setOk(result.say || t('voice.success'), result.ms);
    voiceController?.speak(result.say);
  } else {
    entry.setErr(result.say || t('voice.failed'));
    voiceController?.speak(result.say);
  }
  if (result.stopListening) voiceController?.stopListening();
}

/** The name of a step, in the panel's language. */
const VOICE_ACTIONS = {
  navigate: 'voice.actionNavigate',
  new_tab: 'voice.actionNewTab',
  web_search: 'voice.actionSearch',
  click: 'voice.actionClick',
  type_text: 'voice.actionType',
  read_field: 'voice.actionReadField',
  insert_text: 'voice.actionInsertText',
  press_enter: 'voice.actionEnter',
  scroll_down: 'voice.actionScrollDown',
  scroll_up: 'voice.actionScrollUp',
  scroll_top: 'voice.actionTop',
  scroll_bottom: 'voice.actionBottom',
  go_back: 'voice.actionBack',
  go_forward: 'voice.actionForward',
  reload: 'voice.actionReload',
  close_tab: 'voice.actionCloseTab',
  switch_tab: 'voice.actionSwitchTab',
  next_tab: 'voice.actionNextTab',
  previous_tab: 'voice.actionPreviousTab',
  zoom_in: 'voice.actionZoomIn',
  zoom_out: 'voice.actionZoomOut',
  zoom_reset: 'voice.actionZoomReset',
  media_play_pause: 'voice.actionMedia',
  media_mute: 'voice.actionMute',
  find_on_page: 'voice.actionFind',
  stop_listening: 'voice.actionStop',
  unknown: 'voice.actionUnknown',
};

function voiceActionName(action) {
  const key = VOICE_ACTIONS[action];
  return key ? t(key) : String(action ?? '');
}

/**
 * The question the user answers before a step that can send, buy, delete or
 * submit. It is shown in the voice screen, with a yes and a no; it is never a
 * browser dialog.
 */
function askVoiceApproval(what) {
  return new Promise((resolve) => {
    const box = $('voiceApproval');
    box.hidden = false;
    box.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = t('voice.approveTitle');
    const detail = document.createElement('div');
    detail.className = 'voice-approve-detail';
    detail.dir = 'auto';
    detail.textContent = approvalText(what);
    const actions = document.createElement('div');
    actions.className = 'voice-approve-actions';
    const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('voice.approve') });
    const no = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: t('voice.cancel') });
    const done = (answer) => {
      box.hidden = true;
      box.replaceChildren();
      voiceApproval = null;
      resolve(answer);
    };
    voiceApproval = () => done(false);
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    actions.append(yes, no);
    box.append(title, detail, actions);
    if ($('voiceView').hidden) openVoice();
    yes.focus();
  });
}

/** What the user is asked to approve, in words that say what will happen. */
function approvalText(what) {
  return approvalMessage(what, t);
}

$('voiceToggle').addEventListener('click', (e) => {
  e.preventDefault();
  openVoice();
});
$('voiceBackBtn').addEventListener('click', () => closeVoice({ cancel: true }));
$('voiceSettingsBtn').addEventListener('click', () => toggleSettings(true, 'voice'));
$('voicePendingBtn').addEventListener('click', () => showChat());
$('voiceMicBtn').addEventListener('click', () => voiceController?.toggleListening());
$('voiceClearLog').addEventListener('click', () => {
  $('voiceLog').replaceChildren();
});
$('voiceTypedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('voiceTypedInput');
  const val = input.value.trim();
  if (val) {
    input.value = '';
    voiceController?.submit(val);
  }
});
$('voiceHandsfree').addEventListener('change', (e) => {
  (voiceController ??= createVoice()).setHandsFree(e.target.checked);
});
$('voiceSpeak').addEventListener('change', (e) => {
  (voiceController ??= createVoice()).setSpeakReplies(e.target.checked);
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    e.preventDefault();
    if ($('voiceView').hidden) {
      openVoice();
    } else {
      voiceController?.toggleListening();
    }
  }
});
window.addEventListener('pagehide', () => {
  voiceController?.close();
  voiceApproval?.();
});
chrome.runtime.onMessage.addListener(onMicMessage);
chrome.windows.onRemoved.addListener((id) => {
  if (id !== micWindowId) return;
  micWindowId = null;
  voiceController?.handleCaptureEnded();
});
watchMicrophone();
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stopBtn').addEventListener('click', () => send({ type: 'stop' }));
$('workspaceStopBtn').addEventListener('click', () => $('stopBtn').click());
// A new session is a request for the conversation: it lands on the chat, even
// when settings were open when it was asked for.
$('newChatBtn').addEventListener('click', async () => {
  const meta = await request('session-create');
  await chooseSession(meta.id);
  $('settingsView').hidden = true;
  $('chatView').hidden = false;
  syncHeaderContext();
  placeApprovals('chat');
});
document.querySelectorAll('.examples li').forEach((li) => li.addEventListener('click', () => {
  $('input').value = li.textContent;
  $('input').focus();
}));

// ---------- sessions ----------

// The panel follows the tab the user is looking at: each tab has its own session,
// a new tab starts on a blank one, and a tab where a task ran keeps its session.
let windowId = null;
let tabLookups = 0;

async function startSessions() {
  windowId = (await chrome.windows.getCurrent()).id;
  // Opened as a page in a tab (as the e2e tests do), the panel is that tab's own
  // and must not jump to the session of whichever tab gets focus.
  const ownTab = await chrome.tabs.getCurrent();
  if (!ownTab) {
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) showTabSession(info.tabId).catch(() => {}); // the tab may close mid-lookup
    });
  }
  await showTabSession(ownTab?.id);
  await refreshSessions();
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

function showTabSession(tabId) {
  return pick(async () => {
    const lookup = ++tabLookups;
    const id = await request('tab-session', { tabId: tabId ?? (await activeTabId()) });
    if (lookup === tabLookups) await openSession(id); // a later tab switch wins
  });
}

/** A session picked by the user (from the list, or a new one) becomes the current tab's. */
function chooseSession(id) {
  return pick(async () => {
    tabLookups += 1; // a tab lookup still in flight must not replace the user's pick
    await request('bind-tab', { tabId: await activeTabId(), sessionId: id });
    await openSession(id);
  });
}

async function openSession(id) {
  closeSessionMenu();
  if (id === sessionId && port) return;
  port?.disconnect();
  port = null;
  sessionId = id;
  ui.replayed = false;
  ui.running = false;
  // The mode belonged to the chat that is left: it goes with it, so a warning
  // or a Full label of the old chat cannot survive into the new one.
  accessUi.reset();
  // The approvals of the chat that is left go with it: a card of another chat
  // answers nothing, and it is not on the screen either.
  resetApprovals();
  // A choice that was waiting for the worker was made for the chat that is
  // left: it goes with it too.
  clearAccessIntent();
  // The command that was running belongs to the session that is left: it is
  // stopped with the microphone, and the approval with it, so nothing acts on
  // the tab of the session that is gone.
  cancelVoiceTask(t('voice.cancelled'));
  voiceApproval?.();
  closeVoice();
  voiceController?.close();
  clearMessages();
  $('emptyState').hidden = false;
  connect();
  renderSessionTitle();
}

async function refreshSessions() {
  const refresh = ++sessionListRefresh;
  try {
    const next = await request('sessions-list');
    if (refresh !== sessionListRefresh) return false;
    sessionList = next;
    $('sessionListStatus').hidden = true;
    renderSessionTitle();
    if (!$('sessionMenu').hidden) renderSessionList();
    return true;
  } catch {
    // A worker can disappear while this observational read is in flight.
    // Keep the last list and an explicit recovery path; never retry a write.
    if (refresh === sessionListRefresh) {
      $('sessionListStatus').textContent = t('session.refreshFailed');
      $('sessionListStatus').hidden = false;
    }
    return false;
  }
}

function sessionLabel(meta) {
  return meta?.title || t('session.untitled');
}

function renderSessionTitle() {
  $('sessionTitle').textContent = sessionLabel(sessionList.find((s) => s.id === sessionId));
}

function renderSessionList() {
  const query = $('sessionSearch').value.trim().toLowerCase();
  // Every open panel starts on an empty session; only the current one of those is worth listing.
  // A running session is always listed, so another tab can open it.
  const shown = sessionList
    .filter((s) => s.titled || s.running || s.id === sessionId)
    .filter((s) => !query || sessionLabel(s).toLowerCase().includes(query));
  $('sessionList').replaceChildren(...shown.map(sessionRow));
}

function sessionRow(meta) {
  const row = document.createElement('li');
  row.className = `session-item${meta.id === sessionId ? ' active' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(meta.id === sessionId));
  const dot = document.createElement('span');
  dot.className = `dot${meta.running ? ' running' : ''}`;
  dot.title = meta.running ? t('session.running') : '';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'session-open';
  // <bdi> keeps an English title readable in the Arabic list without flipping the row's alignment.
  title.append(Object.assign(document.createElement('bdi'), { textContent: sessionLabel(meta) }));
  title.addEventListener('click', () => chooseSession(meta.id));
  const rename = iconButton(ICONS.rename, t('session.rename'), () => startRename(row, title, meta));
  const remove = iconButton(ICONS.remove, t('session.delete'), () => deleteSessionAsked(meta));
  row.append(dot, title, rename, remove);
  return row;
}

const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  remove: 'M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3',
};

function iconButton(path, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost icon';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.append(svg);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function startRename(row, title, meta) {
  const input = document.createElement('input');
  input.value = meta.title;
  input.dir = 'auto';
  input.className = 'session-rename';
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== meta.title) await request('session-rename', { id: meta.id, title: input.value });
    await refreshSessions();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSessionAsked(meta) {
  if (!window.confirm(t('session.confirmDelete', { title: sessionLabel(meta) }))) return;
  await request('session-delete', { id: meta.id });
  if (meta.id === sessionId) await showTabSession();
  else await refreshSessions();
}

function toggleSessionMenu() {
  if ($('sessionMenu').hidden) {
    closeOverflowMenu();
    $('sessionMenu').hidden = false;
    $('sessionBtn').setAttribute('aria-expanded', 'true');
    $('sessionSearch').value = '';
    renderSessionList();
    refreshSessions();
    $('sessionSearch').focus();
  } else {
    closeSessionMenu();
  }
}

function closeSessionMenu() {
  $('sessionMenu').hidden = true;
  $('sessionBtn').setAttribute('aria-expanded', 'false');
}

$('sessionBtn').addEventListener('click', toggleSessionMenu);
$('sessionSearch').addEventListener('input', renderSessionList);

// One Escape dismisses only the topmost surface: a native dialog first (the
// browser owns it), then a menu, then a settings page. Nothing is skipped
// past, and nothing is closed twice by one keypress.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('modelDialog').open || $('accessWarning').open) return;
  if (!$('sessionMenu').hidden) { closeSessionMenu(); $('sessionBtn').focus(); return; }
  if (!$('overflowMenu').hidden) { closeOverflowMenu(); $('overflowBtn').focus(); return; }
  if (!$('accountMenu').hidden) { closeAccountMenu(); return; }
  if (!$('feedbackMenu').hidden) { $('feedbackMenu').hidden = true; $('overflowBtn').focus(); return; }
  if (!$('settingsView').hidden && settingsNav.section() !== null) {
    settingsNav.back();
    syncFooter();
  }
});
document.addEventListener('click', (e) => {
  if (!$('sessionMenu').hidden && !$('sessionMenu').contains(e.target) && !$('sessionBtn').contains(e.target)) closeSessionMenu();
});

// The overflow holds the account, the interface language and feedback: one
// click away, out of the header's way.
function toggleOverflowMenu() {
  if ($('overflowMenu').hidden) {
    closeSessionMenu();
    $('overflowMenu').hidden = false;
    $('overflowBtn').setAttribute('aria-expanded', 'true');
    $('accountBtn').focus();
  } else {
    closeOverflowMenu();
  }
}

function closeOverflowMenu() {
  $('overflowMenu').hidden = true;
  $('overflowBtn').setAttribute('aria-expanded', 'false');
}

$('overflowBtn').addEventListener('click', toggleOverflowMenu);
$('overflowMenu').addEventListener('keydown', (e) => {
  const items = [...$('overflowMenu').querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (index + 1) % items.length
      : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
  if (next === null) return;
  e.preventDefault();
  items[next].focus();
});
document.addEventListener('click', (e) => {
  if (!$('overflowMenu').hidden && !$('overflowMenu').contains(e.target) && !$('overflowBtn').contains(e.target)) closeOverflowMenu();
});

// ---------- Google account ----------

let account = null;

function renderAccount() {
  $('accountAvatar').hidden = !account?.picture;
  $('accountIcon').style.display = account?.picture ? 'none' : ''; // SVG elements have no hidden property
  $('accountSignedOut').hidden = Boolean(account);
  $('accountSignedIn').hidden = !account;
  if (!account) {
    renderSettingsSummaries();
    return;
  }
  $('accountMenuAvatar').src = account.picture;
  $('accountAvatar').src = account.picture;
  $('accountName').textContent = account.name;
  $('accountEmail').textContent = account.email;
  $('accountBtn').title = `${account.name} — ${account.email}`;
  renderSettingsSummaries();
}

// The account popup has two real entry points — the overflow row and the row
// on the Account & backup page. Both open the same dialog; whichever trigger
// opened it is remembered, so Escape hands the focus back to it, and the
// outside-click dismissal knows not to fight the click that opened it.
let accountInvoker = null;

/** One account status surface, with semantic colors and text for every outcome. */
function setAccountStatus(text, tone = '') {
  $('accountStatus').textContent = text;
  $('accountStatus').dataset.tone = tone;
}

function toggleAccountMenu() {
  const opening = $('accountMenu').hidden;
  if (opening) accountInvoker = document.activeElement === $('accountBtn') ? $('overflowBtn') : document.activeElement;
  closeSessionMenu();
  closeOverflowMenu();
  $('feedbackMenu').hidden = true;
  $('accountMenu').hidden = !opening;
  setAccountStatus('');
  if (opening) $('accountMenu').querySelector(account ? '#driveBackupBtn' : '#googleSignInBtn').focus();
}

function closeAccountMenu() {
  $('accountMenu').hidden = true;
  if (accountInvoker?.isConnected) accountInvoker.focus();
  accountInvoker = null;
}

$('accountBtn').addEventListener('click', toggleAccountMenu);
$('accountRowBtn').addEventListener('click', toggleAccountMenu);
$('googleSignInBtn').addEventListener('click', async () => {
  setAccountStatus(t('account.signingIn'));
  try {
    account = await signInWithGoogle();
    renderAccount();
    setAccountStatus(t('drive.working'));
    const { restored, available } = await request('drive-after-sign-in');
    if (restored) await showRestoredSettings(restored);
    if (restored) setAccountStatus(t('drive.restored'), 'success');
    else if (available) setAccountStatus(t('drive.available', { time: `⁨${new Date(available).toLocaleString(currentLanguage())}⁩` }));
    else setAccountStatus('');
  } catch (err) {
    setAccountStatus(`✗ ${err.message}`, 'error');
  }
});
$('driveBackupBtn').addEventListener('click', () => driveAction(() => request('drive-backup-now')));
$('driveRestoreBtn').addEventListener('click', () => {
  if (!window.confirm(t('drive.confirmRestore'))) return;
  driveAction(async () => {
    await showRestoredSettings(await request('drive-restore'));
    setAccountStatus(t('drive.restored'), 'success');
  });
});

async function driveAction(run) {
  setAccountStatus(t('drive.working'));
  try {
    const result = await run();
    // Automatic backups return a stored error instead of throwing. A manual
    // click must report that failure, never turn an old timestamp into success.
    if (result?.error) throw new Error(result.error);
    if (result?.at) setAccountStatus(`✓ ${t('drive.saved', { time: `⁨${new Date(result.at).toLocaleString(currentLanguage())}⁩` })}`, 'success');
    else if ($('accountStatus').textContent === t('drive.working')) setAccountStatus('');
  } catch (err) {
    setAccountStatus(`✗ ${err.message}`, 'error');
  }
}

let driveState = {};

function renderDriveState(state = driveState) {
  driveState = state ?? {};
  if (driveState.error) $('driveStatus').textContent = t('drive.failed', { reason: driveState.error });
  else if (driveState.at) $('driveStatus').textContent = t('drive.saved', { time: `⁨${new Date(driveState.at).toLocaleString(currentLanguage())}⁩` }) // isolated, or bidi scrambles the date inside Arabic text;
  else $('driveStatus').textContent = t('drive.none');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.driveBackup) renderDriveState(changes.driveBackup.newValue);
});
chrome.storage.local.get('driveBackup').then(({ driveBackup }) => renderDriveState(driveBackup));
$('googleSignOutBtn').addEventListener('click', async () => {
  await signOutOfGoogle();
  account = null;
  renderAccount();
});
// A click outside the popup dismisses it — but never the click on one of its
// own triggers, which must be allowed to open it first.
document.addEventListener('click', (e) => {
  if (!$('accountMenu').hidden && !$('accountMenu').contains(e.target) && !$('accountBtn').contains(e.target) && !$('accountRowBtn').contains(e.target)) {
    $('accountMenu').hidden = true;
    accountInvoker = null;
  }
});
googleAccount().then((saved) => {
  account = saved;
  renderAccount();
});

// ---------- feedback and ratings ----------

const STORE_REVIEWS_URL = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
// Store installs carry update_url; an unpacked copy has no store page to review.
const fromStore = Boolean(chrome.runtime.getManifest().update_url);
let feedbackRating = 0;

async function ratingState() {
  try {
    return (await chrome.storage.local.get('reviewPrompt')).reviewPrompt ?? {};
  } catch {
    return {};
  }
}

async function saveRatingState(change) {
  await chrome.storage.local.set({ reviewPrompt: change(await ratingState()) });
}

/** Five star buttons; picking one calls onPick(n) and lights the stars up to n. */
function starRow(onPick) {
  const row = document.createElement('div');
  row.className = 'stars';
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.textContent = '★';
    star.setAttribute('aria-label', t('rate.star', { n }));
    star.addEventListener('click', () => {
      row.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('on', i < n));
      onPick(n);
    });
    row.append(star);
  }
  return row;
}

/** A signed-in user's feedback carries their Google email unless they typed another. */
function feedbackFields(message, rating, email = '') {
  return { message, rating, email: email || account?.email || '', version: chrome.runtime.getManifest().version, language: currentLanguage() };
}

async function askForRating() {
  if (!shouldAskForRating(await ratingState())) return;
  const card = add('msg rate-card', '');
  const question = document.createElement('span');
  question.textContent = t('rate.question');
  const close = iconButton(ICONS.close, t('rate.dismiss'), async () => {
    card.remove();
    await saveRatingState(afterDismissal);
  });
  const head = document.createElement('div');
  head.className = 'row between';
  head.append(question, close);
  const body = document.createElement('div');
  body.className = 'fields';
  card.append(head, starRow((n) => rated(n, body, close)), body);
}

async function rated(stars, body, close) {
  close.remove();
  await saveRatingState(afterRating);
  if (stars === 5) {
    body.replaceChildren(textLine(t('rate.thanks')));
    if (fromStore) {
      const link = Object.assign(document.createElement('a'), { href: STORE_REVIEWS_URL, target: '_blank', rel: 'noopener', textContent: t('rate.store') });
      body.append(link);
    }
    if (FEEDBACK_FORM_ID) sendFeedback(feedbackFields('', 5)).catch(() => {}); // a bare 5★ is a nice-to-know, not worth an error
    return;
  }
  const text = Object.assign(document.createElement('textarea'), { rows: 3, dir: 'auto', placeholder: t('rate.better') });
  const status = Object.assign(document.createElement('small'), { className: 'muted' });
  const send = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('feedback.send') });
  send.addEventListener('click', () => submitFeedback({ message: text.value.trim(), rating: stars }, status, () => body.replaceChildren(textLine(t('feedback.sent')))));
  const actions = document.createElement('div');
  actions.className = 'row between';
  actions.append(status, send);
  body.replaceChildren(text, actions);
  text.focus();
}

function textLine(text) {
  return Object.assign(document.createElement('span'), { textContent: text });
}

async function submitFeedback({ message, rating, email = '' }, status, onSent) {
  if (!message && !rating) {
    status.textContent = t('feedback.empty');
    return;
  }
  if (!FEEDBACK_FORM_ID) {
    status.textContent = t('feedback.notConfigured');
    return;
  }
  status.textContent = t('feedback.sending');
  try {
    await sendFeedback(feedbackFields(message, rating, email));
    onSent();
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
}

function toggleFeedbackMenu() {
  const opening = $('feedbackMenu').hidden;
  closeSessionMenu();
  closeOverflowMenu();
  $('accountMenu').hidden = true;
  $('feedbackMenu').hidden = !opening;
  if (!opening) return;
  feedbackRating = 0;
  $('feedbackStars').replaceWith(Object.assign(starRow((n) => { feedbackRating = n; }), { id: 'feedbackStars' }));
  $('feedbackStatus').textContent = '';
  if (account && !$('feedbackEmail').value) $('feedbackEmail').value = account.email;
  $('feedbackText').focus();
}

$('feedbackBtn').addEventListener('click', toggleFeedbackMenu);
$('feedbackSend').addEventListener('click', () => submitFeedback(
  { message: $('feedbackText').value.trim(), rating: feedbackRating, email: $('feedbackEmail').value.trim() },
  $('feedbackStatus'),
  () => {
    $('feedbackText').value = '';
    $('feedbackStatus').textContent = t('feedback.sent');
  },
));
document.addEventListener('click', (e) => {
  if (!$('feedbackMenu').hidden && !$('feedbackMenu').contains(e.target) && !$('feedbackBtn').contains(e.target)) $('feedbackMenu').hidden = true;
});

// ---------- language ----------

$('langBtn').addEventListener('click', async () => {
  closeOverflowMenu();
  const next = currentLanguage() === 'ar' ? 'en' : 'ar';
  await applyAndSaveLanguage(next);
});

// The same choice lives in the Language page: applied and saved at once, so
// the panel never shows a language the settings do not agree with. A save
// that did not go out changes nothing — the select says what is still saved.
$('uiLanguage').addEventListener('change', async () => {
  const value = $('uiLanguage').value;
  if (value === 'auto') {
    await applyAndSaveLanguage(resolveLanguage('auto', chrome.i18n.getUILanguage()), 'auto');
  } else if (value !== settings.uiLanguage) {
    await applyAndSaveLanguage(value, value);
  }
});

/**
 * Applies the interface language and saves it in the same breath. A failed
 * save leaves nothing half-done: the previous language is applied back and
 * the failure is shown where settings errors are readable.
 */
async function applyAndSaveLanguage(language, savedPreference = language) {
  try {
    await saveSettings((current) => ({ ...current, uiLanguage: savedPreference }));
    applyLanguage(language);
    $('uiLanguage').value = settings.uiLanguage;
  } catch (err) {
    applyLanguage(resolveLanguage(settings.uiLanguage, chrome.i18n.getUILanguage()));
    $('uiLanguage').value = settings.uiLanguage;
    // The failure has to be readable: where the language is configured.
    toggleSettings(true, 'language');
    showSettingsError(err.message);
    return;
  }
  renderSettingsSummaries();
}

/** Static text is retranslated by setLanguage; text this file renders is redrawn here. */
function applyLanguage(language) {
  setLanguage(language);
  // The words of the access control change; the mode the worker confirmed and
  // the chat it belongs to do not.
  accessUi.updateLanguage(t);
  // The words of the approvals change too; the requests that wait for an
  // answer do not.
  permissionUi.updateLanguage(approvalWords);
  renderAccessError();
  renderFiles();
  if (!settings) return;
  for (const provider of ACCOUNT_PROVIDERS) if (authState[provider]) showAuth(provider, authState[provider]);
  syncAuthFrames();
  updateChip();
  mainForm.rerender();
  fallbackForm.rerender();
  renderNotices();
  renderSessionTitle();
  syncFastProvider();
  syncFastFallback();
  renderDriveState();
  updateVoiceLabels();
  // The page the user is on says its name in the language they chose.
  settingsNav.show(settingsNav.section(), { focus: false });
  renderSettingsSummaries();
  markDirtyRefresh();
}

/** The dirty note follows the language too, without inventing an edit. */
function markDirtyRefresh() {
  if (settingsDirty) markDirty();
}

// ---------- settings ----------

/**
 * The shared approval region follows the active screen: docked above the
 * composer while the chat is on, above the voice input while voice is on,
 * and above the settings when the user is configuring. One region, one
 * authority — the node itself is moved, never copied.
 */
let approvalsHome = null;

function placeApprovals(where) {
  const node = $('approvals');
  if (!approvalsHome) approvalsHome = node.parentElement;
  const dock = where === 'voice' ? $('approvalsVoiceDock')
    : where === 'chat' ? $('approvalsChatDock')
      : null;
  (dock ?? approvalsHome)?.append?.(node);
}

/**
 * The panel has ONE compact header. It carries the session on the chat, and
 * becomes the focused page's header (back, title) in settings and voice, so
 * no screen ever stacks a second bar under the first.
 */
function syncHeaderContext() {
  const settingsOpen = !$('settingsView').hidden;
  const voiceOpen = !$('voiceView').hidden;
  $('brandCluster').hidden = settingsOpen || voiceOpen;
  $('settingsBarContext').hidden = !settingsOpen;
  $('voiceBarContext').hidden = !voiceOpen;
  $('newChatBtn').hidden = settingsOpen;
  $('settingsBtn').hidden = settingsOpen || voiceOpen;
  $('workspaceStopBtn').hidden = !ui.running || (!settingsOpen && !voiceOpen);
}

const keyStore = createKeyStore();
const saveSettings = createSettingsSaver({
  getSettings: () => settings,
  onSaved: (saved) => { settings = saved; },
  save: (next) => request('save-settings', { settings: next }),
});
const mainForm = createProviderForm($('mainProvider'), { request, getPresets: () => presets, keyStore, onChange: () => syncAuthFrames(), onModels: () => renderModelFields() });
const fallbackForm = createProviderForm($('fallbackProvider'), { request, getPresets: () => presets, keyStore, onChange: () => syncAuthFrames(), onModels: () => renderModelFields() });
keyStore.register($('fastApiKey'), () => $('fastProvider').value);
keyStore.register($('fastFallbackApiKey'), () => $('fastFallbackProvider').value);
// A provider's section shows that provider's sign-in, so the status of the one
// the user picks is asked for.
$('provider').addEventListener('change', () => {
  const provider = mainForm.provider();
  if (ACCOUNT_PROVIDERS.includes(provider)) refreshAuthState(provider).catch(() => {});
});

$('settingsBtn').addEventListener('click', () => toggleSettings(true));

// One focused settings page at a time: a searchable index, then a page per
// section. The forms are never rebuilt by moving around, so an unsaved edit
// survives walking from a page to the index and back.
const settingsNav = createSettingsNav({
  index: $('settingsIndex'),
  pages: {
    models: $('page-models'),
    'provider-main': $('page-provider-main'),
    'provider-backup': $('page-provider-backup'),
    fast: $('page-fast'),
    voice: $('page-voice'),
    behavior: $('page-behavior'),
    language: $('page-language'),
    account: $('page-account'),
  },
  title: $('settingsTitle'),
  titles: {
    null: () => t('settings.title'),
    models: () => t('sec.models'),
    'provider-main': () => t('sub.providerMain'),
    'provider-backup': () => t('sub.providerBackup'),
    fast: () => t('sec.fast'),
    voice: () => t('sec.voice'),
    behavior: () => t('sec.behavior'),
    language: () => t('sec.language'),
    account: () => t('sec.account'),
  },
  search: $('settingsSearch'),
  searchEmpty: $('settingsSearchEmpty'),
  rows: [...document.querySelectorAll('#settingsRows .settings-row')],
  onExit: () => toggleSettings(false),
});

// Every row opens its own page; the back arrow walks back out of them.
for (const row of document.querySelectorAll('.settings-row[data-section]')) {
  row.addEventListener('click', () => {
    settingsNav.show(row.dataset.section, { from: row });
    // A page's draft is what the footer saves; a dirty draft is offered its
    // way out on the index too.
    syncFooter();
  });
}
$('settingsSearch').addEventListener('input', () => settingsNav.filter($('settingsSearch').value));
$('settingsSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = [...document.querySelectorAll('#settingsRows .settings-row')].find((row) => !row.hidden);
  first?.click();
});

// Numbers each permission check; a newer check or a click on the switch makes an
// older answer stale, so it can never undo what the user just chose.
let notifyCheck = 0;

/** The switch as it works: saved on and still granted by Chrome (it can be revoked there). */
function syncNotifySwitch() {
  const check = ++notifyCheck;
  $('notify').checked = false;
  $('notifyNote').hidden = true;
  if (!settings?.notify) return;
  chrome.permissions.contains({ permissions: ['notifications'] }).then((granted) => {
    if (check === notifyCheck) $('notify').checked = granted;
  }, () => {});
}

/**
 * Opens or leaves the settings. The section names the page to land on, so the
 * panel can arrive straight at the main provider when no model is set up, or
 * at the voice engine from the voice screen.
 */
function toggleSettings(open, section = null) {
  // Closing, saved or not: the notifications permission follows the saved switch. One
  // granted for an edit that was not saved, or for a switch saved off, is given back.
  if (!open && settings) {
    if (!settings.notify) chrome.permissions.remove({ permissions: ['notifications'] }).catch(() => {});
    // The switch shows the saved choice again, so a later Save cannot store an
    // unsaved "on" whose permission was just given back.
    syncNotifySwitch();
  }
  if (open && settings) syncNotifySwitch(); // the permission may have been revoked in Chrome since
  // The voice screen is left for the settings: the microphone stops there.
  if (open) closeVoice();
  $('settingsView').hidden = !open;
  $('chatView').hidden = open;
  $('settingsError').hidden = true;
  // The header becomes the settings page's header, and the approvals wait
  // above the page where they can still be answered.
  syncHeaderContext();
  placeApprovals(open ? 'home' : 'chat');
  if (open) {
    settingsNav.show(section);
    $('settingsSearch').value = '';
    settingsNav.filter('');
    syncFooter();
    // The sign-in state may have changed while the panel was closed.
    refreshAuthStates().catch(() => {});
    mainForm.loadModels();
    if ($('fallbackEnabled').checked) fallbackForm.loadModels();
    loadFastModels();
    loadFastFallbackModels();
  } else {
    $('settingsBtn').focus();
  }
}

/**
 * One edit somewhere in the settings: the footer says so, and Cancel means
 * something as long as it does. The interface language is not part of the
 * draft — it is saved the moment it is chosen, like the header switch — and
 * neither are the transient sign-in fields (a device code, a pasted
 * auth.json), which are not settings at all.
 */
function markDirty() {
  settingsDirty = true;
  $('settingsDirty').hidden = false;
  $('settingsStatus').textContent = t('settings.dirty');
  syncFooter();
}

function markClean() {
  settingsDirty = false;
  $('settingsDirty').hidden = true;
  $('settingsStatus').textContent = '';
  syncFooter();
}

let settingsDirty = false;

// Fields that hold transient secrets, not settings: typing into them never
// invents a draft.
const NOT_A_SETTING_EDIT = '[data-auth], #authJson, .search-field';

// Any edit in any page marks the draft, wherever the user walks afterwards.
$('settingsView').addEventListener('input', (e) => {
  if (e.target.id === 'uiLanguage') return;
  if (e.target.closest?.(NOT_A_SETTING_EDIT)) return;
  markDirty();
  renderSettingsSummaries();
});
$('settingsView').addEventListener('change', (e) => {
  if (e.target.id === 'uiLanguage') return;
  if (e.target.closest?.(NOT_A_SETTING_EDIT)) return;
  markDirty();
  renderSettingsSummaries();
});

/**
 * The footer owns Save and Cancel wherever a draft can be: on every page, and
 * on the index too once an edit exists — a draft must not lose its way out
 * just because the user went back to the index.
 */
function syncFooter() {
  $('settingsFooter').hidden = settingsNav.section() === null && !settingsDirty;
}

async function init() {
  const data = await request('get-settings');
  settings = data.settings;
  presets = data.presets;
  fastPresets = data.fastPresets;
  setLanguage(resolveLanguage(settings.uiLanguage, chrome.i18n.getUILanguage()));
  // The access control is drawn again in the language the panel settled on.
  // The mode it shows is still the one the worker confirmed.
  accessUi.updateLanguage(t);
  // The same for the approvals: the words change, the requests do not.
  permissionUi.updateLanguage(approvalWords);
  renderDriveState();
  // The fast layer and its backup offer the same decision providers.
  const fastOptions = Object.entries(fastPresets).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
  $('fastProvider').innerHTML = fastOptions;
  $('fastFallbackProvider').innerHTML = fastOptions;
  fillForm();
  await refreshAuthStates();
  updateChip();
  renderSettingsSummaries();
  // No model to work with yet: the panel opens straight at the main provider,
  // so there is an obvious route to set one up.
  if (!activeModel()) toggleSettings(true, 'provider-main');
  mainForm.loadModels();
  loadFastModels();
}

// Tokens land in storage even when the worker that polled for them was restarted
// and its port to this panel is gone, so storage is the reliable sign-in signal.
// Every provider's credential has its own accountAuth.* key, and the keys that
// changed name the providers they belong to.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const providers = changedProviders(changes);
  if (!providers.length) return;
  for (const provider of providers) {
    const status = await request('auth-status', { provider }).catch(() => null);
    if (status) showAuth(provider, status);
  }
  // Only the slots that use these providers need their models again.
  for (const provider of providers) {
    if (mainForm.provider() === provider) mainForm.loadModels();
    if ($('fallbackEnabled').checked && fallbackForm.provider() === provider) fallbackForm.loadModels();
  }
});

function fillForm() {
  keyStore.load(settings.keys);
  mainForm.fill(settings);
  fallbackForm.fill(settings.fallback);
  $('fallbackEnabled').checked = settings.fallback.enabled;
  syncFallback();
  syncAuthFrames();
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  $('showCursor').checked = settings.showCursor;
  $('steerMode').value = settings.steerMode ?? 'next-step';
  syncNotifySwitch();
  $('replyLangEnabled').checked = settings.replyLanguage.enabled;
  $('replyLang').value = settings.replyLanguage.language;
  syncReplyLanguage();
  fillFastForm(settings.fast);
  if ($('voiceEngine')) $('voiceEngine').value = settings.voiceEngine ?? 'postora';
  $('uiLanguage').value = settings.uiLanguage ?? 'auto';
  syncRecommended();
  markClean();
  renderModelFields();
  renderSettingsSummaries();
}

// The tested free setup: offered up front until a provider is set up, then behind a link.
function syncRecommended(open = false) {
  const signedIn = Object.values(authState).some((state) => state?.connected);
  const configured = signedIn || Object.values(settings.keys ?? {}).some(Boolean) || Boolean(settings.compatible.apiKey);
  $('recommended').hidden = configured && !open;
  $('showRecommended').hidden = !$('recommended').hidden;
  $('recommendedNote').hidden = true;
}

// The store build has no run-JavaScript tool, so it has no switch for it either.
$('allowJavascript').closest('label').hidden = STORE_BUILD;

$('keyLinkMain').href = RECOMMENDED_SETUP.main.keyUrl;
$('keyLinkBackup').href = RECOMMENDED_SETUP.backup.keyUrl;
$('showRecommended').addEventListener('click', () => syncRecommended(true));

// Fills both provider forms through their own fill; keys go in the existing key
// fields, so the shared key store sees them. Nothing is saved until Save.
$('useRecommended').addEventListener('click', () => {
  const { main, fallback } = recommendedSlots(readForm(), presets);
  mainForm.fill(main);
  fallbackForm.fill(fallback);
  $('fallbackEnabled').checked = true;
  syncFallback();
  mainForm.loadModels();
  fallbackForm.loadModels();
  $('recommendedNote').hidden = false;
  const empty = [$('mainProvider'), $('fallbackProvider')].map((root) => root.querySelector('[data-field="apiKey"]')).find((input) => !input.value);
  empty?.focus();
});

function readForm() {
  const next = structuredClone(settings);
  Object.assign(next, mainForm.read());
  next.fallback = { ...fallbackForm.read(), enabled: $('fallbackEnabled').checked };
  next.fast = readFastForm();
  next.maxSteps = Number($('maxSteps').value) || 40;
  next.vision = $('vision').checked;
  next.allowJavascript = $('allowJavascript').checked;
  next.showCursor = $('showCursor').checked;
  next.steerMode = $('steerMode').value;
  next.notify = $('notify').checked;
  next.replyLanguage = { enabled: $('replyLangEnabled').checked, language: $('replyLang').value };
  next.voiceEngine = $('voiceEngine')?.value || 'postora';
  next.keys = keyStore.snapshot();
  return next;
}

// Off: the agent follows the language of the task, so the choice is hidden.
function syncReplyLanguage() {
  $('replyLangField').hidden = !$('replyLangEnabled').checked;
}

$('replyLangEnabled').addEventListener('change', syncReplyLanguage);

// The permission is asked for from the click itself (Chrome needs the gesture), and
// given back when the switch goes off. Notifications need both the switch and it.
$('notify').addEventListener('change', async () => {
  notifyCheck += 1; // the user's choice wins over any check still waiting
  const box = $('notify');
  $('notifyNote').hidden = true;
  if (box.checked) {
    const granted = await chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false);
    if (!granted) {
      box.checked = false;
      $('notifyNote').hidden = false;
    }
  } else {
    // Given back only once the switch is saved off (see toggleSettings), like the rest of this form.
  }
});

function syncFallback() {
  // The backup page stays reachable either way; the row that opens it only
  // means something while a backup is used.
  $('settingsRowBackup').hidden = !$('fallbackEnabled').checked;
}

$('fallbackEnabled').addEventListener('change', () => {
  syncFallback();
  if ($('fallbackEnabled').checked) fallbackForm.loadModels();
});

/** A provider saved before the list was limited to decision providers falls back to TypeSafe. */
function knownFastProvider(slot) {
  if (fastPresets[slot.provider]) return slot;
  const { baseUrl, model, minProb } = fastPresets.typesafe;
  return { ...slot, provider: 'typesafe', baseUrl, model, ...(slot.minProb !== undefined ? { minProb } : {}) };
}

function fillFastForm(saved) {
  loads.fast += 1;
  loads.fastFallback += 1;
  fastModels = [];
  fastFallbackModels = [];
  fastListState.fast = { loading: false, error: '' };
  fastListState.fastFallback = { loading: false, error: '' };
  const fast = { ...knownFastProvider(saved), fallback: knownFastProvider(saved.fallback) };
  $('fastEnabled').checked = fast.enabled;
  $('fastProvider').value = fast.provider;
  $('fastMode').value = fast.mode;
  $('fastApiKey').value = fast.apiKey;
  keyStore.refresh($('fastApiKey'));
  $('fastModel').value = fast.model;
  $('fastBaseUrl').value = fast.baseUrl;
  $('fastMinProb').value = fast.minProb;
  $('fastRiskyMax').value = fast.riskyMax;
  $('fastFallbackEnabled').checked = fast.fallback.enabled;
  $('fastFallbackProvider').value = fast.fallback.provider;
  $('fastFallbackApiKey').value = fast.fallback.apiKey;
  keyStore.refresh($('fastFallbackApiKey'));
  $('fastFallbackModel').value = fast.fallback.model;
  syncFast();
  syncFastProvider();
  syncFastFallback();
}

function readFastForm() {
  const provider = $('fastProvider').value;
  const preset = fastPresets[provider] ?? {};
  const model = $('fastModel').value.trim() || preset.model;
  return {
    enabled: $('fastEnabled').checked,
    mode: $('fastMode').value,
    provider,
    decision: isDecisionModel(provider, model),
    apiKey: $('fastApiKey').value.trim(),
    model,
    baseUrl: $('fastBaseUrl').value.trim() || preset.baseUrl,
    minProb: Number($('fastMinProb').value) || preset.minProb,
    riskyMax: Number($('fastRiskyMax').value) || 0.3,
    fallback: readFastFallback(),
  };
}

// Backups are decision providers only, so the base URL is the preset's.
function readFastFallback() {
  const provider = $('fastFallbackProvider').value;
  const preset = fastPresets[provider] ?? {};
  return {
    enabled: $('fastFallbackEnabled').checked,
    provider,
    baseUrl: preset.baseUrl,
    apiKey: $('fastFallbackApiKey').value.trim(),
    model: $('fastFallbackModel').value.trim() || preset.model,
    decision: true,
  };
}

// The fast list only holds decision models; a typed id counts as one when it is
// the preset's default (list not loaded yet) or was saved as one before.
function isDecisionModel(provider, model) {
  if (fastModels.some((m) => m.id === model)) return true;
  const preset = fastPresets[provider] ?? {};
  if (model === preset.model) return Boolean(preset.decision);
  return settings.fast.provider === provider && settings.fast.model === model && Boolean(settings.fast.decision);
}

function syncFast() {
  $('fastFields').hidden = !$('fastEnabled').checked;
  $('fastFallbackFrame').hidden = !$('fastEnabled').checked; // a backup for a layer that is off means nothing
}

// TypeSafe has no model list; the other decision providers list theirs. The
// model button shows what is set, and the shared dialog does the choosing.
function syncFastProvider() {
  renderModelFields();
}

function syncFastFallback() {
  $('fastFallbackFields').hidden = !$('fastFallbackEnabled').checked;
  renderModelFields();
}

$('fastEnabled').addEventListener('change', () => {
  syncFast();
  loadFastModels();
  loadFastFallbackModels();
});
$('fastProvider').addEventListener('change', () => {
  const preset = fastPresets[$('fastProvider').value];
  $('fastBaseUrl').value = preset.baseUrl;
  $('fastModel').value = preset.model;
  $('fastMinProb').value = preset.minProb;
  keyStore.show($('fastApiKey'), $('fastProvider').value);
  fastModels = [];
  syncFastProvider();
  loadFastModels();
});

$('fastFallbackEnabled').addEventListener('change', () => {
  syncFastFallback();
  loadFastFallbackModels();
});
$('fastFallbackProvider').addEventListener('change', () => {
  $('fastFallbackModel').value = fastPresets[$('fastFallbackProvider').value].model;
  keyStore.show($('fastFallbackApiKey'), $('fastFallbackProvider').value);
  fastFallbackModels = [];
  syncFastFallback();
  loadFastFallbackModels();
});

async function loadFastModels(showErrors = false) {
  const config = readFastForm();
  const load = ++loads.fast;
  fastModels = [];
  if (!config.enabled || config.provider === 'typesafe') {
    fastListState.fast = { loading: false, error: '' };
    modelDialog.update();
    return;
  }
  fastListState.fast = { loading: true, error: '' };
  modelDialog.update();
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fast) return;
    fastModels = list;
    fastListState.fast = { loading: false, error: '' };
    syncFastProvider();
    showFastStatus('', '');
  } catch (err) {
    if (load !== loads.fast) return;
    fastListState.fast = { loading: false, error: showErrors ? err.message : t('model.fallback') };
    if (showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
  modelDialog.update();
}

async function loadFastFallbackModels(showErrors = false) {
  const config = readFastFallback();
  const load = ++loads.fastFallback;
  fastFallbackModels = [];
  if (!$('fastEnabled').checked || !config.enabled || config.provider === 'typesafe') {
    fastListState.fastFallback = { loading: false, error: '' };
    modelDialog.update();
    return;
  }
  fastListState.fastFallback = { loading: true, error: '' };
  modelDialog.update();
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fastFallback) return;
    fastFallbackModels = list;
    fastListState.fastFallback = { loading: false, error: '' };
    syncFastFallback();
  } catch (err) {
    if (load !== loads.fastFallback) return;
    fastListState.fastFallback = { loading: false, error: showErrors ? err.message : t('model.fallback') };
    if (showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
  modelDialog.update();
}

async function testFast(config) {
  const started = performance.now();
  const { model } = await request('fast-test', { config });
  return t('fast.testOk', { model, ms: Math.round(performance.now() - started) });
}

/** state: 'ok' (green), 'fail' (red) or '' (neutral); model-list errors use it too. */
const showFastStatus = bindTestButton({ button: $('fastTestBtn'), result: $('fastTestResult'), scope: $('fastFields'), run: () => testFast(readFastForm()) });
const showFastFallbackStatus = bindTestButton({ button: $('fastFallbackTestBtn'), result: $('fastFallbackTestResult'), scope: $('fastFallbackFields'), run: () => testFast(readFastFallback()) });

$('exportBtn').addEventListener('click', async () => {
  try {
    const data = await request('backup-export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `browser-agent-backup-${data.exportedAt.slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000); // revoking at once can cancel the download
    showBackupStatus('ok', t('backup.exported'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err.message}`);
  }
});
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async () => {
  const [file] = $('restoreFile').files;
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await showRestoredSettings(await request('backup-import', { data }));
    showBackupStatus('ok', t('backup.restored'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err instanceof SyntaxError ? t('backup.notJson') : err.message}`);
  } finally {
    $('restoreFile').value = '';
  }
});

/** After a restore from a file or from Drive, the settings view shows what was restored. */
async function showRestoredSettings(restored) {
  settings = restored;
  fillForm();
  updateChip();
  await refreshAuthStates();
  mainForm.loadModels();
}

function showBackupStatus(state, text) {
  $('backupResult').dataset.state = state;
  $('backupResult').textContent = text;
}

function currentProviderSettings(s = settings) {
  return slotSettings(s);
}

function activeModel() {
  return currentProviderSettings().model;
}

// ---------- the model dialog ----------
//
// One dialog serves every model field: the quick control beside the composer
// and the four settings slots. The fields stay the canonical state — the
// dialog only reads what the field holds and applies what was picked, and the
// quick control saves through the same path the Save button uses.

const modelDialog = createModelDialog({
  dialog: $('modelDialog'),
  title: $('modelDialogTitle'),
  searchRow: $('modelDialogSearchField'),
  search: $('modelDialogSearch'),
  list: $('modelDialogList'),
  empty: $('modelDialogEmpty'),
  status: $('modelDialogStatus'),
  manual: $('modelDialogManual'),
  manualInput: $('modelDialogManualInput'),
  manualSave: $('modelDialogManualSave'),
  manualBtn: $('modelDialogManualBtn'),
  refresh: $('modelDialogRefresh'),
  configure: $('modelDialogConfigure'),
  close: $('modelDialogClose'),
  hint: $('modelDialogHint'),
});

/** The provider label the summaries show for a slot's provider choice. */
function providerLabel(provider, presetId) {
  if (provider === 'compatible') return presets[presetId ?? 'custom']?.label ?? t('settings.provider.compatible');
  return PROVIDER_LABELS[provider] ?? 'API';
}

/** The main slot's preset, read from its own select. */
const mainPreset = () => document.querySelector('#mainProvider [data-field="preset"]')?.value ?? '';
const backupPreset = () => document.querySelector('#fallbackProvider [data-field="preset"]')?.value ?? '';

/**
 * The index summaries say what each section is set to right now — the draft,
 * not just the saved values, so a row never lies about the page behind it.
 */
function renderSettingsSummaries() {
  if (!settings) return;
  const mainModel = mainForm.model();
  const backupOn = $('fallbackEnabled').checked;
  const backupModel = backupOn ? fallbackForm.model() : '';
  $('sumModels').textContent = [
    mainModel || t('model.none'),
    backupOn ? (backupModel ? t('sum.backupOn') : t('sum.backupOff')) : t('sum.backupOff'),
  ].join(' · ');
  $('sumMain').textContent = [mainModel || t('model.none'), providerLabel(mainForm.provider(), mainPreset())].join(' · ');
  $('sumBackup').textContent = backupOn
    ? [backupModel || t('model.none'), providerLabel(fallbackForm.provider(), backupPreset())].join(' · ')
    : t('sum.off');
  const fastOn = $('fastEnabled').checked;
  $('sumFast').textContent = fastOn
    ? [
        fastPresets[$('fastProvider').value]?.label ?? $('fastProvider').value,
        $('fastMode').selectedOptions[0]?.textContent ?? '',
      ].filter(Boolean).join(' · ')
    : t('sum.off');
  $('sumVoice').textContent = $('voiceEngine').value === 'fast_only' ? t('voice.engineFastOnly') : t('voice.enginePostora');
  $('sumBehavior').textContent = `${t('sum.behavior', { n: $('maxSteps').value || settings.maxSteps })} · ${$('vision').checked ? t('sum.visionOn') : t('sum.visionOff')}`;
  const ui = $('uiLanguage').value;
  const uiName = ui === 'auto' ? t('lang.auto') : ui === 'ar' ? 'العربية' : 'English';
  const reply = $('replyLangEnabled').checked ? ($('replyLang').value === 'ar' ? 'العربية' : 'English') : t('lang.auto');
  $('sumLanguage').textContent = `${uiName} · ${reply}`;
  $('sumAccount').textContent = $('sumAccountRow').textContent = account?.email || t('sum.notSignedIn');
}

/** Every model button shows the model its field holds right now. */
function renderModelFields() {
  const main = mainForm.model();
  const backup = fallbackForm.model();
  $('modelMainLabel').textContent = main || t('model.pick');
  $('modelBackupLabel').textContent = backup || t('model.pick');
  $('modelFastLabel').textContent = $('fastModel').value || t('model.pick');
  $('modelFastBackupLabel').textContent = $('fastFallbackModel').value || t('model.pick');
  modelDialog.update();
}

/**
 * The saved chat's own settings with one model swapped in. The quick control
 * saves only this — the model and the effort that goes with it — never the
 * draft the user may have left unsaved on a settings page.
 */
function quickModelSettings(current, id, effort) {
  const next = structuredClone(current);
  const slot = currentProviderSettings(next);
  slot.model = id;
  slot.effort = effort;
  return next;
}

/** A queued pick belongs to the connection whose catalog the user saw. */
function modelConnectionKey(value) {
  const { model, effort, ...connection } = currentProviderSettings(value);
  return JSON.stringify({ provider: value.provider, connection });
}

/**
 * The quick control saved a model: the saved chat keeps its own provider and
 * model as the source of truth, the save round trip is the real one, and an
 * unrelated draft (steps, keys, provider, language, fast layer) is left
 * exactly as the user left it — still unsaved, still marked dirty.
 */
async function saveQuickModel(id, effort) {
  const owner = modelConnectionKey(settings);
  const draft = mainForm.read();
  const draftSlot = currentProviderSettings(draft);
  const savedSlot = currentProviderSettings();
  const sameConnection = draft.provider === settings.provider
    && (draft.provider !== 'claude' || draft.claude.auth === settings.claude.auth)
    && (draft.provider !== 'kimi' || draft.kimi.auth === settings.kimi.auth)
    && (draft.provider !== 'compatible' || (draft.compatible.preset === settings.compatible.preset && draft.compatible.baseUrl === settings.compatible.baseUrl));
  const syncDraft = sameConnection && draftSlot.model === savedSlot.model && draftSlot.effort === savedSlot.effort;
  const next = quickModelSettings(settings, id, effort);
  const problem = settingsProblem(next);
  if (problem) {
    toggleSettings(true, problemPage(problem));
    showSettingsError(t(problem));
    return;
  }
  try {
    await saveSettings((current) => modelConnectionKey(current) !== owner || currentProviderSettings(current).model === id
      ? current : quickModelSettings(current, id, effort));
    if (modelConnectionKey(settings) === owner && currentProviderSettings().model === id
      && syncDraft && JSON.stringify(mainForm.read()) === JSON.stringify(draft)) mainForm.chooseModel(id, currentProviderSettings().effort);
    updateChip();
    renderSettingsSummaries();
  } catch (err) {
    // The save did not go out: the saved chat keeps its old model, the draft
    // keeps its edits, and the failure is readable where models are edited.
    toggleSettings(true, 'provider-main');
    showSettingsError(err.message);
  }
}

/** Where a validation failure is readable: the page that owns the field. */
function problemPage(problem) {
  if (problem.startsWith('err.fast')) return 'fast';
  if (problem === 'err.pickReplyLanguage') return 'language';
  if (['err.fallbackModel', 'err.fallbackAnthropicKey', 'err.fallbackGeminiKey', 'err.fallbackKimiKey'].includes(problem)) return 'provider-backup';
  return 'provider-main';
}

// The quick control serves the provider that is SAVED, not a draft one: while
// a settings page drafts another provider, the list here is loaded for the
// saved one on its own.
let quickModels = [];
let quickLoading = false;
let quickError = '';
let quickLoad = 0;

/** The quick catalog belongs only to the saved connection, never the draft. */
function quickModelsFor() {
  return quickModels;
}

async function loadQuickModels(showErrors = false) {
  if (!settings) return;
  const load = ++quickLoad;
  quickModels = [];
  quickLoading = true;
  quickError = '';
  modelDialog.update();
  try {
    const list = await request('list-models', { settings });
    if (load !== quickLoad) return;
    quickModels = list;
    quickLoading = false;
    modelDialog.update();
  } catch (err) {
    if (load !== quickLoad) return;
    quickLoading = false;
    quickError = showErrors ? err.message : t('model.fallback');
    modelDialog.update();
  }
}

/** The effort that goes with a picked model: the list's own default, else none. */
const effortOf = (list, id) => list.find((m) => m.id === id)?.defaultEffort ?? '';

/** The one field a dialog open works on, and where its choice lands. */
const MODEL_SLOTS = {
  quick: {
    title: () => t('model.pickTitle'),
    // The saved model, not a drafted one: the quick control edits what runs now.
    current: () => currentProviderSettings().model,
    models: () => quickModelsFor(),
    manualOnly: () => false,
    loading: () => quickLoading,
    error: () => quickError,
    onOpen: () => {
      loadQuickModels();
    },
    apply: () => {},
    refresh: () => loadQuickModels(true),
    configure: () => toggleSettings(true, 'provider-main'),
    after: (id) => saveQuickModel(id, effortOf(quickModelsFor(), id)),
  },
  main: {
    title: () => t('sub.providerMain'),
    current: () => mainForm.model(),
    models: () => mainForm.list(),
    manualOnly: () => false,
    loading: () => mainForm.status().loading,
    error: () => mainForm.status().error,
    apply: (id) => mainForm.chooseModel(id),
    refresh: () => mainForm.loadModels(true),
    after: () => {
      markDirty();
      renderModelFields();
      renderSettingsSummaries();
    },
  },
  backup: {
    title: () => t('sub.backupModel'),
    current: () => fallbackForm.model(),
    models: () => fallbackForm.list(),
    manualOnly: () => false,
    loading: () => fallbackForm.status().loading,
    error: () => fallbackForm.status().error,
    apply: (id) => fallbackForm.chooseModel(id),
    refresh: () => fallbackForm.loadModels(true),
    after: () => {
      markDirty();
      renderModelFields();
      renderSettingsSummaries();
    },
  },
  fast: {
    title: () => t('fast.title'),
    current: () => $('fastModel').value,
    models: () => fastModels,
    // TypeSafe serves no list: the id is typed, as the field always allowed.
    manualOnly: () => $('fastProvider').value === 'typesafe',
    loading: () => fastListState.fast.loading,
    error: () => fastListState.fast.error,
    apply: (id) => {
      if ($('fastModel').value !== id) showFastStatus('', '');
      $('fastModel').value = id;
    },
    refresh: () => loadFastModels(true),
    after: () => {
      markDirty();
      renderModelFields();
      renderSettingsSummaries();
    },
  },
  fastBackup: {
    title: () => t('fast.fallbackTitle'),
    current: () => $('fastFallbackModel').value,
    models: () => fastFallbackModels,
    manualOnly: () => $('fastFallbackProvider').value === 'typesafe',
    loading: () => fastListState.fastFallback.loading,
    error: () => fastListState.fastFallback.error,
    apply: (id) => {
      if ($('fastFallbackModel').value !== id) showFastFallbackStatus('', '');
      $('fastFallbackModel').value = id;
    },
    refresh: () => loadFastFallbackModels(true),
    after: () => {
      markDirty();
      renderModelFields();
      renderSettingsSummaries();
    },
  },
};

function openModelSlot(slot) {
  const conf = MODEL_SLOTS[slot];
  modelDialog.open({
    title: conf.title,
    get: () => ({
      current: conf.current(),
      models: conf.models(),
      manualOnly: conf.manualOnly(),
      loading: conf.loading?.() ?? false,
      error: conf.error?.() ?? '',
    }),
    onOpen: () => conf.onOpen?.(),
    onPick: (id) => {
      conf.apply(id);
      conf.after(id);
    },
    onManual: (id) => {
      conf.apply(id);
      conf.after(id);
    },
    onRefresh: conf.refresh ? async () => {
      await conf.refresh();
      renderModelFields();
      modelDialog.update();
    } : null,
    ...(conf.configure ? { onConfigure: conf.configure } : {}),
  });
}

$('modelQuickBtn').addEventListener('click', () => openModelSlot('quick'));
$('modelBtnMain').addEventListener('click', () => openModelSlot('main'));
$('modelBtnBackup').addEventListener('click', () => openModelSlot('backup'));
$('modelBtnFast').addEventListener('click', () => openModelSlot('fast'));
$('modelBtnFastBackup').addEventListener('click', () => openModelSlot('fastBackup'));

// ---------- account sign-in ----------

/**
 * The element that holds a provider's sign-in controls, or null when no frame
 * shows it: the main frame shows the provider of the main slot, the backup
 * frame shows its own provider when the main one does not.
 */
function authRoot(provider) {
  const main = $('mainProvider').querySelector(`[data-provider="${provider}"]`);
  if (main && mainForm.provider() === provider && (provider !== 'kimi' || mainForm.kimi().auth === 'account')) return main;
  const backup = $('fallbackProvider').querySelector('[data-field="fallbackAuth"]');
  if (backup && backup.dataset.provider === provider) return backup;
  return null;
}

/** An element of a provider's sign-in controls. */
function authEl(provider, name) {
  const root = authRoot(provider);
  return root ? root.querySelector(`[data-auth="${name}"]`) : null;
}

/** The provider whose sign-in controls an element belongs to. */
function providerOfBlock(element) {
  return element.closest('[data-provider]')?.dataset.provider ?? '';
}

/** What the panel shows about one provider's sign-in. */
function showAuth(provider, status) {
  const state = status ?? { connected: false, provider };
  authState[provider] = state;
  const view = authView(provider, state, authAttempt[provider], authNote[provider]);
  authAttempt[provider] = view.attempt;
  authNote[provider] = view.message;
  drawAuth(provider, view);
  if (settings) syncRecommended();
}

/** Draws a provider's sign-in controls from what the view says. */
function drawAuth(provider, view) {
  const root = authRoot(provider);
  if (!root) return;
  const el = (name) => root.querySelector(`[data-auth="${name}"]`);
  const status = el('status');
  if (status) status.textContent = view.status;
  const login = el('login');
  if (login) login.hidden = view.connected;
  const logout = el('logout');
  if (logout) logout.hidden = !view.connected;
  const device = el('device');
  if (device) {
    if (view.deviceCode) {
      const code = el('deviceCode');
      if (code) code.textContent = view.deviceCode;
      const link = el('deviceLink');
      if (link && view.verificationUrl) link.href = view.verificationUrl;
      device.hidden = false;
    } else {
      device.hidden = true;
    }
  }
  const codeBox = el('code');
  if (codeBox) codeBox.hidden = !view.needsCode;
  const message = el('message');
  if (message) {
    message.textContent = view.message;
    message.hidden = !view.message;
  }
}

/** The message a provider's section shows under its sign-in buttons. */
function setAuthMessage(provider, text) {
  // A signed-in provider has nothing to complain about.
  const connected = Boolean(authState[provider]?.connected);
  authNote[provider] = connected ? '' : (text ?? '');
  const box = authEl(provider, 'message');
  if (!box) return;
  box.textContent = authNote[provider];
  box.hidden = !authNote[provider];
}

/** The device code of a sign-in, when the provider gave one. */
function showDeviceCode(provider, code, url) {
  const box = authEl(provider, 'device');
  if (!box) return;
  if (!code) {
    box.hidden = true;
    return;
  }
  const shown = authEl(provider, 'deviceCode');
  if (shown) shown.textContent = code;
  const link = authEl(provider, 'deviceLink');
  if (link && url) link.href = url;
  box.hidden = false;
}

/** The field the code the provider's page shows is pasted into. */
function showCodePrompt(provider, visible) {
  const box = authEl(provider, 'code');
  if (!box) return;
  box.hidden = !visible;
  // Keep the field on screen. The settings page is long, and scrolling to the
  // error at its bottom hides the field the code was just pasted into.
  if (visible) box.scrollIntoView({ block: 'nearest' });
}

/** A sign-in that failed: the section says why, in the panel's language. */
function showAuthError(provider, message, code) {
  authAttempt[provider] = null;
  showDeviceCode(provider, null);
  showCodePrompt(provider, false);
  setAuthMessage(provider, authMessage(code, message));
  const box = authEl(provider, 'message');
  if (box) box.scrollIntoView({ block: 'nearest' });
}

/** Draws every provider whose state the panel knows, after the frames changed. */
function redrawAuth() {
  for (const provider of ACCOUNT_PROVIDERS) {
    if (!authState[provider]) continue;
    const view = authView(provider, authState[provider], authAttempt[provider], authNote[provider]);
    authAttempt[provider] = view.attempt;
    authNote[provider] = view.message;
    drawAuth(provider, view);
  }
}

/**
 * Shows the sign-in each frame needs: the main one for the main slot, and the
 * backup's own when the main frame does not show that provider.
 */
function syncAuthFrames() {
  const view = backupAuthView({
    main: mainForm.provider(),
    backup: fallbackForm.provider(),
    claudeAuth: fallbackForm.claude().auth,
    kimiAuth: fallbackForm.kimi().auth,
    mainKimiAuth: mainForm.kimi().auth,
  });
  const note = $('fallbackProvider').querySelector('[data-field="accountNote"]');
  if (note) note.hidden = !view.note;
  const block = $('fallbackProvider').querySelector('[data-field="fallbackAuth"]');
  if (!block) return;
  block.hidden = !view.signIn;
  block.dataset.provider = view.signIn ?? '';
  const login = block.querySelector('[data-auth="login"]');
  if (login && view.signIn) login.textContent = t(`auth.login.${view.signIn}`);
  // The blocks moved: what each provider shows is drawn again.
  redrawAuth();
}

/** The status of one provider, from the worker. */
async function refreshAuthState(provider) {
  const status = await request('auth-status', { provider });
  showAuth(provider, status);
  return status;
}

/** The status of every account provider, from the worker. */
async function refreshAuthStates() {
  const statuses = await Promise.all(ACCOUNT_PROVIDERS.map((provider) => request('auth-status', { provider }).catch(() => null)));
  ACCOUNT_PROVIDERS.forEach((provider, i) => { if (statuses[i]) showAuth(provider, statuses[i]); });
}

/**
 * Opens the port a sign-in's events come on. The port closed with a worker
 * that stopped while the panel stayed open, and the worker the request wakes
 * would post a failure, the code prompt and the device code to no panel.
 * A session still being picked has no id to connect with yet, as in send().
 */
async function listenForSignIn() {
  while (picking) await picking.catch(() => {});
  if (!port && sessionId) connect();
}

async function startLogin(provider) {
  $('settingsError').hidden = true;
  setAuthMessage(provider, '');
  await listenForSignIn();
  try {
    const { userCode, verificationUrl } = await request('auth-start', { provider });
    if (userCode) showDeviceCode(provider, userCode, verificationUrl);
  } catch (err) {
    // The worker names the failure with a stable code; the panel shows its own
    // wording for it, the same one the auth-error message carries.
    setAuthMessage(provider, authMessage(err.code, err.message));
    showSettingsError(authNote[provider]);
  }
}

async function signOutProvider(provider) {
  try {
    showAuth(provider, await request('auth-logout', { provider }));
  } catch (err) {
    showSettingsError(err.message);
  }
}

async function cancelLogin(provider) {
  await request('auth-cancel', { provider }).catch(() => {});
  authAttempt[provider] = null;
  showDeviceCode(provider, null);
  showCodePrompt(provider, false);
  setAuthMessage(provider, '');
}

async function submitCode(provider) {
  const input = authEl(provider, 'codeInput');
  const value = input?.value.trim() ?? '';
  if (!value) return;
  try {
    await request('auth-input', { provider, attemptId: authAttempt[provider], value });
    if (input) input.value = '';
  } catch (err) {
    setAuthMessage(provider, authMessage(err.code, err.message));
    // The attempt may be gone: the status says whether it is still running.
    refreshAuthState(provider).catch(() => {});
  }
}

for (const name of ['login', 'logout', 'cancel', 'codeSubmit']) {
  for (const button of document.querySelectorAll(`[data-auth="${name}"]`)) {
    button.addEventListener('click', () => {
      const provider = providerOfBlock(button);
      if (!provider) return;
      if (name === 'login') startLogin(provider);
      else if (name === 'logout') signOutProvider(provider);
      else if (name === 'cancel') cancelLogin(provider);
      else submitCode(provider);
    });
  }
}

$('importBtn').addEventListener('click', async () => {
  try {
    showAuth('chatgpt', await request('auth-import', { text: $('authJson').value }));
    $('authJson').value = '';
    mainForm.loadModels(true);
  } catch (err) {
    showSettingsError(err.message);
  }
});

// Back walks out of a page to its parent, and out of the index to the chat.
// The draft is kept either way: returning to settings shows it again.
$('closeSettingsBtn').addEventListener('click', () => {
  if (settingsNav.back()) return;
  syncFooter();
});

// Cancel is deliberate: the draft is thrown away, back to the saved values,
// and settings closes. Nothing unsaved survives it by accident.
$('cancelSettingsBtn').addEventListener('click', () => {
  fillForm();
  syncAuthFrames();
  redrawAuth();
  toggleSettings(false);
});

$('saveBtn').addEventListener('click', async () => {
  const next = readForm();
  const problem = settingsProblem(next);
  if (problem) {
    settingsNav.show(problemPage(problem), { focus: false });
    syncFooter();
    showSettingsError(t(problem));
    return;
  }
  $('saveBtn').disabled = true;
  const edits = settingsEdits(settings, next);
  try {
    await saveSettings(edits);
    fillForm();
    updateChip();
    toggleSettings(false);
  } catch (err) {
    showSettingsError(err.message);
  } finally {
    $('saveBtn').disabled = false;
  }
});

// Escape's topmost-surface order is handled by the one document keydown
// listener up in the menus section: dialogs first, then menus, then settings.

function updateChip() {
  const p = currentProviderSettings();
  const label = PROVIDER_LABELS[settings.provider] ?? presets[settings.compatible.preset]?.label ?? 'API';
  const fastTag = settings.fast.enabled && settings.fast.apiKey ? ' · ⚡' : '';
  const text = p.model ? `${p.model}${p.effort ? ` · ${p.effort}` : ''}` : t('model.none');
  const control = $('modelQuickLabel');
  control.textContent = text;
  $('modelQuickBtn').title = p.model ? `${label} · ${text}${fastTag}` : t('model.none');
  $('modelQuickBtn').setAttribute('aria-label', $('modelQuickBtn').title);
  renderModelFields();
}

function showSettingsError(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = false;
  $('settingsError').scrollIntoView({ block: 'nearest' });
}

pick(startSessions).catch((err) => showSettingsError(err.message));
init().catch((err) => showSettingsError(err.message));
// The chat is the first screen: its docks are wired before anything arrives.
placeApprovals('chat');
syncHeaderContext();
