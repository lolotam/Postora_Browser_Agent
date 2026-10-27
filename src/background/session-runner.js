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
import { AccessAuthority, ASK_FIRST, FULL_ACCESS } from '../permissions/policy.js';
import { effectiveSettings, loadSettings } from '../lib/settings.js';
import { clearNotification, notifyTransition } from './notifications.js';
import * as store from '../sessions/store.js';
import * as voiceClaims from '../sessions/voice-claims.js';

const SAVE_DELAY_MS = 500;
const KEEP_ALIVE_MS = 20000;
const STREAMING = new Set(['text-delta', 'reasoning-delta', 'text-reset']);

// The one page of this extension that may ask for the access mode. The check
// is exact: the side panel of this extension, and nothing else.
const ACCESS_PANEL_PATH = 'src/sidepanel/index.html';

/**
 * True for a port that our own side panel opened.
 *
 * The sender must be this extension and this page: not another extension, not
 * the microphone window, not the background page, and not a page whose URL
 * merely starts with the same words.
 */
function ownSidePanel(port) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.id) return false;
  const sender = port?.sender;
  if (!sender || sender.id !== runtime.id) return false;
  return sender.url === runtime.getURL(ACCESS_PANEL_PATH);
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
    this.title = meta.title;
    this.titled = meta.titled;
    // The access mode is the state of the worker, not a moment of the
    // conversation: it is never a part of the transcript, and an event of
    // that kind stored by an older version is not brought back.
    this.transcript = (body.transcript ?? []).filter((event) => event?.type !== 'access-state');
    this.storedLog = body.log;
    this.notebook = Notebook.from(body.notebook); // kept for follow-up tasks and reopening
    // Messages sent while a task runs: { id, text, model, images, mode, now }.
    // `text` is the short line in the chat; `model` is the full file text.
    this.inbox = Array.isArray(body.pending) ? body.pending : [];
    this.turnAbort = null;
    this.onSessionsChanged = onSessionsChanged;
    this.ports = new Set();
    // The live panels that may ask for the access mode, and the listeners
    // this runner left on each port, so a port that goes away takes its
    // listener with it.
    this.trustedPorts = new Set();
    this.portHandlers = new Map();
    this.session = null;
    this.sessionKey = null;
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
    });
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
      port.postMessage({ type: 'replay', events: this.transcriptForReplay(), running: this.running, question: this.pendingQuestion?.question ?? null, pending: this.inbox, access: this.access.state() });
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
   * The access mode is the state of the worker, not a moment of the
   * conversation. Only the live state is replayed, never a mode that was
   * stored once.
   */
  transcriptForReplay() {
    return this.transcript.filter((event) => event?.type !== 'access-state');
  }

  receive(msg, port = null) {
    if (this.disposed) return; // a session that is gone answers nothing
    if (msg.type === 'run') this.start(msg.text, { display: msg.display, images: msg.images, tabId: msg.tabId });
    else if (msg.type === 'steer') this.steer(msg.text, msg.mode, { display: msg.display, images: msg.images });
    else if (msg.type === 'steer-now') this.sendNow(msg.id);
    else if (msg.type === 'steer-cancel') this.dropMessage(msg.id);
    else if (msg.type === 'stop') this.stop();
    else if (msg.type === 'answer') this.answer(msg.text, msg.display);
    else if (msg.type === 'dismiss-notice') this.emit({ type: 'notice-dismissed', id: msg.id });
    else if (msg.type === 'access-mode') this.setAccessMode(msg, port);
  }

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
   * The mode moved: the task that ran under the old mode does not go on, the
   * approvals and the permits of the old mode are withdrawn, and every panel
   * of this session is told what is now in force.
   */
  onAccessChanged() {
    this.access.cancel('mode-changed'); // nothing approved under the old mode survives it
    this.stop(); // the running task does not continue under a new mode
    this.broadcastAccess();
  }

  /** The mode that is really in force, to every panel of this session. */
  broadcastAccess() {
    const state = this.access.state();
    for (const port of this.ports) {
      try {
        port.postMessage({ type: 'access-state', ...state });
      } catch {
        // The panel is gone; the next one gets the state with the replay.
      }
    }
  }

  emit(event) {
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
    const item = { id: crypto.randomUUID(), text: shown, model: clean, images: attached, mode: ['interrupt', 'queue'].includes(mode) ? mode : 'next-step', now: mode === 'interrupt' };
    this.inbox.push(item);
    this.emit({ type: 'pending-added', item: { id: item.id, text: item.text, mode: item.mode, now: item.now } });
    this.scheduleSave();
    if (item.now) this.turnAbort?.abort();
  }

  /** "Send now" on a waiting message: into the running task at once, or as a new task. */
  sendNow(id) {
    const item = this.inbox.find((m) => m.id === id);
    if (!item) return;
    if (!this.running) {
      this.dropMessage(id);
      this.start(item.model || item.text, { display: item.text, images: item.images });
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
    const due = (m) => m.now || m.mode !== 'queue';
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

  async start(text, { display, images, tabId } = {}) {
    if (this.running) {
      this.emit({ type: 'error', message: 'A task is already running in this session. Stop it first.' });
      return;
    }
    const shown = display || text;
    const attached = Array.isArray(images) ? images : [];
    const abort = new AbortController();
    this.abort = abort;
    // Extension API calls reset the service worker idle timer while the model thinks.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    this.notified.clear();
    this.retryNoticeShown = false;
    this.emit({ type: 'user', text: shown });
    this.emit({ type: 'status', running: true });
    let finished = false;
    try {
      if (!this.titled) await this.nameAfter(shown);
      this.onSessionsChanged(); // after naming, so other panels list it with its title
      const settings = await loadSettings();
      this.settings = settings;
      this.prepareModelSession(settings);
      this.browser.overlay.begin({ enabled: settings.showCursor, uiLanguage: settings.uiLanguage });
      this.browser.tabId = null; // each task starts on the tab the user is looking at
      const tab = await this.browser.startOn(tabId);
      const execute = createToolExecutor(this.browser, { askUser: (q) => this.askUser(q, abort.signal), signal: abort.signal, notebook: this.notebook, onNotebookChange: () => this.scheduleSave(), allowed: new Set(toolDefinitions(effectiveSettings(settings)).map((t) => t.name)) });
      const fastLayer = settings.fast.enabled && settings.fast.apiKey
        ? createFastLayer({ config: settings.fast, browser: this.browser, execute, task: text, ask: createFastAsk(settings.fast, this.notify) })
        : null;
      await runAgent({
        fastLayer,
        session: this.session,
        execute,
        task: text + describeTabContext(tab) + replyLanguageReminder(settings.replyLanguage),
        images: attached,
        maxSteps: Math.max(1, Number(settings.maxSteps) || 40),
        signal: abort.signal,
        emit: (event) => this.emit(event),
        steering: this.steering(),
      });
      finished = true;
    } catch (err) {
      this.emit(err.name === 'AbortError' ? { type: 'stopped' } : { type: 'error', message: err.message });
      if (err.name !== 'AbortError') this.transition('failed'); // stopped by the user: they know
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
    // Messages still waiting become the follow-up task, sent together. After a Stop or
    // an error they stay, so the user decides.
    if (finished && this.inbox.length && !this.disposed) {
      const next = this.inbox.map((m) => m.model || m.text).join('\n\n');
      const nextImages = this.inbox.flatMap((m) => m.images ?? []);
      const nextShown = this.inbox.map((m) => m.text).join('\n\n');
      for (const m of [...this.inbox]) this.dropMessage(m.id);
      this.start(next, { display: nextShown, images: nextImages });
    }
  }

  /**
   * Each task starts on the primary provider. A new model session is seeded with
   * the conversation so far when the backup finished the last task, the model
   * settings changed, or the session was reopened from storage.
   */
  prepareModelSession(settings) {
    const key = modelSessionKey(settings);
    if (this.session && this.sessionKey === key && !this.session.switched) return;
    const log = this.session?.log ?? this.storedLog;
    const reason = !this.session ? 'continuing an earlier session'
      : this.session.switched ? 'the previous task was finished by the backup provider'
        : 'the model was changed in settings';
    this.session = createModelSession(settings, { notify: this.notify, seed: log ? { log, reason } : null, conversationId: this.id, notebook: this.notebook });
    this.sessionKey = key;
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
    await store.saveSession(this.id, { transcript: this.transcript, log: this.session?.log ?? this.storedLog, groupId: this.browser.groupId, notebook: this.notebook.toJSON(), pending: this.inbox });
  }
}
