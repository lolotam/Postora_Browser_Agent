// The worker's side of the fast voice path.
//
// Every action of a spoken command leaves the panel and comes here. This is
// the only place that may change a page for the voice path, and it is the
// only place that may say yes to one: the session's own access authority
// decides, the user answers through the same Allow/Deny card the chat uses,
// and only the action that was allowed runs.
//
// Four things are checked before anything happens:
//   - the request comes from our own side panel, on a live connection that
//     belongs to this session and to this panel — and the connection is
//     checked again after every step that took time, so a panel that left
//     while the worker was looking something up may not act;
//   - it names a command the worker is holding for that panel, under the
//     revision of the mode that is in force now, and under a generation of
//     the authority that is still alive (a stop, a mode change or the end of
//     the session's work ends it);
//   - it names the lease of the tab it acts on, and that lease is the one that
//     is still allowed;
//   - the authority allows that exact action, with that exact target.
//
// And three things are checked while it happens: the target, the document and
// the focus are captured before the question is asked — without changing
// anything on the page — and looked at again after every step that took
// time, and the grant is asked again after each of them. A page that replaced
// its document, a field that took the focus in the meantime and a mode that
// moved while the user was answering all stop the action.
//
// The command is bound to the authority before it is planned: the claim hands
// out the context, and every later action names it. A command that was
// withdrawn — because the mode moved, because the user stopped it, because the
// panel went away, because the claims were given back — finds no context any
// more, and nothing of it runs.

import * as claims from '../sessions/voice-claims.js';
import { pageError, pageErrorKey, selectAllChord } from '../voice/voice-input.js';
import * as page from '../voice/voice-page.js';
import { secretRule } from '../voice/voice-safety.js';

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/;

// The one page of this extension that may act for the voice path. The check
// is exact: the side panel of this extension, and nothing else. The
// microphone window, a content script and a website are all refused.
const ACCESS_PANEL_PATH = 'src/sidepanel/index.html';

/**
 * The actions the voice path may ask for, and the policy action each of them
 * is under.
 *
 * The list is closed: a name that is not here is refused before anything
 * happens. The policy action is the name the shared approval card shows and
 * the name the authority classifies, so a voice click and a tool click are the
 * same kind of action for the same authority.
 */
export const VOICE_ACTIONS = Object.freeze({
  // What the page is: an observation, never a question.
  probe: { policy: 'read_page', observe: true },
  // What the page does.
  scroll_down: { policy: 'scroll' },
  scroll_up: { policy: 'scroll' },
  scroll_top: { policy: 'scroll' },
  scroll_bottom: { policy: 'scroll' },
  media_play_pause: { policy: 'media_play_pause' },
  media_mute: { policy: 'media_mute' },
  find_on_page: { policy: 'find_on_page' },
  // Where the browser goes.
  navigate: { policy: 'navigate' },
  open_tab: { policy: 'open_tab' },
  web_search: { policy: 'web_search' },
  history: { policy: 'history' },
  switch_tab: { policy: 'switch_tab' },
  close_tab: { policy: 'close_tab' },
  zoom_in: { policy: 'zoom_in' },
  zoom_out: { policy: 'zoom_out' },
  zoom_reset: { policy: 'zoom_reset' },
  // What the user does on the page.
  click: { policy: 'click' },
  type_text: { policy: 'type_text' },
  press_key: { policy: 'press_key' },
  insert_text: { policy: 'insert_text' },
  read_field: { policy: 'read_field' },
  // The tab this command opened and never showed: it is closed again, and it
  // is not a question, because it was never the user's to keep.
  discard_tab: { policy: null, internal: true },
});

/** The page scripts the worker may run, by name. */
const SCRIPTS = Object.freeze({
  pageProbe: page.pageProbe,
  scrollPage: page.scrollPage,
  mediaControl: page.mediaControl,
  findText: page.findText,
});

/** The kinds of the page probe a panel may ask for on its own. */
const PUBLIC_PROBE_KINDS = new Set(['collect', 'focused']);

/** The steps of the input a panel may ask for, and nothing else. */
const INPUT_OPS = new Set(['click', 'selectAll', 'text', 'key']);

/** The only key the voice path presses. */
const VOICE_KEY = 'Enter';

function webAddress(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

/** The address without its fragment: a fragment does not change the page. */
function stripHash(url) {
  const at = String(url ?? '').indexOf('#');
  return at === -1 ? String(url ?? '') : String(url ?? '').slice(0, at);
}

/**
 * True for a port that our own side panel opened.
 *
 * The sender must be this extension and this page: not another extension, not
 * the microphone window, not the background page, and not a page whose URL
 * merely starts with the same words.
 */
function ownSidePanel(sender) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.id) return false;
  if (!sender || sender.id !== runtime.id) return false;
  return sender.url === runtime.getURL(ACCESS_PANEL_PATH);
}

/** The name of the connection of one panel of one session. */
function portName(sessionId, panelId) {
  return `panel:${sessionId}:${panelId}`;
}

