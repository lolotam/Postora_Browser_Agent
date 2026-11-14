// One session's runtime: its transcript, its model session, its running task and
// its browser controller (tab group). Several runners can run tasks at once.
// Storage stays the source of truth, so a runner can be dropped and rebuilt.

import { runAgent } from '../agent/agent.js';
import { createFastAsk, createModelSession, modelSessionKey } from '../agent/model-session.js';
import { describeTabContext, replyLanguageReminder } from '../agent/prompt.js';
import { createToolExecutor, toolDefinitions } from '../agent/tools.js';
import { BrowserController } from '../browser/controller.js';
import { Notebook } from '../agent/notebook.js';
import { createFastLayer } from '../fast/fast-layer.js';
import { AccessAuthority, ALLOW, ASK_FIRST, DENY, FULL_ACCESS } from '../permissions/policy.js';
import { isSidePanelSender } from '../permissions/panel-sender.js';
import { autoCompactDue, compactPrompt, lastInputTokens, parseCompactCommand } from '../sessions/compaction.js';
import { checkpointFor, conversationHistory } from '../sessions/continuation.js';
import { effectiveSettings, loadSettings } from '../lib/settings.js';
import { normalizeUsage } from '../lib/usage.js';
import { clearNotification, notifyTransition } from './notifications.js';
import * as store from '../sessions/store.js';
import * as voiceClaims from '../sessions/voice-claims.js';
// @store-strip-start
import { nativeRequest } from '../native/client.js';
// @store-strip-end

const SAVE_DELAY_MS = 500;
const KEEP_ALIVE_MS = 20000;
// How far past the automatic threshold a conversation may grow while "queue" postpones the compaction.
const POSTPONE_LIMIT = 1.5;
const STREAMING = new Set(['text-delta', 'reasoning-delta', 'text-reset', 'compacting']);

// The events that describe the state of the worker at this moment and are
// never a moment of the conversation: a mode, a question and the way it
// ended. They are shown, they are never stored and never replayed as chat.
const TRANSIENT_EVENTS = new Set(['access-state', 'access-request', 'access-request-settled']);

// The one page of this extension that may ask for the access mode. The check
// is exact: the side panel of this extension, and nothing else.

/**
 * The site a target is on, without its path, its query or its fragment.
 *
 * A preview names the site and nothing more: a URL that carries a search or
 * a token in its query does not belong in a panel that may be on screen.
 */