/**
 * The worker's voice path.
 *
 * It holds the commands of the panels, the generation of each session and the
 * one browser that sends the real input. Everything it needs from the rest of
 * the worker is given to it: the session runners, the live panel connections,
 * the browser and the queue that serializes the input.
 */
export function createVoiceAccess({
  getRunner,
  panelPorts,
  voiceBrowser,
  withVoiceBrowser,
  ownerOfTab = () => null,
} = {}) {
  // The commands the panels are holding, by their id.
  const commands = new Map();
  // The command of each panel: one panel runs one command at a time.
  const panelCommand = new Map();
  // The generation of each session: the answer to "was this session stopped?".
  const generations = new Map();
  // Cleanup is worker-owned and remains available after execution is revoked.
  const orphanCleanups = new Set();

  function cleanUnshown(command) {
    const tasks = [];
    for (const tabId of command.created) {
      if (command.shown.has(tabId)) continue;
      command.created.delete(tabId);
      const task = chrome.tabs.remove(tabId).catch(() => {});
      orphanCleanups.add(task);
      void task.finally(() => orphanCleanups.delete(task));
      tasks.push(task);
    }
    return Promise.all(tasks);
  }

  /**
   * The generation of a session.
   *
   * It is a permit of the session's own authority, and a permit is withdrawn
   * by everything that ends the work of a session: a stop, a mode change, the
   * end of a task, a panel that left. The voice path does not need to know
   * which of them it was: the permit tells it that the world moved, and the
   * command it belongs to is over.
   *
   * The permit is taken with the name of an observation, so it never asks
   * the user anything.
   */
  async function generationOf(runner, sessionId) {
    const held = generations.get(sessionId);
    if (held && held.runner === runner && runner.access.grantValid(held.permit)) return held;
    const answer = await runner.access.authorize({ action: 'read_page', args: { voice: sessionId } });
    const next = { permit: answer?.permit ?? null, revision: runner.access.revision, runner };
    generations.set(sessionId, next);
    return next;
  }

  /** Whether the generation of a session is still alive. */
  function generationAlive(runner, generation) {
    if (!generation?.permit) return false;
    return runner.access.grantValid(generation.permit);
  }

  /** The command of a panel is over: nothing of it may run any more. */
  function invalidateCommand(command, reason = 'cancelled') {
    if (!command || command.dead) return false;
    command.dead = true;
    command.reason = reason;
    // The pending question of this command is withdrawn with it: nobody waits
    // for an answer that may not be used any more.
    try {
      command.controller.abort();
    } catch {
      // The controller is already aborted.
    }
    commands.delete(command.id);
    if (panelCommand.get(command.panelId) === command.id) panelCommand.delete(command.panelId);
    void cleanUnshown(command);
    return true;
  }

  /** Every command of a session is over. */
  function invalidateSession(sessionId, reason = 'cancelled') {
    for (const command of [...commands.values()]) {
      if (command.sessionId === sessionId) invalidateCommand(command, reason);
    }
  }

  /** Every command of a panel is over. */
  function invalidatePanel(panelId, reason = 'cancelled') {
    for (const command of [...commands.values()]) {
      if (command.panelId === panelId) invalidateCommand(command, reason);
    }
  }

  /** The command of a panel, when it is still the one that was started. */
  function liveCommand(commandId, sessionId, panelId, revision) {
    const command = commands.get(commandId);
    if (!command || command.dead) return null;
    if (command.sessionId !== sessionId || command.panelId !== panelId) return null;
    if (command.revision !== revision) return null;
    return command;
  }

  /**
   * The command of a panel, started here.
   *
   * It is bound to the revision of the mode that is in force now and to the
   * generation of the session, so a step that was planned under an older mode
   * finds no command to run under.
   */
  function beginCommand(sessionId, panelId, revision, generation) {
    const existing = panelCommand.get(panelId);
    const command = existing ? commands.get(existing) : null;
    if (command && !command.dead && command.sessionId === sessionId && command.revision === revision &&
      generationAlive(generation.runner, command.generation)) {
      // The same command claims the tab again: it keeps its context.
      return command;
    }
    // The old command is over: it may not be continued under a new mode.
    if (command) invalidateCommand(command, 'mode-changed');
    const controller = new AbortController();
    const started = {
      id: `cmd-${crypto.randomUUID()}`,
      sessionId,
      panelId,
      revision,
      generation,
      controller,
      dead: false,
      reason: null,
      created: new Set(),
      shown: new Set(),
    };
    commands.set(started.id, started);
    panelCommand.set(panelId, started.id);
    return started;
  }

  /**
   * Everything that has to be true before an action may even be asked about.
   *
   * A request that fails any of these does nothing at all: no question is
   * asked, no page is touched.
   *
   * The connection of the panel is pinned here and looked at again after the
   * lookup of the session: a panel that left while the worker was looking
   * something up may not act afterwards.
   */
  async function admitPanel(msg, sender) {
    if (!ownSidePanel(sender)) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    const sessionId = msg?.sessionId;
    const panelId = msg?.panelId;
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    if (typeof panelId !== 'string' || !panelId) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    // The connection of this panel of this session must be live, and it must
    // be our own side panel: a message that lost its way answers nothing.
    const port = panelPorts?.get(portName(sessionId, panelId));
    if (!port || !ownSidePanel(port.sender)) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    let runner;
    try {
      runner = await getRunner(sessionId);
    } catch {
      return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    }
    if (!runner?.access) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    // The lookup took time: the panel may have left in the meantime, and the
    // connection it came from is the one it has to come from.
    if (panelPorts?.get(portName(sessionId, panelId)) !== port) {
      return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    }
    if (!ownSidePanel(port.sender)) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    return { ok: true, sessionId, panelId, runner, port, revision: runner.access.revision };
  }

  /** The panel is ours, and the command it names is the one that is live. */
  async function admit(msg, sender) {
    const admitted = await admitPanel(msg, sender);
    if (!admitted.ok) return admitted;
    const command = liveCommand(msg.commandId, admitted.sessionId, admitted.panelId, admitted.revision);
    if (!command || !generationAlive(admitted.runner, command.generation)) return { ok: false, errorKey: 'voice.sayCancelled' };
    return { ...admitted, command };
  }

  /**
   * The lease of the tab an action acts on, when it is the one that is allowed.
   *
   * The lease belongs to the command that took it: an action of another
   * command may not act under it.
   */
  function leaseOk(command, tabId, token) {
    if (tabId == null) return false;
    return claims.isAuthorized(tabId, { panelId: command.panelId, token, commandId: command.id });
  }

  /**
   * The tab an action acts on, and the page it is on.
   *
   * A tab that is gone, or a page of Chrome itself, is refused: the voice
   * path never reaches into them.
   */
  async function tabOf(tabId, { allowRestricted = false } = {}) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, errorKey: 'voice.sayTabGone' };
    if (!allowRestricted && RESTRICTED.test(tab.url ?? '')) return { ok: false, errorKey: 'voice.sayPageRestricted' };
    return { ok: true, tab };
  }

  /** The identity of the document, so a page that was replaced is not the page. */
  async function documentOf(tabId, rule) {
    const res = await voiceBrowser.inject(page.pageProbe, ['document', null, rule], { tabId }).catch(() => null);
    return res?.documentId ?? null;
  }

  /**
   * The target of an action on an element: what was approved, and where it
   * was when the question was asked.
   *
   * Nothing of the page is changed here: the element is only looked at, so a
   * question that is refused leaves the page exactly as it was.
   */
  async function captureElement({ tabId, element, expected, allowBody = false, rule }) {
    const tab = await tabOf(tabId);
    if (!tab.ok) return tab;
    const spot = await voiceBrowser.inject(page.pageProbe, ['resolve', { id: element, expected }, rule], { tabId })
      .catch((err) => ({ ok: false, errorKey: pageErrorKey(err) ?? 'voice.pageGone' }));
    if (!spot?.ok) return { ok: false, errorKey: spot?.errorKey ?? 'voice.pageGone' };
    if (spot.body && !allowBody) return { ok: false, errorKey: 'voice.pageNoField' };
    // The document has to be readable: a page that cannot name its document
    // cannot be the page that was approved.
    const documentId = spot.documentId ?? null;
    if (!documentId) return { ok: false, errorKey: 'voice.pageGone' };
    return {
      ok: true,
      spot,
      elementId: element ?? null,
      target: {
        scope: 'element',
        kind: 'element',
        tabId,
        url: tab.tab.url ?? '',
        documentId,
        element: {
          token: element ?? null,
          kind: spot.kind ?? null,
          label: spot.label ?? null,
          secret: Boolean(spot.secret),
        },
        capturedAt: Date.now(),
      },
    };
  }

  /** The target of an action on a tab: the tab, its address and its document. */
  async function captureTab(tabId, rule, { allowRestricted = false } = {}) {
    const tab = await tabOf(tabId, { allowRestricted });
    if (!tab.ok) return tab;
    // Native tab management may show/close a blank tab or navigate away from
    // it. That grants no ability to script Chrome's protected document.
    const restricted = allowRestricted && RESTRICTED.test(tab.tab.url ?? '');
    const documentId = restricted ? null : await documentOf(tabId, rule);
    if (!restricted && !documentId) return { ok: false, errorKey: 'voice.pageGone' };
    return {
      ok: true,
      target: {
        scope: 'tab',
        kind: 'tab',
        tabId,
        url: tab.tab.url ?? '',
        documentId,
        restricted,
        element: null,
        capturedAt: Date.now(),
      },
    };
  }

  /**
   * Asks the authority about one exact operation, and hands back the permit
   * together with the guard that keeps it honest while the action runs.
   */
  async function allowed(runner, command, operation) {
    if (command.dead || !generationAlive(runner, command.generation)) {
      return { ok: false, errorKey: 'voice.sayCancelled', reason: 'cancelled' };
    }
    const answer = await runner.access.authorize(operation, { signal: command.controller.signal });
    if (!answer?.permit) return { ok: false, errorKey: 'voice.sayCancelled', reason: answer?.reason ?? 'denied' };
    const permit = answer.permit;
    const guard = async () => {
      if (command.dead) return false;
      if (!generationAlive(runner, command.generation)) return false;
      return runner.access.grantValid(permit, operation);
    };
    return { ok: true, permit, guard, operation };
  }

  /** The steps of an input, as they are allowed to be. */
  function canonicalSteps(action, args) {
    if (action === 'click') return [{ op: 'click', element: args.element }];
    if (action === 'press_key') return [{ op: 'key', key: VOICE_KEY }];
    if (action === 'insert_text') return [{ op: 'text', text: args.text }];
    if (action === 'type_text') {
      const steps = [
        { op: 'click', element: args.element },
        { op: 'selectAll' },
        { op: 'text', text: args.text },
      ];
      if (args.submit) steps.push({ op: 'key', key: VOICE_KEY });
      return steps;
    }
    return null;
  }

  /** Whether the steps the panel sent are the steps that were approved. */
  function sameSteps(sent, wanted) {
    if (!Array.isArray(sent) || sent.length !== wanted.length) return false;
    return wanted.every((step, index) => {
      const other = sent[index];
      if (!other || typeof other !== 'object') return false;
      if (!INPUT_OPS.has(other.op)) return false;
      return Object.keys(step).every((key) => other[key] === step[key]);
    });
  }

  /**
   * Real input on a tab the voice path holds the lease on: a click, a key, a
   * text. The page sees what a user's hand would do.
   *
   * The element the user approved is resolved here, after the queue: the page
   * may have changed while the input was waiting. The guard is asked again
   * right before every event that changes the page, and it looks at the page
   * as well as at the lease: the approved element must still be the same one,
   * still under the point that is clicked, and the focus must still be the
   * approved field.
   */
  async function runInput({ tabId, steps, element, expected, rule, guard }) {
    try {
      await withVoiceBrowser(async () => {
        await voiceBrowser.borrowTab(tabId);
        for (const step of steps) {
          // The lease and the grant are checked again before every step: a
          // command that was withdrawn while this request was waiting must not
          // click or type.
          if (!(await guard())) throw new Error('voice.claimLost');
          if (step.op === 'click') {
            // The approved element is brought into view and looked up now, and
            // it must still be the same element, still there. The guard is
            // asked before the script runs: a command that was withdrawn may
            // not move the page either.
            const spot = await voiceBrowser.inject(page.pageProbe, ['locate', { id: element, expected }, rule], { tabId, guard });
            if (!spot?.ok) throw pageError(spot?.errorKey ?? 'voice.pageGone');
            // The guard is asked again right before the button goes down: the
            // element must still be the same one, and it must still lie under
            // the point that is clicked. The check changes nothing on the page.
            const hit = async () => {
              if (!(await guard())) return false;
              const again = await voiceBrowser.inject(page.pageProbe, ['hit', { id: element, expected, x: spot.x, y: spot.y }, rule], { tabId });
              // The probe took time: the command may be over by now.
              if (!(await guard())) return false;
              return Boolean(again?.ok);
            };
            await voiceBrowser.clickAt(Number(spot.x), Number(spot.y), { wait: false, guard: hit });
          } else {
            // Every other input needs the focus the user approved. The guard
            // looks at it again right before the key or the text goes out, so
            // a page that moved the focus in the meantime gets nothing.
            const focus = await voiceBrowser.inject(page.pageProbe, ['focus', { id: element }, rule], { tabId });
            if (!focus?.ok) throw pageError(focus?.errorKey ?? 'voice.pageFocusLost');
            const held = async () => {
              if (!(await guard())) return false;
              const still = await voiceBrowser.inject(page.pageProbe, ['focus', { id: element }, rule], { tabId });
              if (!(await guard())) return false;
              return Boolean(still?.ok);
            };
            if (step.op === 'selectAll') await voiceBrowser.pressKey(selectAllChord(), { wait: false, guard: held });
            else if (step.op === 'text') await voiceBrowser.insertText(String(step.text ?? ''), { guard: held });
            else if (step.op === 'key') await voiceBrowser.pressKey(String(step.key), { wait: false, guard: held });
            else throw new Error('voice.inputUnknown');
          }
        }
      });
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/voice\.claimLost/.test(message)) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
      if (/voice\.inputCancelled/.test(message)) return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
      if (/voice\.inputUnknown/.test(message)) return { ok: false, errorKey: 'voice.sayCannotDo' };
      const pageKey = pageErrorKey(err);
      if (pageKey) return { ok: false, errorKey: pageKey };
      if (/Cannot access|chrome:\/\/|does not allow/i.test(message)) return { ok: false, errorKey: 'voice.sayPageRestricted' };
      return { ok: false, errorKey: 'voice.sayClickFailed' };
    }
    return { ok: true };
  }

  /**
   * One action of the voice path.
   *
   * The name is checked against the closed list, the command and the lease are
   * checked against what the worker holds, the target is captured without
   * changing anything, the authority is asked, and only then does anything
   * change.
   */
  async function handleAction(msg, sender) {
    const admitted = await admit(msg, sender);
    if (!admitted.ok) return admitted;
    const { runner, command, sessionId, panelId } = admitted;
    const spec = Object.hasOwn(VOICE_ACTIONS, msg.action) ? VOICE_ACTIONS[msg.action] : null;
    if (!spec) return { ok: false, errorKey: 'voice.sayCannotDo' };
    if (spec.internal) return handleInternal(msg, admitted);

    const tabId = msg.tabId ?? null;
    const token = msg.token ?? null;
    // Every action needs the lease of the tab it acts on: a panel that does
    // not hold it may not read the page either, and it may not change it.
    if (spec.policy !== null && !leaseOk(command, tabId, token)) {
      return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    }

    const rule = ruleFor(msg.rule);
    const args = plain(msg.args) ?? {};
    if (['navigate', 'web_search', 'open_tab'].includes(spec.policy)) {
      const url = String(args.url ?? '');
      if (!(spec.policy === 'open_tab' && url === '') && !webAddress(url)) {
        return { ok: false, errorKey: 'voice.sayNoSite' };
      }
    }

    if (spec.observe) {
      // The page is read: the elements of the page, or what has the focus.
      if (msg.script !== 'pageProbe') return { ok: false, errorKey: 'voice.sayCannotDo' };
      const kind = typeof args.kind === 'string' ? args.kind : null;
      if (!PUBLIC_PROBE_KINDS.has(kind)) return { ok: false, errorKey: 'voice.sayCannotDo' };
      // The rule is the one the worker keeps: the panel may add names to it,
      // never take any away.
      const probeArgs = [kind, args.arg ?? null, rule];
      try {
        const result = await voiceBrowser.inject(SCRIPTS.pageProbe, probeArgs, { tabId });
        return { ok: true, result: result ?? null };
      } catch (err) {
        const pageKey = pageErrorKey(err);
        if (pageKey) return { ok: false, errorKey: pageKey };
        if (/Cannot access|chrome:\/\/|does not allow/i.test(String(err?.message ?? ''))) {
          return { ok: false, errorKey: 'voice.sayPageRestricted' };
        }
        return { ok: false, errorKey: 'voice.sayCannotDo' };
      }
    }

    // The target is captured before the question is asked: what the user says
    // yes to is this element, in this document, on this tab. The capture
    // changes nothing on the page.
    let capture;
    let operation;
    if (spec.policy === 'click' || spec.policy === 'type_text' || spec.policy === 'press_key' || spec.policy === 'read_field') {
      capture = await captureElement({ tabId, element: msg.element ?? null, expected: plain(msg.expected) ?? null, allowBody: spec.policy === 'press_key', rule });
      if (!capture.ok) return capture;
      const element = String(msg.element ?? '');
      if (spec.policy === 'click') operation = { action: 'click', args: { element }, tabId, target: capture.target };
      else if (spec.policy === 'type_text') {
        const text = String(args.text ?? '');
        operation = { action: 'type_text', args: { element, text, submit: Boolean(args.submit) }, tabId, target: capture.target };
      } else if (spec.policy === 'press_key') {
        operation = { action: 'press_key', args: { element, key: VOICE_KEY }, tabId, target: capture.target };
      } else {
        operation = { action: 'read_field', args: { element }, tabId, target: capture.target };
      }
    } else if (spec.policy === 'insert_text') {
      // The focused field is named here: the panel does not choose it, the
      // page does.
      const focused = await voiceBrowser.inject(page.pageProbe, ['focused', null, rule], { tabId }).catch(() => null);
      if (!focused?.id) return { ok: false, errorKey: 'voice.pageFocusLost' };
      capture = await captureElement({ tabId, element: focused.id, expected: null, rule });
      if (!capture.ok) return capture;
      operation = { action: 'insert_text', args: { text: String(args.text ?? '') }, tabId, target: capture.target };
    } else {
      const allowRestricted = ['navigate', 'web_search', 'open_tab', 'switch_tab', 'close_tab'].includes(spec.policy);
      capture = await captureTab(tabId, rule, { allowRestricted });
      if (!capture.ok) return capture;
      operation = { action: spec.policy, args, tabId, target: capture.target };
    }

    // The steps of an input are the ones the action means, and nothing else:
    // a panel may not add a step of its own, and it may not leave one out.
    // This is checked before the user is asked: a malformed request is not a
    // question.
    const wanted = canonicalSteps(spec.policy, operation.args);
    if (wanted && !sameSteps(msg.steps, wanted)) {
      return { ok: false, errorKey: 'voice.sayCannotDo' };
    }

    const grant = await allowed(runner, command, operation);
    if (!grant.ok) return { ok: false, errorKey: grant.errorKey };

    /**
     * Whether the page is still the one that was approved.
     *
     * The tab has to be the same tab, at the same address, and its document
     * has to be the document that was captured. An element action also asks
     * the page whether the element is still the same one, in that document.
     */
    const targetValid = async () => {
      const live = await chrome.tabs.get(tabId).catch(() => null);
      if (!live) return false;
      if (stripHash(live.url ?? '') !== stripHash(capture.target.url ?? '')) return false;
      if (capture.target.restricted) return RESTRICTED.test(live.url ?? '');
      if (capture.target.element) {
        const res = await voiceBrowser.inject(page.pageProbe, ['resolve', { id: capture.elementId, expected: plain(msg.expected) }, rule], { tabId }).catch(() => null);
        if (!res?.ok) return false;
        if ((res.documentId ?? null) !== capture.target.documentId) return false;
        if ((res.kind ?? null) !== (capture.target.element.kind ?? null)) return false;
        if ((res.label ?? null) !== (capture.target.element.label ?? null)) return false;
        return true;
      }
      const doc = await voiceBrowser.inject(page.pageProbe, ['document', null, rule], { tabId }).catch(() => null);
      if (!doc?.documentId) return false;
      return doc.documentId === capture.target.documentId;
    };

    // The guard is asked before anything happens, and again after every step
    // that took time: the lease, the command, the grant and the page all have
    // to be there still.
    //
    // The order is the order of the contract: the lease, then the grant, then
    // the check of the page, and then the lease and the grant once more. The
    // last pair is what says that nothing was withdrawn while the page was
    // being looked at.
    const guard = async () => {
      if (!leaseOk(command, tabId, token)) return false;
      if (!(await grant.guard())) return false;
      if (!(await targetValid())) return false;
      if (!leaseOk(command, tabId, token)) return false;
      if (!(await grant.guard())) return false;
      return true;
    };
    if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };

    /**
     * Runs a page script under the guard.
     *
     * A command that was withdrawn while the script was being prepared stops
     * the script itself: the browser refuses to run it, and that refusal is
     * the answer of the worker, not a failure of the page.
     */
    const runPage = async (func, args) => {
      try {
        const pinnedArgs = func === page.pageProbe
          ? [args[0], { ...args[1], documentId: capture.target.documentId }, args[2]]
          : [args[0], capture.target.documentId];
        return await voiceBrowser.inject(func, pinnedArgs, { tabId, guard });
      } catch (err) {
        if (/voice\.inputCancelled/.test(String(err?.message ?? ''))) {
          return { ok: false, errorKey: 'voice.sayCancelled' };
        }
        throw err;
      }
    };

    switch (spec.policy) {
      case 'navigate':
      case 'web_search': {
        const url = String(args.url ?? '');
        if (!url) return { ok: false, errorKey: 'voice.sayNoSite' };
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        await chrome.tabs.update(tabId, { url });
        return { ok: true };
      }
      case 'open_tab': {
        const url = String(args.url ?? '');
        const windowId = Number.isInteger(args.windowId) ? args.windowId : undefined;
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        const created = await chrome.tabs.create({ url: url || undefined, windowId, active: false });
        // The tab belongs to this command until it is shown: a tab that is
        // never shown is closed again, and it is not a question.
        command.created.add(created.id);
        // Cancellation may have happened while Chrome was creating the tab.
        // Never return an orphan under a command that no longer exists.
        if (command.dead || !generationAlive(runner, command.generation)) {
          await cleanUnshown(command);
          return { ok: false, errorKey: 'voice.sayCancelled' };
        }
        return { ok: true, tab: { id: created.id, windowId: created.windowId ?? windowId ?? null, url: created.url ?? url, title: created.title ?? '' } };
      }
      case 'history': {
        const what = String(args.action ?? '');
        if (!['back', 'forward', 'reload'].includes(what)) return { ok: false, errorKey: 'voice.sayCannotDo' };
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        if (what === 'back') await chrome.tabs.goBack(tabId);
        else if (what === 'forward') await chrome.tabs.goForward(tabId);
        else await chrome.tabs.reload(tabId);
        return { ok: true };
      }
      case 'switch_tab': {
        // The tab is bound to the session before it is shown, so the panel
        // that follows the focused tab stays in this session.
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        await chrome.tabs.update(tabId, { active: true });
        command.shown.add(tabId);
        return { ok: true };
      }
      case 'close_tab': {
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        await chrome.tabs.remove(tabId).catch(() => {});
        return { ok: true };
      }
      case 'zoom_in':
      case 'zoom_out':
      case 'zoom_reset': {
        const zoom = await chrome.tabs.getZoom(tabId);
        // The tab may have changed hands while the zoom was read.
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        const level = spec.policy === 'zoom_reset'
          ? 0
          : Math.min(5, Math.max(0.25, zoom + (spec.policy === 'zoom_in' ? 0.25 : -0.25)));
        await chrome.tabs.setZoom(tabId, level);
        return { ok: true, level };
      }
      case 'scroll': {
        const direction = String(args.direction ?? 'down');
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        const res = await runPage(SCRIPTS.scrollPage, [direction]);
        if (!res?.ok) return { ok: false, errorKey: res?.errorKey ?? 'voice.sayCannotDo' };
        return { ok: true };
      }
      case 'media_play_pause':
      case 'media_mute': {
        const kind = spec.policy === 'media_mute' ? 'mute' : 'toggle';
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        const res = await runPage(SCRIPTS.mediaControl, [kind]);
        if (!res?.ok) return { ok: false, errorKey: res?.errorKey ?? 'voice.sayNoMedia' };
        return { ok: true, state: res.state };
      }
      case 'find_on_page': {
        const text = String(args.text ?? '');
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        const res = await runPage(SCRIPTS.findText, [text]);
        if (!res?.ok) return { ok: false, errorKey: res?.errorKey ?? 'voice.sayNotFound' };
        return { ok: true };
      }
      case 'click': {
        const steps = canonicalSteps('click', operation.args);
        // The element is looked at again after the question: it must still be
        // the same one, and it must still lie under the point that is clicked.
        const spot = await runPage(page.pageProbe, ['locate', { id: msg.element, expected: plain(msg.expected) }, rule]);
        if (!spot?.ok) return { ok: false, errorKey: spot?.errorKey ?? 'voice.pageGone' };
        // The grant is asked again after the check of the page, right before
        // the click goes out.
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        return runInput({ tabId, steps, element: msg.element, expected: plain(msg.expected), rule, guard });
      }
      case 'type_text': {
        const steps = canonicalSteps('type_text', operation.args);
        const spot = await runPage(page.pageProbe, ['locate', { id: msg.element, expected: plain(msg.expected) }, rule]);
        if (!spot?.ok) return { ok: false, errorKey: spot?.errorKey ?? 'voice.pageGone' };
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        return runInput({ tabId, steps, element: msg.element, expected: plain(msg.expected), rule, guard });
      }
      case 'press_key': {
        const steps = canonicalSteps('press_key', operation.args);
        // The focus is looked at again in the worker, right before the key.
        const focus = await runPage(page.pageProbe, ['focus', { id: msg.element }, rule]);
        if (!focus?.ok) return { ok: false, errorKey: focus?.errorKey ?? 'voice.pageFocusLost' };
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        return runInput({ tabId, steps, element: msg.element, expected: null, rule, guard });
      }
      case 'insert_text': {
        const steps = canonicalSteps('insert_text', operation.args);
        // The field that has the focus must still have it, and it must be one
        // that can really be written to: never the body, never a field that is
        // read-only or disabled, never a field that only claims to be one.
        const focus = await runPage(page.pageProbe, ['focus', { id: capture.elementId }, rule]);
        if (!focus?.ok) return { ok: false, errorKey: focus?.errorKey ?? 'voice.pageFocusLost' };
        if (!focus.writable) return { ok: false, errorKey: 'voice.pageNoField' };
        if (!(await guard())) return { ok: false, errorKey: 'voice.sayCancelled' };
        return runInput({ tabId, steps, element: capture.elementId, expected: null, rule, guard });
      }
      case 'read_field': {
        // The value of the field the user allowed, and nothing else.
        const value = await runPage(page.pageProbe, ['read', { id: msg.element, expected: plain(msg.expected) }, rule]);
        if (!value?.ok) return { ok: false, errorKey: value?.errorKey ?? 'voice.pageNoField' };
        return { ok: true, value: value.value ?? '', secret: Boolean(value.secret) };
      }
      default:
        return { ok: false, errorKey: 'voice.sayCannotDo' };
    }
  }

  /**
   * The actions the worker does for itself: the tab this command opened and
   * never showed is closed again. It is not a question, because the user was
   * never asked about it and never saw it.
   */
  async function handleInternal(msg, admitted) {
    const { command } = admitted;
    const tabId = msg.tabId ?? null;
    if (!command.created.has(tabId)) return { ok: false, errorKey: 'voice.sayCannotDo' };
    if (command.shown.has(tabId)) return { ok: false, errorKey: 'voice.sayCannotDo' };
    command.created.delete(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    return { ok: true };
  }

  /**
   * The claim on a tab, and the command it belongs to.
   *
   * The claim is taken before the page is read, and the command is started
   * here — before the command is even planned — so that every step of it runs
   * under one context of the authority.
   *
   * Every step that took time is followed by another look: the panel may have
   * left, the mode may have moved, or the session may have been stopped. A
   * command that is minted after any of those is not a command of this world.
   */
  async function handleClaim(msg, sender) {
    const admitted = await admitPanel(msg, sender);
    if (!admitted.ok) return admitted;
    const { runner, sessionId, panelId, port, revision } = admitted;

    /** Whether the world is still the one the claim started in. */
    const stillHere = () => {
      if (panelPorts?.get(portName(sessionId, panelId)) !== port) return false;
      if (runner.access.revision !== revision) return false;
      return true;
    };

    // The generation of the session: the answer to "was this session
    // stopped?". It is taken before anything is waited for, so that a stop
    // that happens while the worker is looking something up is seen.
    const generation = await generationOf(runner, sessionId);
    if (!stillHere()) return { ok: false, errorKey: 'voice.sayCancelled' };
    if (!generationAlive(runner, generation)) return { ok: false, errorKey: 'voice.sayCancelled' };

    const tabId = msg.tabId ?? null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!stillHere()) return { ok: false, errorKey: 'voice.sayCancelled' };
    if (!generationAlive(runner, generation)) return { ok: false, errorKey: 'voice.sayCancelled' };
    if (!tab) return { ok: false, errorKey: 'voice.sayTabGone', owner: '' };
    // Another session's task, or the task of this session itself: the voice
    // path does not work on the page of a task that is still running.
    const owner = ownerOfTab(sessionId, tab);
    if (owner) return { ok: false, owner };

    const command = beginCommand(sessionId, panelId, revision, generation);
    const lease = claims.claimTab(tabId, { panelId, sessionId, commandId: command.id });
    if (!lease.ok) return lease;
    // The lease is held now, so nobody else may take the tab while the
    // ownership is looked at again. A session that took the tab in the
    // meantime keeps it, and the lease goes back.
    const fresh = await chrome.tabs.get(tabId).catch(() => null);
    if (!stillHere() || !generationAlive(runner, generation) || command.dead) {
      await releaseClaim(tabId, panelId, lease.token);
      return { ok: false, errorKey: 'voice.sayCancelled' };
    }
    if (!fresh) {
      await releaseClaim(tabId, panelId, lease.token);
      return { ok: false, errorKey: 'voice.sayTabGone', owner: '' };
    }
    const owner2 = ownerOfTab(sessionId, fresh);
    if (owner2) {
      await releaseClaim(tabId, panelId, lease.token);
      return { ok: false, owner: owner2 };
    }
    return { ok: true, token: lease.token, command: { id: command.id, revision: command.revision } };
  }

  /** Gives one lease back, in two steps: the authorization goes first. */
  async function releaseClaim(tabId, panelId, token) {
    const lease = claims.revokeTab(tabId, { panelId, token });
    if (!lease) return false;
    await finishLease(lease);
    return true;
  }

  /** Waits for the input of a tab to drain, detaches the debugger and frees the tab. */
  async function finishLease(lease) {
    // The detachment waits its turn, so an input that is running on another
    // tab is not disturbed. An input that is running on this tab sees that its
    // lease is not authorized any more, and stops by itself.
    await withVoiceBrowser(() => voiceBrowser.detachTab(lease.tabId));
    // Only this lease may be given back: a cleanup that arrives late must not
    // free a tab that another lease holds by now.
    claims.releaseTab(lease.tabId, { panelId: lease.panelId, token: lease.token });
  }

  /**
   * Gives every lease of a panel back.
   *
   * The authorization of all of them goes at once, so a tab that waits for
   * its cleanup does not hold up the others, and the command of the panel is
   * over before the cleanup starts: nothing of it may run any more.
   */
  async function releasePanel(panelId) {
    invalidatePanel(panelId, 'released');
    const leases = claims.revokePanel(panelId);
    await Promise.all(leases.map((lease) => finishLease(lease)));
    await Promise.all([...orphanCleanups]);
  }

  /**
   * The command is over: the context of the worker is dropped, the pending
   * question is withdrawn and the leases are given back. A pending question
   * never holds the release up: it is withdrawn before the cleanup waits for
   * the input queue.
   *
   * Only the panel of this session may end its own command, and only the
   * command that belongs to it.
   */
  async function cancelCommand(msg, sender) {
    const sessionId = msg?.sessionId;
    const panelId = msg?.panelId;
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof panelId !== 'string' || !panelId) return false;
    if (!ownSidePanel(sender)) return false;
    // The connection of this panel of this session has to be the one that is
    // live: a panel may not end the command of another panel.
    const port = panelPorts?.get(portName(sessionId, panelId));
    if (!port || !ownSidePanel(port.sender)) return false;
    const commandId = typeof msg.commandId === 'string' ? msg.commandId : null;
    const command = commandId ? commands.get(commandId) : null;
    if (command) {
      // The command has to belong to this panel of this session.
      if (command.sessionId !== sessionId || command.panelId !== panelId) return false;
      invalidateCommand(command, 'cancelled');
    } else {
      invalidatePanel(panelId, 'cancelled');
    }
    const leases = claims.revokePanel(panelId);
    await Promise.all(leases.map((lease) => finishLease(lease)));
    await Promise.all([...orphanCleanups]);
    return true;
  }

  /** The rule the page is judged by: the one the worker keeps, plus what the panel adds. */
  function ruleFor(extra) {
    const base = secretRule();
    if (!extra || typeof extra !== 'object') return base;
    const list = (value, own) => {
      const from = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
      return [...new Set([...own, ...from])];
    };
    return {
      tokens: list(extra.tokens, base.tokens),
      words: list(extra.words, base.words),
      fragments: list(extra.fragments, base.fragments),
    };
  }

  /** A copy of plain JSON: what the authority is given is what it approved. */
  function plain(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => plain(item));
    if (typeof value === 'object') {
      const copy = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(copy, key, { value: plain(item), enumerable: true, writable: true, configurable: true });
      }
      return copy;
    }
    return null;
  }

  return {
    handleAction,
    handleClaim,
    releaseClaim,
    releasePanel,
    cancelCommand,
    invalidateSession,
    invalidatePanel,
    /** The command of a panel, for the worker and its tests. */
    commandOf: (panelId) => {
      const id = panelCommand.get(panelId);
      return id ? commands.get(id) ?? null : null;
    },
  };
}