function safeOrigin(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * The name the page gave its own element, as short as a preview can hold.
 *
 * The name is not a value: the browser captures the name of an element and
 * never what is written in it, so a field that holds a secret is named and
 * not quoted. A label is still text the page chose, so it is shortened and
 * never longer than a preview can show.
 */
function safeLabel(label) {
  if (typeof label !== 'string') return null;
  const clean = label.replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || null;
}

/**
 * True for a port that our own side panel opened.
 *
 * The sender must be this extension and this page: not another extension, not
 * the microphone window, not the background page, and not a page whose URL
 * merely starts with the same words.
 */
function ownSidePanel(port) {
  return isSidePanelSender(port?.sender);
}

/**
 * Whether the port belongs to this session.
 *
 * A panel names its port 'panel:<session>' or 'panel:<session>:<panel>'. A
 * port that names another session is not this session's panel, whatever else
 * about it looks right. A client that names no port at all is bound by the
 * runner it attached to.
 */
function portBoundToSession(port, sessionId) {
  const name = typeof port?.name === 'string' ? port.name : '';
  if (!name) return true;
  if (!name.startsWith('panel:')) return false;
  const rest = name.slice('panel:'.length);
  const cut = rest.indexOf(':');
  return (cut === -1 ? rest : rest.slice(0, cut)) === sessionId;
}

export class SessionRunner {
  constructor({ meta, body, color, isTakenByOther, onSessionsChanged }) {
    this.id = meta.id;
    this.continuation = checkpointFor(body);
    this.title = meta.title;
    this.project = body.project ?? null;
    this.projectRequest = 0;
    this.titled = meta.titled;
    // The access mode is the state of the worker, not a moment of the
    // conversation: it is never a part of the transcript, and an event of
    // that kind stored by an older version is not brought back.
    this.transcript = (body.transcript ?? []).filter((event) => !TRANSIENT_EVENTS.has(event?.type));
    this.storedLog = body.log;
    this.notebook = Notebook.from(body.notebook); // kept for follow-up tasks and reopening
    // Messages sent while a task runs: { id, text, model, images, mode, now }.
    // `text` is the short line in the chat; `model` is the full file text.
    this.inbox = Array.isArray(body.pending) ? body.pending : [];
    this.turnAbort = null;
    this.autoCompactBlocked = false; // a failed automatic compaction is not retried in the same task
    this.awaitingShrink = false; // an automatic compaction happened and its effect is not measured yet
    this.onSessionsChanged = onSessionsChanged;
    this.ports = new Set();
    // The live panels that may ask for the access mode, and the listeners
    // this runner left on each port, so a port that goes away takes its
    // listener with it.
    this.trustedPorts = new Set();
    this.portHandlers = new Map();
    this.session = null;
    this.sessionKey = null;
    this.sessionMode = null; // the mode the model session was built for
    this.abort = null;
    this.pendingQuestion = null;
    this.saveTimer = null;
    this.disposed = false;
    this.notified = new Set(); // transitions of the current task already notified
    this.asks = 0;
    this.askNotices = []; // "needs your answer" notifications still shown
    this.settings = null;
    // The worker's own authority for this session: what it may do and what the
    // user has approved. It lives in the worker's memory only, so a new chat
    // and a restarted worker both start at Ask first.
    this.access = new AccessAuthority({
      sessionId: this.id,
      onChange: (state) => this.onAccessChanged(state),
      onRequest: (request) => this.onAccessRequest(request),
      onRequestSettled: (settled) => this.onAccessRequestSettled(settled),
    });
    // The questions the user may still answer, as the panels may show them.
    // The worker's own memory only: a question is never stored with the
    // session, and a rebuilt worker has none waiting.
    this.publicRequests = new Map();
    // A tab the voice path holds the claim on is not free either: the task
    // waits for the voice command instead of working on the same page. The
    // controller reserves a tab while it takes it into its group, so the voice
    // path cannot take it in between.
    this.browser = new BrowserController({
      title: meta.title || 'Postora',
      color,
      isTakenByOther: (tab) => voiceClaims.tabHolder(isTakenByOther, tab, { sessionId: this.id }),
      reservation: voiceClaims.tabReservation({ sessionId: this.id, controllerId: this.id, owner: meta.title || 'this session' }),
    });
    this.browser.groupId = body.groupId ?? null;
  }

  get running() {
    return Boolean(this.abort);
  }

  /** `early` holds what the panel sent before this session finished loading. */
  attach(port, early = []) {
    try {
      port.postMessage({ type: 'replay', events: this.transcriptForReplay(), running: this.running, resumable: Boolean(this.continuation), question: this.pendingQuestion?.question ?? null, pending: this.inbox, access: this.access.state(), permissions: this.currentPermissions(), project: this.project });
    } catch {
      // The panel closed or moved on while this session loaded. Keeping its closed
      // port would make every later emit throw before reaching the next panel.
      return;
    }
    this.ports.add(port);
    if (ownSidePanel(port) && portBoundToSession(port, this.id)) this.trustedPorts.add(port);
    const onMessage = (msg) => {
      // A port that left keeps its listener in some clients: it may not change
      // anything through it, and neither may a disposed session.
      if (this.disposed || !this.ports.has(port)) return;
      this.receive(msg, port);
    };
    const onDisconnect = () => this.detachPort(port);
    this.portHandlers.set(port, { onMessage, onDisconnect });
    port.onDisconnect.addListener(onDisconnect);
    port.onMessage.addListener(onMessage);
    for (const msg of early) this.receive(msg, port);
  }

  /**
   * The port is gone: it may not change anything any more.
   *
   * The last panel of this session is gone as well, so nothing may wait for
   * an answer that nobody can give any more.
   */
  detachPort(port) {
    if (!this.ports.has(port)) return;
    this.ports.delete(port);
    this.trustedPorts.delete(port);
    const handlers = this.portHandlers.get(port);
    this.portHandlers.delete(port);
    if (handlers) {
      try {
        port.onMessage?.removeListener?.(handlers.onMessage);
      } catch {
        // The port is gone already; its listener goes with it.
      }
    }
    if (!this.trustedPorts.size) this.access.cancel('panel-lost');
  }

  /**
   * The transcript the panel may replay.
   *
   * The access mode and the questions waiting for an answer are the state of
   * the worker, not a moment of the conversation. Only the live state is
   * replayed, never a mode or a question that was stored once.
   */
  transcriptForReplay() {
    return this.transcript.filter((event) => !TRANSIENT_EVENTS.has(event?.type));
  }

  receive(msg, port = null) {
    if (this.disposed) return; // a session that is gone answers nothing
    // /compact is a command to this worker, never a task or a message for the model.
    const command = msg.type === 'run' || msg.type === 'steer' ? parseCompactCommand(msg.text) : null;
    if (command) this.requestCompact(command.focus, msg.mode);
    else if (msg.type === 'run') this.start(msg.text, { display: msg.display, images: msg.images, tabId: msg.tabId, voiceLanguage: msg.voiceLanguage });
    else if (msg.type === 'steer') this.steer(msg.text, msg.mode, { display: msg.display, images: msg.images });
    else if (msg.type === 'steer-now') this.sendNow(msg.id);
    else if (msg.type === 'steer-cancel') this.dropMessage(msg.id);
    else if (msg.type === 'stop') this.stop();
    else if (msg.type === 'resume' && ownSidePanel(port) && portBoundToSession(port, this.id)) this.resume(msg.tabId);
    else if (msg.type === 'answer') this.answer(msg.text, msg.display);
    else if (msg.type === 'dismiss-notice') this.emit({ type: 'notice-dismissed', id: msg.id });
    else if (msg.type === 'access-mode') this.setAccessMode(msg, port);
    else if (msg.type === 'access-approval') this.answerAccessRequest(msg, port);
    // @store-strip-start
    else if (msg.type === 'project-set') this.setProject(msg, port).catch((error) => this.broadcast({ type: 'project-state', project: this.project, error: error.message }));
    // @store-strip-end
  }

  // @store-strip-start
  async setProject(msg, port) {
    if (!this.livePort(port) || !ownSidePanel(port) || !portBoundToSession(port, this.id) || msg.sessionId !== this.id) throw new Error('Project linking requires this chat’s connected panel. Reopen the panel and try again.');
    if (this.running) throw new Error('Stop the current task before changing its project.');
    const request = ++this.projectRequest;
    let project = null;
    if (msg.root) {
      project = (await nativeRequest({ type: 'project-info', root: msg.root })).result;
    }
    if (this.disposed || !this.livePort(port) || request !== this.projectRequest) return;
    if (this.running) throw new Error('A task started before the project was changed.');
    this.project = project;
    this.scheduleSave();
    this.broadcast({ type: 'project-state', project });
  }
  // @store-strip-end

  /**
   * The access mode of this session.
   *
   * Only our own side panel, on a live port that belongs to this session, may
   * ask for it. The request has to name the session it is for: a request
   * without one is not a request for this chat. Full access needs the warning
   * the user acknowledged and the revision the panel last saw, so a request
   * made under an older mode is refused instead of applied.
   *
   * A mode that is neither Ask first nor Full access is refused, not turned
   * into one of them: a name that is not a mode changes nothing.
   *
   * Every answer is the state that is really in force, so a panel that asked
   * for something it may not have ends up with the truth and not with its own
   * request.
   */
  setAccessMode(msg, port) {
    if (!this.livePort(port)) return this.refusal('no-port');
    if (!ownSidePanel(port)) return this.refusal('not-trusted');
    if (!portBoundToSession(port, this.id)) return this.refusal('other-session');
    const sessionId = msg?.sessionId;
    const mode = msg?.mode;
    if (typeof sessionId !== 'string' || sessionId !== this.id) {
      this.broadcastAccess();
      return this.refusal('wrong-session');
    }
    if (mode !== ASK_FIRST && mode !== FULL_ACCESS) {
      this.broadcastAccess();
      return this.refusal('invalid-mode');
    }
    const result = this.access.setMode(mode, {
      trusted: true,
      acknowledged: msg.acknowledged === true,
      expectedRevision: msg.expectedRevision,
    });
    // The panel shows the mode that is really in force, whether the request
    // was accepted or refused. A mode that moved has already been told.
    if (!result.changed) this.broadcastAccess();
    else this.emit({ type: 'access-mode-note', mode: this.access.mode });
    return result;
  }

  /** A request that changed nothing, and the state that is in force. */
  refusal(reason) {
    return { ok: false, changed: false, reason, ...this.access.state() };
  }

  /** Whether the port is still one of ours and still open. */
  livePort(port) {
    if (!port || this.disposed) return false;
    return this.ports.has(port);
  }

  /**
   * The questions the panels may still answer, as they may show them.
   *
   * Only the questions that are waiting right now: a question that was
   * answered, refused or withdrawn is gone, and a worker that starts again
   * has none waiting.
   */
  currentPermissions() {
    return [...this.publicRequests.values()];
  }

  /**
   * What a panel may show about a question.
   *
   * Arguments are left out except the bounded command preview for project_run
   * and run_terminal, which must be visible before approving execution. The
   * text that was going to be typed, the
   * value that was going to be read and the permit itself never belong in a
   * preview that may be on screen. What is left is the action, its kind, the
   * site it happens on and the name the page itself gave the target — enough
   * to know what is being asked for, and nothing that repeats what the user
   * asked to keep private.
   */
  publicRequest(request) {
    const destination = request.action === 'navigate' || request.action === 'open_tab'
      ? request.args?.url
      : request.action === 'web_search' ? 'https://www.google.com' : null;
    return Object.freeze({
      id: request.id,
      sessionId: request.sessionId,
      revision: request.revision,
      action: request.action,
      kind: request.kind,
      origin: safeOrigin(destination) ?? safeOrigin(request.target?.url),
      label: safeLabel(request.target?.element?.label) ?? (request.action.startsWith('project_') ? safeLabel(request.args?.path || this.project?.name) : null),
      ...(['project_run', 'run_terminal'].includes(request.action) ? {
        command: String(request.args?.command ?? '').slice(0, 16000),
        commandTruncated: String(request.args?.command ?? '').length > 16000,
      } : {}),
    });
  }

  /**
   * The authority asked the user something.
   *
   * The panels are told what it is about, so they may show it. The question
   * itself lives in the authority: this is only what may be seen of it.
   *
   * Without a panel of this extension there is nobody who could answer, and
   * a question nobody can answer must not hold the task: it is withdrawn at
   * once, and the work carries on without it.
   */
  onAccessRequest(request) {
    const shown = this.publicRequest(request);
    this.publicRequests.set(shown.id, shown);
    this.broadcast({ type: 'access-request', request: shown });
    if (!this.trustedPorts.size) {
      this.access.withdraw(request.id, 'no-panel');
    }
  }

  /**
   * The question ended: it is gone from what the panels may show, and every
   * panel of this session is told how it ended.
   *
   * This is the only way a question leaves the list: the authority decides
   * what happened to it, and the runner only shows what the authority says.
   */
  onAccessRequestSettled(settled) {
    const shown = this.publicRequests.get(settled.id);
    if (shown && shown.sessionId === settled.sessionId && shown.revision === settled.revision) {
      this.publicRequests.delete(settled.id);
    }
    this.broadcast({
      type: 'access-request-settled',
      id: settled.id,
      sessionId: settled.sessionId,
      revision: settled.revision,
      approved: settled.approved === true,
      reason: settled.reason,
    });
  }

  /**
   * The user's answer to one question.
   *
   * Only our own side panel, on a live port that belongs to this session, may
   * answer it, and the answer has to name the exact question, the session and
   * the revision the question was asked under. A wrong, stale, foreign or
   * repeated answer grants nothing and leaves the question waiting for the
   * answer that is right: the first answer that fits is the one that counts.
   */
  answerAccessRequest(msg, port) {
    if (!this.livePort(port)) return this.refusal('no-port');
    if (!ownSidePanel(port)) return this.refusal('not-trusted');
    if (!portBoundToSession(port, this.id)) return this.refusal('other-session');
    const id = msg?.id;
    const sessionId = msg?.sessionId;
    const revision = msg?.revision;
    const decision = msg?.decision;
    if (typeof id !== 'string' || !id) return this.refusal('unknown-request');
    if (typeof sessionId !== 'string' || sessionId !== this.id) return this.refusal('wrong-session');
    if (typeof revision !== 'number') return this.refusal('stale-revision');
    if (decision !== ALLOW && decision !== DENY) return this.refusal('malformed-decision');
    const result = this.access.respondApproval({ id, sessionId, revision, decision });
    if (!result.ok) return this.refusal(result.reason);
    return { ok: true, changed: true, ...this.access.state() };
  }

  /**
   * The mode moved: lowering access stops the task; raising it lets it go on. The
   * approvals and the permits of the old mode are withdrawn, and every panel
   * of this session is told what is now in force.
   */
  onAccessChanged() {
    // setMode already withdrew old approvals and permits. An explicit upgrade
    // must not abort the task whose pending action the user wants to release.
    if (this.access.mode !== FULL_ACCESS) this.stop();
    this.broadcastAccess();
  }

  /** The mode that is really in force, to every panel of this session. */
  broadcastAccess() {
    this.broadcast({ type: 'access-state', ...this.access.state() });
  }

  /**
   * Tells every panel of this session something that is not a moment of the
   * conversation.
   *
   * The state of the worker is not stored: a mode, a question and the way it
   * ended belong to the moment they happen, and a panel that comes back gets
   * the live state with the replay instead of a history of it.
   */
  broadcast(event) {
    for (const port of this.ports) {
      try {
        port.postMessage(event);
      } catch {
        // The panel is gone; the next one gets the state with the replay.
      }
    }
  }

  emit(event) {
    if (event.type === 'final') this.continuation = null;
    if (event.type === 'status') event.resumable = Boolean(this.continuation) && !event.running;
    if (!STREAMING.has(event.type)) {
      event.at ??= Date.now(); // the panel shows durations from these
      this.transcript.push(event);
      this.scheduleSave();
      if (event.type === 'final') this.transition('finished');
      else if (event.type === 'ask') this.transition('ask', `ask-${(this.asks += 1)}`);
    }
    for (const port of this.ports) port.postMessage(event);
  }

  /** Shows a notice and returns its id; `{ dismiss: id }` withdraws one (a retry that ended). */
  notify = (notice) => {
    if (notice.dismiss) return this.emit({ type: 'notice-dismissed', id: notice.dismiss });
    // One "trying again" notice per task: a flaky provider must not make it blink.
    if (notice.kind === 'retrying') {
      if (this.retryNoticeShown) return null;
      this.retryNoticeShown = true;
    }
    const id = crypto.randomUUID();
    this.emit({ type: 'notice', id, ...notice });
    return id;
  };

  /**
   * A message sent while the task runs. "next-step": the model reads it before its
   * next turn; "interrupt": its current turn is cut short to read it now; "queue":
   * it waits for the task to finish and then starts the follow-up task.
   */
  steer(text, mode = 'next-step', { display, images } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    const shown = display || clean;
    const attached = Array.isArray(images) ? images : [];
    if (!this.running) {
      this.start(clean, { display: shown, images: attached });
      return;
    }
    this.enqueue({ id: crypto.randomUUID(), text: shown, model: clean, images: attached, mode: ['interrupt', 'queue'].includes(mode) ? mode : 'next-step', now: mode === 'interrupt' });
  }

  /** A message or /compact request that waits for the running task; "interrupt" cuts the current turn short. */
  enqueue(item) {
    this.inbox.push(item);
    this.emit({ type: 'pending-added', item: { id: item.id, text: item.text, mode: item.mode, now: item.now } });
    this.scheduleSave();
    if (item.now) this.turnAbort?.abort();
  }

  /**
   * `/compact [focus]`. With no task running the conversation is compacted now. While
   * one runs the request is a waiting message like any other and follows the same
   * mode: "next-step" compacts before the model's next turn, "interrupt" cuts the
   * current turn short and compacts, "queue" waits until the task has finished.
   */
  requestCompact(focus = '', mode = 'next-step') {
    if (!this.running) {
      this.compactAndSettle({ focus });
      return;
    }
    const kind = ['interrupt', 'queue'].includes(mode) ? mode : 'next-step';
    this.enqueue({ id: crypto.randomUUID(), text: focus ? `/compact ${focus}` : '/compact', model: '', images: [], mode: kind, now: kind === 'interrupt', compact: { focus } });
  }

  /** "Send now" on a waiting message: into the running task at once, or as a new task. */
  sendNow(id) {
    const item = this.inbox.find((m) => m.id === id);
    if (!item) return;
    if (!this.running) {
      this.dropMessage(id);
      if (item.compact) this.compactAndSettle({ focus: item.compact.focus });
      else this.start(item.model || item.text, { display: item.text, images: item.images });
      return;
    }
    item.now = true;
    this.turnAbort?.abort();
  }

  dropMessage(id) {
    const before = this.inbox.length;
    this.inbox = this.inbox.filter((m) => m.id !== id);
    if (this.inbox.length === before) return;
    this.emit({ type: 'pending-removed', id });
    this.scheduleSave();
  }

  /** What runAgent uses to deliver messages (see runAgent's `steering`). */
  steering() {
    // A /compact request is not a message for the model: compaction() takes it.
    const due = (m) => !m.compact && (m.now || m.mode !== 'queue');
    return {
      waiting: () => this.inbox.some(due),
      take: () => {
        const ready = this.inbox.filter(due);
        for (const m of ready) {
          this.dropMessage(m.id);
          this.emit({ type: 'user', text: m.text, steer: true });
        }
        // The reply language is restated with each message, as with each task.
        // `model` is the full file text; `text` is the short line shown in the chat.
        return ready.map((m) => ({
          text: (m.model || m.text) + replyLanguageReminder(this.settings?.replyLanguage),
          images: m.images ?? [],
        }));
      },
      turnSignal: (signal) => {
        this.turnAbort = new AbortController();
        return AbortSignal.any([signal, this.turnAbort.signal]);
      },
    };
  }

  /**
   * What runAgent calls between model turns (see runAgent's `compaction`). A due
   * /compact request is done now. The automatic one follows the same steering
   * mode as a message: with "queue" it waits for the task to end (settle()
   * does it then); otherwise it is done at this turn boundary. How big the
   * conversation is comes from the last turn's input tokens, or, on a task's
   * first turn, from the turn the previous task ended with.
   */
  compaction() {
    return {
      // `start` is the check before the task is added to the conversation: nothing to continue yet.
      beforeTurn: async ({ session, inputTokens, signal, task, images, start = false }) => {
        const size = inputTokens || lastInputTokens(this.transcript);
        const carry = start ? null : { task, images };
        const asked = this.inbox.filter((m) => m.compact && (m.now || m.mode !== 'queue'));
        for (const m of asked) this.dropMessage(m.id);
        if (asked.length) {
          return this.runCompaction(session, { focus: joinFocus(asked), auto: false, continueTask: !start, carry, signal, size });
        }
        const config = this.settings?.autoCompact;
        if (this.autoCompactBlocked || this.compactedNotShrunk(config, inputTokens)) return false;
        if (!autoCompactDue(config, size)) return false;
        // "Queue" postpones it to the end of the task, unless the conversation has grown so far past the
        // threshold that waiting would risk the model's limit.
        const postponed = this.settings?.steerMode === 'queue' && size < config.thresholdTokens * POSTPONE_LIMIT;
        if (postponed) return false;
        return this.runCompaction(session, { auto: true, continueTask: !start, carry, signal, size });
      },
    };
  }

  /**
   * The first turn read after an automatic compaction says whether it helped. A task
   * that is itself over the threshold keeps the conversation over it, and compacting
   * again every turn would only add a paid summary to each step: then it stops for
   * this task. Zero is "no turn since": nothing to judge yet.
   */
  compactedNotShrunk(config, inputTokens) {
    if (!this.awaitingShrink || !inputTokens) return false;
    this.awaitingShrink = false;
    if (!autoCompactDue(config, inputTokens)) return false;
    this.autoCompactBlocked = true;
    return true;
  }

  /**
   * Asks the model for the summary and swaps it in (FallbackSession.compact).
   * Says whether it compacted. A failure is shown and the task goes on with the
   * conversation it has; Stop is passed on.
   */
  async runCompaction(session, { focus = '', auto = false, continueTask = false, carry = null, signal, size = 0 }) {
    this.emit({ type: 'compacting', auto });
    try {
      // The mode in force when the new conversation is built, not a snapshot of
      // it from before the summary: the summary takes a while, and the user may
      // have changed the mode in the mean time.
      const { summary, usage } = await session.compact({ prompt: compactPrompt(focus), signal, continueTask, carry, accessState: () => this.access.state() });
      this.emit({ type: 'compacted', auto, focus, summary, tokensBefore: size, usage: normalizeUsage(usage) });
      if (auto) this.awaitingShrink = true;
      return true;
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (auto) this.autoCompactBlocked = true;
      this.emit({ type: 'compact-failed', auto, message: err.message });
      return false;
    }
  }

  /**
   * Compacts a conversation no task is running in: the session is busy while it
   * does, and Stop cancels it. Says how it ended: 'done', 'failed' or 'stopped'.
   */
  async compactIdle({ focus = '', auto = false } = {}) {
    if (this.running || this.disposed) return 'failed';
    if (!this.transcript.some((event) => event.type === 'user')) {
      this.emit({ type: 'compact-failed', auto, code: 'nothing' });
      return 'failed';
    }
    const abort = new AbortController();
    this.abort = abort;
    // The worker must stay alive while the model writes the summary, as it does for a task.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    this.emit({ type: 'status', running: true });
    try {
      const settings = await loadSettings();
      this.settings = settings;
      // The session that holds the conversation, even if the backup finished the last task:
      // rebuilding it would put the summary request to the provider that had failed.
      if (!this.session) this.prepareModelSession(settings);
      const done = await this.runCompaction(this.session, { focus, auto, continueTask: false, signal: abort.signal, size: lastInputTokens(this.transcript) });
      return done ? 'done' : 'failed';
    } catch (err) {
      // Stop during a compaction is not a stopped task: a "stopped" event would offer to resume the last task.
      const stopped = err?.name === 'AbortError';
      if (auto) this.autoCompactBlocked = true;
      this.emit({ type: 'compact-failed', auto, ...(stopped ? { code: 'stopped' } : { message: err.message }) });
      return stopped ? 'stopped' : 'failed';
    } finally {
      clearInterval(keepAlive);
      this.abort = null;
      this.emit({ type: 'status', running: false });
      this.onSessionsChanged();
    }
  }

  /**
   * A /compact typed with no task running. What was waiting before it (left there by
   * a Stop, for the user to decide) stays; what is sent while it works is read after.
   */
  compactAndSettle({ focus }) {
    const before = new Set(this.inbox.map((m) => m.id));
    this.compactIdle({ focus }).then((how) => (how === 'stopped' ? null : this.settle({ keep: before, auto: false })), () => {});
  }

  /**
   * The session is free: /compact requests that waited, the automatic compaction
   * that "queue" mode postponed, then the messages that waited, as a follow-up task.
   * `keep` names what must stay where it is. A Stop during the compaction ends it all.
   */
  async settle({ keep = new Set(), auto: allowAuto = true } = {}) {
    if (this.disposed || this.running) return;
    let auto = allowAuto && !this.autoCompactBlocked && autoCompactDue(this.settings?.autoCompact, lastInputTokens(this.transcript));
    // A /compact typed while one is running waits for it, so asking again finds it.
    for (let asked = this.takeCompactRequests(keep); asked.length || auto; asked = this.takeCompactRequests(keep)) {
      const how = await this.compactIdle({ focus: joinFocus(asked), auto: !asked.length });
      if (how === 'stopped') return;
      auto = false;
    }
    this.drainInbox(keep);
  }

  /** The waiting /compact requests, taken off the inbox. */
  takeCompactRequests(keep) {
    const asked = this.inbox.filter((m) => m.compact && !keep.has(m.id));
    for (const m of asked) this.dropMessage(m.id);
    return asked;
  }

  /** The waiting messages become one follow-up task. */
  drainInbox(keep = new Set()) {
    const texts = this.inbox.filter((m) => !m.compact && !keep.has(m.id));
    if (!texts.length || this.disposed || this.running) return;
    const next = texts.map((m) => m.model || m.text).join('\n\n');
    const nextImages = texts.flatMap((m) => m.images ?? []);
    const nextShown = texts.map((m) => m.text).join('\n\n');
    for (const m of texts) this.dropMessage(m.id);
    this.start(next, { display: nextShown, images: nextImages });
  }

  async start(text, { display, images, tabId, voiceLanguage, resumed = false } = {}) {
    if (this.running) {
      this.emit({ type: 'error', message: 'A task is already running in this session. Stop it first.' });
      return;
    }
    const shown = display || text;
    const attached = Array.isArray(images) ? images : [];
    const abort = new AbortController();
    this.abort = abort;
    this.continuation = { task: text, images: attached, tabId: tabId ?? null, at: Date.now() };
    // Extension API calls reset the service worker idle timer while the model thinks.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    this.notified.clear();
    this.retryNoticeShown = false;
    this.autoCompactBlocked = false;
    this.awaitingShrink = false;
    if (!resumed) this.emit({ type: 'user', text: shown });
    this.emit({ type: 'status', running: true });
    let finished = false;
    try {
      await this.save();
      if (!this.titled) await this.nameAfter(shown);
      this.onSessionsChanged(); // after naming, so other panels list it with its title
      const settings = await loadSettings();
      if (voiceLanguage === 'ar' || voiceLanguage === 'en') settings.replyLanguage = { enabled: true, language: voiceLanguage };
      this.settings = settings;
      this.prepareModelSession(settings);
      this.browser.overlay.begin({ enabled: settings.showCursor, uiLanguage: settings.uiLanguage });
      this.browser.tabId = null; // each task starts on the tab the user is looking at
      const tab = await this.browser.startOn(tabId);
      const execute = createToolExecutor(this.browser, { askUser: (q) => this.askUser(q, abort.signal), signal: abort.signal, notebook: this.notebook, onNotebookChange: () => this.scheduleSave(), allowed: new Set(toolDefinitions(effectiveSettings(settings)).map((t) => t.name)), access: this.access, getProject: () => this.project });
      let untrustedContext = '';
      // @store-strip-start
      if (this.project) {
        this.emit({ type: 'tool-start', step: 0, callId: 'initial-project-context', name: 'project_context', args: {} });
        const result = await execute('project_context', {});
        if (result.isError) throw new Error(result.output);
        // The text of the project is not part of the task. It reaches the model
        // as a message of its own, framed as data, so a file cannot be read as
        // something the user asked for.
        untrustedContext = result.output;
        this.emit({ type: 'tool-end', step: 0, callId: 'initial-project-context', name: 'project_context', ok: true, summary: 'Initial project context loaded, including the recursive file inventory and explicit reading limits.' });
      }
      // @store-strip-end
      // The user may have changed access mode while approving project reads.
      // Seed the first model turn with the current authority snapshot.
      this.prepareModelSession(settings);
      const fastLayer = settings.fast.enabled && settings.fast.apiKey
        ? createFastLayer({ config: settings.fast, browser: this.browser, execute, task: text, ask: createFastAsk(settings.fast, this.notify) })
        : null;
      await runAgent({
        fastLayer,
        session: this.session,
        execute,
        task: (resumed ? `Resume the interrupted task below from the current page and saved progress. Check the current state first. Never repeat a completed send, purchase, deletion or other side effect merely because the previous run stopped. If its outcome is uncertain, verify it before proceeding.\n\n${text}` : text) + (this.project ? `\n\n[Selected project: ${this.project.name}. Use project_list/read/write/run for its files and commands. File paths are relative to the selected root.]` : '') + describeTabContext(tab) + replyLanguageReminder(settings.replyLanguage),
        untrustedContext,
        images: attached,
        maxSteps: Math.max(1, Number(settings.maxSteps) || 40),
        signal: abort.signal,
        emit: (event) => this.emit(event),
        steering: this.steering(),
        compaction: this.compaction(),
        getAccessState: () => this.access.state(),
      });
      finished = true;
    } catch (err) {
      const stopped = abort.signal.aborted || err.name === 'AbortError';
      if (!stopped) this.continuation = null;
      this.emit(stopped ? { type: 'stopped' } : { type: 'error', message: err.message });
      if (!stopped) this.transition('failed'); // stopped by the user: they know
    } finally {
      clearInterval(keepAlive);
      // The run is over: nothing it approved survives it. The mode the user
      // chose stays, so the next task of this chat runs under it.
      this.access.finish('finished');
      this.abort = null;
      this.pendingQuestion = null;
      this.clearAskNotices();
      await this.browser.overlay.end();
      // Pages opened for reading are done once the task is. The starting tab stays.
      await this.browser.closeDisposableTabs().catch(() => {});
      await this.browser.detachAll();
      this.turnAbort = null;
      this.emit({ type: 'status', running: false });
      this.onSessionsChanged();
    }
    // /compact requests that waited, then the messages still waiting as the follow-up
    // task, sent together. After a Stop or an error they stay, so the user decides.
    if (finished && !this.disposed) await this.settle();
  }

  /**
   * Each task starts on the primary provider. A new model session is seeded with
   * the conversation so far when the backup finished the last task, the model
   * settings changed, the access mode changed, or the session was reopened from
   * storage.
   *
   * The mode the worker enforces is handed to the session as the runtime
   * snapshot it is: the prompt of the primary and of the backup describe the
   * mode that is really in force, and the key of the session includes it, so
   * a mode that moved is described by the next task. The snapshot is read
   * from the authority and from nowhere else: a setting, a message or a
   * transcript never names a mode. A session that is built later reads the
   * mode again, so a backup that takes over later describes the mode that is
   * in force then.
   */
  prepareModelSession(settings) {
    const accessState = this.access.state();
    const key = modelSessionKey(settings, { accessState });
    if (this.session && this.sessionKey === key && !this.session.switched) return;
    const log = this.session?.log ?? this.storedLog;
    const modeMoved = Boolean(this.session) && this.sessionMode !== accessState.mode;
    const reason = !this.session ? 'continuing an earlier session'
      : this.session.switched ? 'the previous task was finished by the backup provider'
        : modeMoved ? 'the access mode in force changed'
          : 'the model was changed in settings';
    this.session = createModelSession(settings, { notify: this.notify, seed: log ? { log, reason } : null, conversationId: this.id, notebook: this.notebook, accessState: () => this.access.state(), history: conversationHistory(this.transcript) });
    this.sessionKey = key;
    this.sessionMode = accessState.mode;
  }

  async nameAfter(task) {
    await store.titleFromFirstTask(this.id, task);
    const meta = (await store.listSessions()).find((s) => s.id === this.id);
    if (meta) await this.rename(meta.title);
  }

  async rename(title) {
    this.title = title;
    this.titled = true;
    await this.browser.rename(title);
  }

  resume(tabId) {
    if (this.running || !this.continuation) return;
    const checkpoint = this.continuation;
    this.storedLog = this.session?.log ?? this.storedLog;
    this.session = null; // rebuild from saved history, without unfinished tool calls
    return this.start(checkpoint.task, { images: checkpoint.images ?? [], tabId: tabId ?? checkpoint.tabId ?? undefined, resumed: true });
  }

  stop() {
    // A stop withdraws what was approved: nothing waits for an answer and
    // nothing that was allowed may run any more. The mode itself stays: the
    // session may go on with the mode the user chose.
    this.access.cancel('stopped');
    if (!this.abort) return;
    this.abort.abort();
    this.browser.overlay.end(); // feedback now, not after the current step returns
  }

  /** For a deleted session: stop its task and never save again, or its last events would recreate it. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.stop(); // the task stops and the authority is withdrawn
    for (const port of [...this.ports]) this.detachPort(port);
  }

  askUser(question, signal) {
    return new Promise((resolve, reject) => {
      this.pendingQuestion = { question, resolve };
      this.emit({ type: 'ask', question });
      signal.addEventListener('abort', () => reject(new DOMException('Stopped by user', 'AbortError')), { once: true });
    });
  }

  answer(text, display) {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = null;
    this.clearAskNotices();
    this.emit({ type: 'user', text: display || text, answer: true });
    pending.resolve(text);
  }

  /** A desktop notification for a task transition, at most once each, if the user turned them on. */
  async transition(kind, key = kind) {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    const settings = this.settings ?? (await loadSettings().catch(() => null));
    const id = await notifyTransition({ kind, sessionId: this.id, tabId: this.browser.tabId, groupId: this.browser.groupId, settings });
    if (kind === 'ask' && id) {
      if (this.pendingQuestion) this.askNotices.push(id);
      else clearNotification(id); // answered while the notification was being shown
    }
  }

  /** The question was answered or the task ended: its notifications no longer apply. */
  clearAskNotices() {
    for (const id of this.askNotices.splice(0)) clearNotification(id);
  }

  scheduleSave() {
    if (this.disposed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (this.disposed) return;
    await store.saveSession(this.id, { transcript: this.transcript, log: this.session?.log ?? this.storedLog, groupId: this.browser.groupId, notebook: this.notebook.toJSON(), pending: this.inbox, project: this.project, continuation: this.continuation });
  }
}

/** The focus texts of waiting /compact requests, as one. */
function joinFocus(items) {
  return items.map((m) => m.compact?.focus).filter(Boolean).join('; ');
}
