// Drives one browser tab through the Chrome DevTools Protocol (chrome.debugger)
// so clicks and keystrokes are trusted input events, indistinguishable from a
// real user's, and work on sites that ignore synthetic DOM events.

import { AgentOverlay } from './overlay.js';
import { snapshotPage, elementAction, suggestionAction, pageText, pageReadyState, devicePixelRatioOf, domSettled, documentIdOf, permissionTarget, pointSnap, focusInFrame } from './page-scripts.js';
import { secretRule } from '../voice/voice-safety.js';
import { WorkingTabClosedError } from './working-tab.js';

const CDP_VERSION = '1.3';
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/webstore/;

// The rule that says what a field holds a secret is written once, in
// src/voice/voice-safety.js. The page scripts get it as JSON, so the page and
// the module always agree on what a secret field is: there is no second
// classifier here.
const SECRET_RULE = secretRule();

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
// The error a guarded input throws when the guard says the input may not
// happen any more: the lease it belonged to is gone.
export const INPUT_CANCELLED = 'voice.inputCancelled';
// After an action, the page counts as settled once its content stops changing for
// SETTLE_QUIET_MS (capped at SETTLE_MAX_MS), instead of a fixed pause: a static page
// moves on at once, results that load by script still get time to appear.
const SETTLE_QUIET_MS = 150;
const SETTLE_FIRST_MS = 300; // until the first change: time for a started request to answer
const SETTLE_MAX_MS = 800;
export const DEFAULT_DIALOG_DEADLINE_MS = 60000;

/**
 * One controller per session. The session's tabs live in a Chrome tab group
 * titled with the session name: the group is how parallel sessions keep off
 * each other's tabs and how the user sees which agent works where. Tabs are
 * never brought to the front; input and screenshots go through CDP.
 */
export class BrowserController {
  constructor({ title = 'Postora', color = 'cyan', isTakenByOther = () => null, reservation = null, onLost = null, dialogDeadlineMs = DEFAULT_DIALOG_DEADLINE_MS } = {}) {
    // Told once when the tab the task works on is gone, so the task is ended at
    // once: a model turn, an approval or a question it waits on does not go on.
    this.onLost = onLost;
    this.title = title;
    this.color = color;
    this.isTakenByOther = isTakenByOther;
    // How a tab is reserved while it is being taken into the group. It is an
    // adapter, so this file stays free of the worker's state.
    this.reservation = reservation;
    this.groupId = null;
    this.tabId = null;
    // True while the controller works on a tab it borrowed: it never falls
    // back to another tab when that one is gone.
    this.borrowed = false;
    // The tab the task started on stays open. Tabs this session opened are closed
    // once it leaves them, so a long task does not keep every page in memory.
    this.homeTabId = null;
    this.disposable = new Set();
    this.justClosed = null;
    this.attached = new Set();
    this.attaching = new Map();
    this.attachEpoch = 0;
    this.pageEnabled = new Set();
    this.dialogDeadlineMs = dialogDeadlineMs;
    this.dialogs = new Map();
    this.dialogWatchers = new Map();
    this.beforeUnloadNotes = new Map();
    this.dialogCounter = 0;
    // True once a task has claimed the tab it works on. From then on a missing
    // tab is the loss of that tab, not the start of a new one.
    this.started = false;
    // True once the tab the task works on is gone. The task ends then: it does
    // not move on to another tab, which the user never chose for it.
    this.lost = false;
    this.overlay = new AgentOverlay(this);
    chrome.debugger.onDetach?.addListener?.(({ tabId }) => {
      this.attached.delete(tabId);
      this.pageEnabled.delete(tabId);
      this.clearPendingDialog(tabId);
    });
    chrome.debugger.onEvent?.addListener?.((source, method, params) => {
      this.onDebuggerEvent(source, method, params);
    });
    chrome.tabs.onRemoved?.addListener?.((tabId) => {
      this.attached.delete(tabId);
      this.pageEnabled.delete(tabId);
      this.clearPendingDialog(tabId);
      if (tabId === this.tabId) {
        this.tabId = null;
        // The tab the task works on was closed: the task ends here.
        this.markLost();
      }
    });
  }

  async currentTab() {
    if (this.tabId !== null) {
      try {
        return await chrome.tabs.get(this.tabId);
      } catch {
        this.tabId = null;
        // The tab is gone. A task that had one cannot go on without it.
        this.markLost();
      }
    }
    // A borrowed tab is never replaced by another one: the command that
    // borrowed it acts on no tab at all when that tab is gone.
    if (this.borrowed) throw new Error('The tab this command acts on is gone.');
    // The task has started: its tab is gone, and no other tab takes its place.
    // The user chose that tab for this task, and it is not there any more.
    if (this.started) throw new WorkingTabClosedError(this.homeTabId);
    return this.startOn();
  }

  /**
   * The task is over: a tab it worked on that closes later is no loss, and
   * nothing is told about it. Any pending page dialog is dismissed.
   */
  finishTask() {
    this.started = false;
    void this.dismissAllDialogs('task-finished');
  }

  onDebuggerEvent(source, method, params = {}) {
    const tabId = source?.tabId;
    if (tabId == null) return;
    if (!this.attached.has(tabId) && tabId !== this.tabId) return;
    if (method === 'Page.javascriptDialogClosed') {
      this.clearPendingDialog(tabId);
      return;
    }
    if (method !== 'Page.javascriptDialogOpening') return;
    const type = String(params.type ?? 'alert');
    const message = String(params.message ?? '');
    const url = String(params.url ?? '');
    const defaultPrompt = String(params.defaultPrompt ?? '');
    if (type === 'beforeunload') {
      if (typeof chrome.debugger?.sendCommand === 'function') {
        void Promise.resolve(chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }))
          .then(
            () => { this.beforeUnloadNotes.set(tabId, { handled: true, message }); },
            () => { this.beforeUnloadNotes.set(tabId, { handled: false, message }); },
          );
      } else {
        this.beforeUnloadNotes.set(tabId, { handled: false, message });
      }
      return;
    }
    this.clearPendingDialog(tabId);
    const id = `dlg-${++this.dialogCounter}-${tabId}-${Date.now()}`;
    const timer = setTimeout(() => {
      void this.dismissPendingDialog(tabId, 'deadline', id);
    }, this.dialogDeadlineMs);
    const dialog = Object.freeze({
      id,
      tabId,
      type,
      message,
      url,
      defaultPrompt,
      openedAt: Date.now(),
    });
    this.dialogs.set(tabId, { dialog, timer, retries: 0 });
    const watchers = this.dialogWatchers.get(tabId);
    if (watchers) {
      this.dialogWatchers.delete(tabId);
      for (const resolve of watchers) resolve(dialog);
    }
  }

  clearPendingDialog(tabId, dialogId = null) {
    const entry = this.dialogs.get(tabId);
    if (!entry) return false;
    if (dialogId && entry.dialog.id !== dialogId) return false;
    clearTimeout(entry.timer);
    this.dialogs.delete(tabId);
    return true;
  }

  pendingDialog(tabId = null) {
    const id = tabId ?? this.tabId;
    if (id == null) return null;
    return this.dialogs.get(id)?.dialog ?? null;
  }

  takeBeforeUnloadNote(tabId = null) {
    const id = tabId ?? this.tabId;
    if (id == null || !this.beforeUnloadNotes.has(id)) return '';
    const entry = this.beforeUnloadNotes.get(id);
    this.beforeUnloadNotes.delete(id);
    const handled = typeof entry === 'object' ? entry.handled !== false : true;
    const message = typeof entry === 'object' ? entry.message : entry;
    if (!handled) {
      return message
        ? ` Failed to dismiss beforeunload dialog ("${message}").`
        : ' Failed to dismiss beforeunload dialog.';
    }
    return message
      ? ` Dismissed beforeunload dialog ("${message}").`
      : ' Dismissed beforeunload dialog.';
  }

  waitForDialog(tabId = null) {
    const id = tabId ?? this.tabId;
    if (id == null) return { promise: new Promise(() => {}), cancel: () => {} };
    const existing = this.pendingDialog(id);
    if (existing) return { promise: Promise.resolve(existing), cancel: () => {} };
    let listener;
    const promise = new Promise((resolve) => {
      listener = resolve;
      const set = this.dialogWatchers.get(id) ?? new Set();
      set.add(resolve);
      this.dialogWatchers.set(id, set);
    });
    const cancel = () => {
      const set = this.dialogWatchers.get(id);
      if (set) {
        set.delete(listener);
        if (!set.size) this.dialogWatchers.delete(id);
      }
    };
    return { promise, cancel };
  }

  async dismissPendingDialog(tabId = null, reason = 'dismissed', dialogId = null) {
    const id = tabId ?? this.tabId;
    if (id == null) return false;
    const entry = this.dialogs.get(id);
    if (!entry) return false;
    if (dialogId && entry.dialog.id !== dialogId) return false;
    const targetId = entry.dialog.id;
    try {
      if (typeof chrome.debugger?.sendCommand !== 'function') throw new Error('debugger unavailable');
      await chrome.debugger.sendCommand({ tabId: id }, 'Page.handleJavaScriptDialog', { accept: false });
      this.clearPendingDialog(id, targetId);
      return true;
    } catch {
      const current = this.dialogs.get(id);
      if (current && current.dialog.id === targetId) {
        current.retries = (current.retries ?? 0) + 1;
        if (current.retries <= 2) {
          clearTimeout(current.timer);
          current.timer = setTimeout(() => {
            void this.dismissPendingDialog(id, reason, targetId);
          }, Math.min(this.dialogDeadlineMs, 250));
        }
      }
      return false;
    }
  }

  async dismissAllDialogs(reason = 'dismissed') {
    for (const [tabId, entry] of [...this.dialogs.entries()]) {
      await this.dismissPendingDialog(tabId, reason, entry.dialog.id);
    }
  }

  async handleDialog({ accept, promptText, dialogId = null } = {}, { guard = null, tabId = null, signal = null } = {}) {
    const tab = await this.pinnedTab(tabId);
    const current = this.pendingDialog(tab.id);
    if (!current) throw new Error('No JavaScript dialog is open on this tab.');
    if (dialogId && current.id !== dialogId) {
      throw new Error('The open dialog changed before it could be answered.');
    }
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    const params = {
      accept: Boolean(accept),
      ...(current.type === 'prompt' && promptText !== undefined ? { promptText: String(promptText) } : {}),
    };
    await this.cdp('Page.handleJavaScriptDialog', params, { guard, tabId: tab.id, signal });
    this.clearPendingDialog(tab.id, current.id);
    await this.waitForLoad({ tabId: tab.id, signal, afterMutation: true });
    return current;
  }

  /** The tab the task works on is gone: noted once, and the task is told. */
  markLost() {
    if (!this.started || this.lost) return;
    this.lost = true;
    try {
      this.onLost?.();
    } catch {
      // The flag alone still ends the task at its next tool.
    }
  }

  /** Whether the tab the task works on is gone: the task cannot go on. */
  workingTabLost() {
    return Boolean(this.lost);
  }

  /**
   * Works on a tab without taking it into the session's group: the voice path
   * borrows the tab it was pointed at, so no session owns it and no other
   * session is pushed out of it.
   */
  async borrowTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    this.tabId = tabId;
    this.borrowed = true;
    return tab;
  }

  /**
   * A task begins on the tab the user is looking at, which joins the session's
   * group. `tabId` names the tab to work on when the caller knows it: a voice
   * command pins the tab it was meant for, and the microphone window that asks
   * for the permission must not become the target.
   */
  async startOn(tabId = null) {
    // A new task starts fresh: the loss of the previous task's tab does not
    // follow this one.
    this.lost = false;
    const tab = tabId == null
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('No active tab found.');
    // The task has a tab of its own from the claim on: when that tab is closed,
    // even before the claim finished, the task ends instead of continuing
    // somewhere else.
    this.started = true;
    const claimed = await this.useTab(tab.id);
    this.homeTabId = claimed.id;
    return claimed;
  }

  /**
   * Works on another tab. A `guard` says whether the switch may still happen:
   * it is asked before the tab is taken, again after the taking, and again
   * before the tab that is left behind is closed.
   */
  async useTab(tabId, { guard = null } = {}) {
    // The tab the task works on is gone: the task ends, it does not move on to
    // a tab nobody chose for it.
    if (this.lost) throw new WorkingTabClosedError(this.homeTabId);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // The tab this controller had before is remembered before the new one is
    // claimed: claiming publishes the new tab.
    const previous = this.tabId;
    const tab = await this.claimTab(tabId, { guard });
    // The claiming took time: the command may have been withdrawn while it
    // waited, and a tab that was withdrawn is not taken.
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // The working tab was closed while the new one was being claimed: the
    // claim does not hide the loss, and the claimed tab is not worked on.
    if (this.lost) {
      this.tabId = null;
      throw new WorkingTabClosedError(this.homeTabId);
    }
    this.tabId = tabId;
    this.borrowed = false;
    if (previous !== null && previous !== tabId) {
      await this.overlay.leave(previous);
      // The overlay cleanup took time: the close is asked again before the tab
      // that is left behind goes.
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      await this.closeIfLeft(previous);
    }
    await this.overlay.frame();
    return tab;
  }

  async openTab(url, { guard = null } = {}) {
    assertHttpUrl(url);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    const created = await chrome.tabs.create({ url, active: false });
    this.disposable.add(created.id);
    return this.useTab(created.id, { guard });
  }

  /** The id of the tab just closed by leaving it, once. */
  takeClosedNote() {
    const id = this.justClosed;
    this.justClosed = null;
    return id == null ? '' : ` Closed tab ${id} after reading it.`;
  }

  /** Closes a tab this session opened, once the session has moved on to another. */
  async closeIfLeft(tabId) {
    if (tabId == null || tabId === this.tabId || tabId === this.homeTabId || !this.disposable.has(tabId)) return;
    this.justClosed = tabId;
    await this.closeOwnedTab(tabId);
  }

  /** Closes every tab this session opened. The tab the task started on stays. */
  async closeDisposableTabs() {
    for (const tabId of [...this.disposable]) await this.closeOwnedTab(tabId);
  }

  /**
   * Closes one tab.
   *
   * A `guard` says whether the tab may still be closed: it is asked before
   * anything is touched and again after the debugger was detached, right
   * before the tab goes. A refused close leaves the bookkeeping as it was: the
   * tab is not forgotten as though it had closed.
   *
   * The cleanup of a tab this session opened is not guarded: the tab goes when
   * the session leaves it, whatever the authority says at that moment.
   */
  async closeOwnedTab(tabId, { guard = null } = {}) {
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (this.attached.has(tabId)) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Already detached, or the tab is already gone.
      }
      this.attached.delete(tabId);
    }
    // The detach took time: the close is asked again, right before the tab
    // goes away.
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already closed.
    }
    this.disposable.delete(tabId);
    if (this.homeTabId === tabId) this.homeTabId = null;
    if (this.tabId === tabId) {
      this.tabId = null;
      // The tab the task works on was closed: the task ends here.
      this.markLost();
    }
  }

  ownsTab(tab) {
    return this.groupId !== null && tab.groupId === this.groupId;
  }

  /**
   * Takes a tab into the group of this session.
   *
   * A `guard` says whether the tab may still be taken: it is asked again after
   * the ownership and the reservation were read, and right before every step
   * that changes the tab (the grouping, the title of the group, the publishing
   * of the tab). A cancellation is never taken for a group that is gone: the
   * tab is left alone.
   */
  async claimTab(tabId, { guard = null } = {}) {
    const tab = await chrome.tabs.get(tabId);
    // The tab was looked up: the claim is asked again, right before anything
    // is changed.
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // A tab that another session holds is refused, even when it is already in
    // this session's group: the voice path's claim is a claim too.
    const owner = this.isTakenByOther(tab);
    if (owner) throw new Error(`Tab ${tabId} is used by session "${owner}". Use a tab of your own or open a new one.`);
    if (this.ownsTab(tab)) return tab;
    // The tab is reserved before the grouping starts. Grouping is asynchronous,
    // and the voice path must not take the tab while the session is taking it.
    const reservation = await this.reserveTab(tabId);
    if (!reservation.ok) {
      throw new Error(`Tab ${tabId} is used by session "${reservation.owner}". Use a tab of your own or open a new one.`);
    }
    try {
      // The reservation was read: the claim is asked again before the tab is
      // grouped.
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      if (this.groupId !== null) {
        let grouped = false;
        try {
          await chrome.tabs.group({ tabIds: [tabId], groupId: this.groupId });
          grouped = true;
        } catch {
          this.groupId = null; // every tab of the group was closed, so the group is gone
        }
        if (grouped) {
          if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
          this.publishTab(tabId);
          return { ...tab, groupId: this.groupId };
        }
      }
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      try {
        this.groupId = await chrome.tabs.group({ tabIds: [tabId] });
        if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
        await chrome.tabGroups.update(this.groupId, { title: this.title, color: this.color });
      } catch (err) {
        if (err?.message === INPUT_CANCELLED) throw err;
        this.groupId = null;
      }
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      this.publishTab(tabId);
      return { ...tab, groupId: this.groupId };
    } finally {
      // The group is published now, so the ordinary ownership is visible and
      // the reservation may go. A failure gives it back as well.
      await this.releaseTab(tabId, reservation);
    }
  }

  /**
   * The tab this controller works on is published before the reservation that
   * held it is given back: the ordinary ownership is visible as soon as the
   * reservation is over, so nobody may take the tab in between.
   */
  publishTab(tabId) {
    this.tabId = tabId;
  }

  /** Reserves a tab while it is being grouped, when an adapter was given. */
  async reserveTab(tabId) {
    if (!this.reservation) return { ok: true, token: null };
    try {
      const res = await this.reservation.reserve(tabId);
      if (res?.ok) return { ok: true, token: res.token ?? null };
      return { ok: false, owner: res?.owner ?? 'another session' };
    } catch {
      // A reservation that cannot be taken fails closed: the tab is not touched.
      return { ok: false, owner: 'another session' };
    }
  }

  /** Gives a reservation back. */
  async releaseTab(tabId, reservation) {
    if (!this.reservation || !reservation?.token) return;
    try {
      await this.reservation.release(tabId, reservation.token);
    } catch {
      // The tab is free anyway: the session owns it through its group.
    }
  }

  async rename(title) {
    this.title = title;
    if (this.groupId === null) return;
    await chrome.tabGroups.update(this.groupId, { title }).catch(() => {}); // the group may have closed
  }

  async ensureDebuggerAttached(tabId, { signal = null, enablePage = true } = {}) {
    if (!this.attached.has(tabId)) {
      if (signal?.aborted) throw makeSignalError(signal, false);
      const epoch = this.attachEpoch;
      let inFlight = this.attaching.get(tabId);
      if (!inFlight) {
        const rawAttach = Promise.resolve().then(() => chrome.debugger.attach({ tabId }, CDP_VERSION));
        const tracked = rawAttach.then(
          () => {
            this.attaching.delete(tabId);
            if (this.attachEpoch !== epoch) {
              if (!this.attached.has(tabId)) {
                void Promise.resolve(chrome.debugger.detach?.({ tabId })).catch(() => {});
              }
              return;
            }
            this.attached.add(tabId);
          },
          (err) => {
            this.attaching.delete(tabId);
            if (String(err?.message ?? '').includes('already attached')) {
              if (this.attachEpoch === epoch) this.attached.add(tabId);
              return;
            }
            throw err;
          },
        );
        inFlight = { promise: tracked, epoch };
        this.attaching.set(tabId, inFlight);
      }
      try {
        await raceWithSignal(inFlight.promise, signal, false);
      } catch (err) {
        if (signal?.aborted) {
          void inFlight.promise.then(() => {
            if (this.attachEpoch === epoch && !this.attached.has(tabId)) {
              void Promise.resolve(chrome.debugger.detach?.({ tabId })).catch(() => {});
            } else if (this.attachEpoch === epoch && signal?.aborted) {
              this.attached.delete(tabId);
              this.pageEnabled.delete(tabId);
              void Promise.resolve(chrome.debugger.detach?.({ tabId })).catch(() => {});
            }
          }, () => {});
        }
        throw err;
      }
    }
    if (enablePage && !this.pageEnabled.has(tabId) && typeof chrome.debugger?.onEvent?.addListener === 'function') {
      if (signal?.aborted) throw makeSignalError(signal, false);
      this.pageEnabled.add(tabId);
      try {
        await raceWithSignal(Promise.resolve(chrome.debugger.sendCommand?.({ tabId }, 'Page.enable', {})), signal, false);
      } catch (err) {
        if (err?.outcome) {
          this.pageEnabled.delete(tabId);
          throw err;
        }
        // Optional in unit-test mocks that do not implement Page.enable.
      }
    }
  }

  /**
   * Sends one command to the debugger. A `guard` says whether the command may
   * still be sent: it is asked again after the debugger was attached, right
   * before the command that changes the page goes out.
   *
   * `tabId` pins the tab: a command that captured its tab keeps acting on that
   * tab, even when another tab was opened or taken while the command waited.
   * `precheck` is asked once more, right before the command goes out, for the
   * checks that live in the page (the focus of an approved field, for example).
   */
  async cdp(method, params = {}, { guard = null, tabId = null, precheck = null, signal = null, onDispatch = null } = {}) {
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    const tab = await this.pinnedTab(tabId);
    assertControllable(tab.url);
    await this.ensureDebuggerAttached(tab.id, { signal, enablePage: method !== 'Page.enable' });
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (precheck && !(await precheck())) throw new Error(INPUT_CANCELLED);
    // The precheck took time: the grant is asked once more, right before the
    // command goes out. A withdrawal that came while the page was being
    // prepared must not reach the page.
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (method !== 'Page.handleJavaScriptDialog' && this.pendingDialog(tab.id)) {
      throw makeDialogPendingError(this.pendingDialog(tab.id));
    }
    const readOnly = method === 'Page.getLayoutMetrics' || method === 'Page.captureScreenshot';
    const watcher = this.waitForDialog(tab.id);
    try {
      if (!readOnly) signal?.onDispatch?.();
      onDispatch?.();
      const commandPromise = Promise.resolve(chrome.debugger.sendCommand({ tabId: tab.id }, method, params));
      if (method === 'Page.handleJavaScriptDialog') {
        return await raceWithSignal(commandPromise, signal, !readOnly);
      }
      const res = await Promise.race([
        raceWithSignal(commandPromise, signal, !readOnly),
        watcher.promise.then((dialog) => {
          commandPromise.catch(() => {});
          throw makeDialogPendingError(dialog);
        }),
      ]);
      if (this.pendingDialog(tab.id)) {
        throw makeDialogPendingError(this.pendingDialog(tab.id));
      }
      return res;
    } finally {
      watcher.cancel();
    }
  }

  /**
   * The tab a command acts on. A pinned tab is the one that was captured when
   * the command started; without one the current tab of the session is used.
   */
  async pinnedTab(tabId) {
    if (tabId == null) return this.currentTab();
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new Error('The tab this command acts on is gone.');
    }
  }

  async detachAll() {
    this.attachEpoch += 1;
    await this.dismissAllDialogs('detach');
    const pendingAttaches = [...this.attaching.entries()];
    this.attaching.clear();
    for (const [tabId, entry] of pendingAttaches) {
      await entry.promise.catch(() => {});
      this.attached.add(tabId);
    }
    for (const tabId of [...this.attached]) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Tab closed or already detached.
      }
    }
    this.attached.clear();
    this.pageEnabled.clear();
  }

  /** Detaches one tab, leaving the others alone. */
  async detachTab(tabId) {
    this.attachEpoch += 1;
    await this.dismissPendingDialog(tabId, 'detach');
    const pending = this.attaching.get(tabId);
    if (pending) {
      this.attaching.delete(tabId);
      await pending.promise.catch(() => {});
      this.attached.add(tabId);
    }
    if (!this.attached.has(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached, or the tab is gone.
    }
    this.attached.delete(tabId);
    this.pageEnabled.delete(tabId);
  }

  /**
   * Runs a page script in a tab.
   *
   * `guard` is asked again here, right before the script goes out: the tab was
   * looked up first, and that took time. A grant that was withdrawn while the
   * script was being prepared must not reach the page.
   */
  async inject(func, args = [], { tabId = null, guard = null, frameId = null, signal = null, mutating = false } = {}) {
    if (signal?.aborted) throw makeSignalError(signal, false);
    const tab = await this.pinnedTab(tabId);
    assertControllable(tab.url);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (this.pendingDialog(tab.id)) throw makeDialogPendingError(this.pendingDialog(tab.id));
    const target = frameId == null ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frameId] };
    const watcher = this.waitForDialog(tab.id);
    try {
      if (mutating) signal?.onDispatch?.();
      const execPromise = Promise.resolve(chrome.scripting.executeScript({ target, func, args }));
      const [result] = await Promise.race([
        raceWithSignal(execPromise, signal, mutating),
        watcher.promise.then((dialog) => {
          execPromise.catch(() => {});
          throw makeDialogPendingError(dialog);
        }),
      ]);
      if (this.pendingDialog(tab.id)) throw makeDialogPendingError(this.pendingDialog(tab.id));
      return result?.result;
    } finally {
      watcher.cancel();
    }
  }

  /**
   * Injects into every frame of the tab: the page, the frames of its iframes
   * and the frames inside them. A page that renders its interface inside an
   * iframe (an app preview, an embedded editor) is otherwise invisible: only
   * the top document was ever read, and the agent could not act on what it
   * could not see.
   */
  async injectFrames(func, args = [], { tabId = null, guard = null, signal = null } = {}) {
    if (signal?.aborted) throw makeSignalError(signal, false);
    const tab = await this.pinnedTab(tabId);
    assertControllable(tab.url);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (this.pendingDialog(tab.id)) throw makeDialogPendingError(this.pendingDialog(tab.id));
    const watcher = this.waitForDialog(tab.id);
    try {
      const execPromise = Promise.resolve(chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func, args }));
      const results = await Promise.race([
        raceWithSignal(execPromise, signal, false),
        watcher.promise.then((dialog) => {
          execPromise.catch(() => {});
          throw makeDialogPendingError(dialog);
        }),
      ]);
      if (this.pendingDialog(tab.id)) throw makeDialogPendingError(this.pendingDialog(tab.id));
      return results;
    } finally {
      watcher.cancel();
    }
  }

  /** The frame of a merged snapshot index: null means the top document. */
  frameOf(index) {
    for (const frame of this.snapshotFrames ?? []) {
      if (index >= frame.offset && index < frame.offset + frame.count) return { ...frame, local: index - frame.offset };
    }
    return null;
  }

  async snapshot({ maxElements = 250, maxTextChars = 3500, signal = null } = {}) {
    const generation = (this.snapshotGeneration = (this.snapshotGeneration || 0) + 1);
    this.currentGeneration = generation;
    const results = await this.injectFrames(snapshotPage, [maxElements, maxTextChars, SECRET_RULE, generation], { signal });
    // The top document leads and owns the page text; every other frame joins
    // with its own numbered elements, their indexes shifted so one list covers
    // the whole page. The map is kept: an element action must run in the frame
    // that holds the element, with the index that frame knows.
    const ordered = (results ?? [])
      .filter((entry) => entry && entry.result && !entry.result.error)
      .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
    const main = ordered.find((entry) => entry.frameId === 0)?.result ?? ordered[0]?.result;
    if (!main) {
      this.snapshotFrames = [];
      return { url: '', title: '', generation, scroll: { y: 0, viewport: 0, height: 0 }, elements: [], offscreen: 0, text: '', dates: [] };
    }
    const frames = [];
    const lines = [];
    const dates = [...(main.dates ?? [])];
    let text = main.text ?? '';
    let offset = 0;
    for (const { frameId, result } of ordered) {
      const count = result.elements.length;
      frames.push({ frameId, offset, count });
      for (let i = 0; i < count; i += 1) {
        let line = result.elements[i];
        if (frameId !== 0) {
          const body = line.replace(/^\[\d+\]\s*/, '');
          line = `[${offset + i}] ${body} (in frame)`;
        }
        lines.push(line);
      }
      offset += count;
      // A transcript or a dialog message inside an iframe is otherwise
      // unreadable: the page text of every frame joins the main document's,
      // and the dates of every frame join the date list.
      if (frameId !== 0) {
        if (result.text) text = `${text}\n${result.text}`;
        if (Array.isArray(result.dates)) dates.push(...result.dates);
      }
    }
    this.snapshotFrames = frames;
    return { ...main, generation, elements: lines, text: text.slice(0, maxTextChars), dates: dates.slice(0, 60) };
  }

  /** Scrolls an indexed element into view and returns its centre, label and box. */
  async locate(index) {
    return this.element(index, 'locate');
  }

  /**
   * Acts on an element of the latest snapshot.
   *
   * `guard` is asked before the page is touched. `target` is the operation
   * target (see captureTarget): when there is one, the page checks it in the
   * same script that acts, right before the focus, the selection or the value
   * is changed, so an index cannot be swapped while the action waits.
   */
  async element(index, action, value = null, { guard = null, target = null, signal = null, generation = null } = {}) {
    const wantedGen = generation ?? target?.generation ?? null;
    if (wantedGen != null && this.currentGeneration != null && Number(wantedGen) !== this.currentGeneration) {
      const err = new Error(`Element [${index}] belongs to stale snapshot generation ${wantedGen} (current is ${this.currentGeneration}).`);
      err.staleGeneration = true;
      throw err;
    }
    const tab = await this.pinnedTab(target?.tabId ?? null);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    const frame = this.frameOf(index);
    const mutating = action !== 'locate';
    const result = await this.inject(
      elementAction,
      [frame ? frame.local : index, action, value, this.overlay.enabled, SECRET_RULE, target ?? null, wantedGen],
      { tabId: tab.id, guard, frameId: frame ? frame.frameId : null, signal, mutating },
    );
    if (result?.error) {
      const err = new Error(result.error);
      if (result.staleGeneration) err.staleGeneration = true;
      throw err;
    }
    return result;
  }

  /** Reads or acts on the suggestion list tied to an autocomplete field (see suggestionAction). */
  async suggestions(index, wanted, mode, { guard = null, target = null, signal = null } = {}) {
    const tab = await this.pinnedTab(target?.tabId ?? null);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    const frame = this.frameOf(index);
    const mutating = mode === 'activate';
    const result = await this.inject(suggestionAction, [frame ? frame.local : index, wanted, mode, SECRET_RULE, target ?? null], { tabId: tab.id, guard, frameId: frame ? frame.frameId : null, signal, mutating });
    if (result?.error) throw new Error(result.error);
    if (result?.target) {
      result.target.tabId = tab.id;
      // The option's token lives in the frame that registered it, and the tab
      // is what a later validation compares the address against.
      result.target.frameId = frame ? frame.frameId : null;
      result.target.url = tab.url ?? result.target.url;
    }
    return result;
  }

  async text(start, length) {
    return this.inject(pageText, [start, length, SECRET_RULE]);
  }

  /**
   * The identity of what an operation acts on: the tab, the document and the
   * element, as plain JSON.
   *
   * Nothing is scrolled, focused, flashed or read: the answer names the
   * element and nothing else. The element itself stays in the extension's own
   * world of the frame, so the page cannot swap it: a cloned marker, an
   * element that was taken out of the page, an element that was re-indexed and
   * a document that was replaced all fail when the target is resolved again.
   *
   * `kind` says what to name:
   *   - 'element' (with `index`, the index of the latest snapshot),
   *   - 'point' (with `x` and `y`, the element under that point),
   *   - 'focus' (the element that has the focus, deep inside a shadow root if
   *     that is where it is),
   *   - 'tab' (the tab itself, with `tabId` when another tab is named: the tab
   *     is not taken and not grouped, it is only named).
   *
   * A tab-scoped target names the tab and the document it had, not an
   * element: it is the target of a navigation, a history step or a tab switch.
   * An element target that could not be captured stays an element target: it
   * is not widened into a tab target.
   *
   * A page that cannot be read (a blank page, a page of Chrome itself) still
   * gets a target: the tab is named, and a navigation may act on it.
   */
  async captureTarget({ kind = 'focus', index = null, x = null, y = null, tabId = null, generation = null } = {}) {
    if (kind === 'tab') {
      // The tab is named, not taken: the session keeps the tab it works on.
      const tab = await this.pinnedTab(tabId);
      const target = {
        scope: 'tab',
        kind: 'tab',
        tabId: tab.id,
        url: tab.url ?? '',
        documentId: null,
        element: null,
        capturedAt: Date.now(),
      };
      // The document of the tab, when it can be read. A page of Chrome itself
      // cannot be read: the tab and its address are what was approved then.
      try {
        const res = await this.inject(permissionTarget, ['document', {}, SECRET_RULE], { tabId: tab.id });
        target.documentId = res?.documentId ?? null;
      } catch {
        // A page that cannot be read leaves the target on the tab alone.
      }
      return target;
    }
    const tab = tabId == null ? await this.currentTab() : await this.pinnedTab(tabId);
    const target = {
      scope: 'element',
      kind,
      tabId: tab.id,
      url: tab.url ?? '',
      documentId: null,
      generation: this.currentGeneration ?? null,
      element: null,
      frameId: null,
      capturedAt: Date.now(),
    };
    if (kind === 'element' && generation != null && this.currentGeneration != null && Number(generation) !== this.currentGeneration) {
      target.staleGeneration = true;
      return target;
    }
    if (RESTRICTED.test(target.url)) return target;
    try {
      if (kind === 'focus') {
        // The focus may live in a child frame: the top document then only
        // holds the iframe element. Every frame is asked, and the frame whose
        // focused element is a real element — not an iframe slot, and not an
        // unfocused body — wins. The top frame is ordered first, so with no
        // better answer the top document keeps what it captured.
        const results = await this.injectFrames(permissionTarget, ['capture', { kind: 'focus' }, SECRET_RULE], { tabId: tab.id });
        let picked = null;
        for (const entry of results ?? []) {
          if (!entry?.result?.ok) continue;
          const element = entry.result.element;
          const slot = element?.tag === 'iframe' || Boolean(element?.body);
          if (picked && !slot && picked.result.element?.tag !== 'iframe' && !picked.result.element?.body) continue;
          if (!picked || (picked.result.element?.tag === 'iframe' || picked.result.element?.body) && !slot) picked = entry;
        }
        if (picked) {
          target.documentId = picked.result.documentId ?? null;
          target.generation = picked.result.generation ?? this.currentGeneration ?? null;
          target.element = picked.result.element ?? null;
          target.frameId = picked.frameId ? picked.frameId : null;
        }
      } else {
        const frame = kind === 'element' ? this.frameOf(index) : null;
        const res = await this.inject(
          permissionTarget,
          ['capture', { kind, index: frame ? frame.local : index, x, y, ...(generation != null ? { generation: Number(generation) } : {}) }, SECRET_RULE],
          { tabId: tab.id, frameId: frame ? frame.frameId : null },
        );
        if (res?.staleGeneration) {
          target.staleGeneration = true;
          target.generation = res.currentGeneration ?? this.currentGeneration ?? null;
          return target;
        }
        if (!res?.ok) return target;
        target.documentId = res.documentId ?? null;
        target.generation = res.generation ?? this.currentGeneration ?? null;
        target.element = res.element ?? null;
        target.frameId = frame ? frame.frameId : null;
      }
    } catch {
      // A page that cannot be read leaves the target on the tab alone.
    }
    return target;
  }

  /**
   * Whether the target is still what it was when it was captured: the same
   * tab, the same document and the same element.
   *
   * This is what a guard asks for right before an effect or a read goes out.
   * The answer is a plain object: `{ ok: true, ... }` or `{ ok: false, reason }`.
   *
   * A tab-scoped target is checked by the tab and by the document it had: the
   * element is not part of it, and a target without an element is not widened
   * into one.
   *
   * The guard of an executor asks twice, because the check of the page takes
   * time and the grant may be withdrawn while it runs:
   *
   *   const { permit } = await authority.authorize(operation, { signal });
   *   const guard = async () => {
   *     if (!authority.grantValid(permit, operation)) return false;  // before the check
   *     const check = await browser.validateTarget(target);          // the page is asked
   *     return authority.grantValid(permit, operation) && check.ok; // again, right before
   *   };
   *
   * The authority is asked again after the check of the page, not only before
   * it: a grant that was withdrawn while the page was being looked at must
   * not reach the page. There is one authority, and it is not here.
   */
  async validateTarget(target, { tabId = null } = {}) {
    if (!target || typeof target !== 'object') return { ok: false, reason: 'no-target' };
    const tab = target.tabId ?? tabId;
    if (tab == null) return { ok: false, reason: 'no-tab' };
    let live;
    try {
      live = await chrome.tabs.get(tab);
    } catch {
      return { ok: false, reason: 'tab-gone' };
    }
    // The page went somewhere else: what was approved is not there any more.
    if (target.url && stripHash(live.url ?? '') !== stripHash(target.url)) return { ok: false, reason: 'navigated' };
    if (target.scope === 'tab') {
      // The tab is the target: the document it had is checked as well, when it
      // could be read when the target was captured.
      if (target.documentId) {
        try {
          const res = await this.inject(permissionTarget, ['document', {}, SECRET_RULE], { tabId: tab });
          if (!res?.documentId) return { ok: false, reason: 'page-unreadable' };
          if (res.documentId !== target.documentId) return { ok: false, reason: 'document-changed' };
        } catch {
          // A previously captured document cannot silently become tab-only
          // consent when its identity can no longer be checked.
          return { ok: false, reason: 'page-unreadable' };
        }
      }
      return { ok: true, scope: 'tab', tabId: tab, url: live.url ?? '' };
    }
    if (!target.element) return { ok: false, reason: 'no-element' };
    try {
      const res = await this.inject(permissionTarget, ['resolve', { target }, SECRET_RULE], { tabId: tab, frameId: target.frameId ?? null });
      return res?.ok ? res : { ok: false, reason: res?.reason ?? 'no-answer' };
    } catch {
      return { ok: false, reason: 'page-unreadable' };
    }
  }

  /**
   * The current value of the approved field.
   *
   * This is the only way a selected value leaves the page: the ordinary
   * snapshot shows the values of the ordinary fields, but never the value of a
   * field that holds a secret. The target is checked first, then the guard,
   * and the value is read in the page, in the element itself: a field that was
   * replaced, an element that was taken out of the page and a field that
   * cannot be written to are all refused.
   *
   * The guard is not optional: a value is only read after it was approved.
   */
  async readField(target, { guard = null } = {}) {
    if (typeof guard !== 'function') {
      throw new Error('A selected value is only read after it was approved: readField needs a guard.');
    }
    const check = await this.validateTarget(target);
    if (!check.ok) throw new Error(`The field that was approved is not there any more (${check.reason}).`);
    if (!(await guard())) throw new Error(INPUT_CANCELLED);
    // The guard is asked again by the injection, right before the script runs:
    // the tab was looked up first, and that took time.
    const res = await this.inject(permissionTarget, ['read', { target }, SECRET_RULE], { tabId: target.tabId, guard, frameId: target.frameId ?? null });
    if (!res?.ok) throw new Error(`The field that was approved cannot be read (${res?.reason ?? 'unknown'}).`);
    return { ok: true, value: res.value, tag: res.tag ?? '', secret: Boolean(res.secret) };
  }

  /**
   * Puts the focus on the approved element, so that text can be typed into it.
   * The element must still be the one that was approved: a page that moved the
   * focus to another field in the meantime gets nothing.
   */
  async focusTarget(target, { guard = null } = {}) {
    const check = await this.validateTarget(target);
    if (!check.ok) throw new Error(`The field that was approved is not there any more (${check.reason}).`);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // The guard is asked again by the injection, right before the script runs.
    const res = await this.inject(permissionTarget, ['apply-focus', { target }, SECRET_RULE], { tabId: target.tabId, guard, frameId: target.frameId ?? null });
    if (!res?.ok) throw new Error(`The focus could not be put on the approved field (${res?.reason ?? 'unknown'}).`);
    return res;
  }

  /**
   * An iframe keeps its document.activeElement after the keyboard focus has
   * moved back out of it: a frame-local check alone would then pass while the
   * text is really going somewhere else. For a target inside a child frame,
   * the top document must hold the focus chain's iframe slot as well.
   */
  async assertFocusChain(target, { guard = null } = {}) {
    if (!target.frameId) return true;
    const chained = await this.inject(focusInFrame, [], { tabId: target.tabId, guard });
    if (!chained) throw new Error(INPUT_CANCELLED);
    return true;
  }

  /**
   * Asks the page whether the text would go into the element that was
   * approved: the focus must still be there, and it must be a field that can
   * be written to (never the body, never a field that is read-only or disabled).
   */
  async assertTypingTarget(target, { guard = null } = {}) {
    await this.assertFocusChain(target, { guard });
    const res = await this.inject(permissionTarget, ['typing', { target }, SECRET_RULE], { tabId: target.tabId, guard, frameId: target.frameId ?? null });
    if (!res?.ok) throw new Error(INPUT_CANCELLED);
    return true;
  }

  /** Asks the page whether the focus is still the one that was approved. */
  async assertFocusTarget(target, { guard = null } = {}) {
    await this.assertFocusChain(target, { guard });
    const res = await this.inject(permissionTarget, ['focus', { target }, SECRET_RULE], { tabId: target.tabId, guard, frameId: target.frameId ?? null });
    if (!res?.ok) throw new Error(INPUT_CANCELLED);
    return true;
  }

  /** The approved original must still receive input at this exact point. */
  async assertHitTarget(target, x, y, { guard = null } = {}) {
    const res = await this.inject(permissionTarget, ['hit', { target, x, y }, SECRET_RULE], { tabId: target.tabId, guard, frameId: target.frameId ?? null });
    if (!res?.ok) throw new Error(INPUT_CANCELLED);
    return true;
  }

  /**
   * The control a screenshot point would really land on, with the point
   * clamped inside its box: exposed so a click_at captures and approves the
   * snapped point instead of the raw one.
   */
  async snapPoint(x, y, { tabId = null } = {}) {
    return this.inject(pointSnap, [x, y], { tabId });
  }

  /** Whether an element of the latest snapshot lives outside the top document. */
  elementFrame(index) {
    // Frame 0 is the top document itself: only a real child frame takes the
    // in-frame paths. CDP input of the top document is the trusted route for
    // everything else.
    const frameId = this.frameOf(index)?.frameId;
    return frameId ? frameId : null;
  }

  /**
   * Scrolls the scrollable area under a point: a chat transcript, a feed or an
   * inner pane has its own scroller, and a page-level wheel never moves it.
   * Real wheel input at the point is used, because the browser hands it to the
   * innermost scroller under the coordinates — inside iframes included — the
   * same way it hands a user's wheel.
   */
  async scrollAt(x, y, direction, screens = 1, { guard = null, tabId = null, signal = null } = {}) {
    const sign = direction === 'up' ? -1 : 1;
    const amount = sign * Math.min(Math.max(Number(screens) || 1, 0.2), 10);
    return this.scroll(amount, { x, y }, { guard, tabId, signal });
  }

  async navigate(url, { guard = null, tabId = null, signal = null } = {}) {
    assertHttpUrl(url);
    const tab = await this.pinnedTab(tabId);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (typeof chrome.debugger?.onEvent?.addListener === 'function' && !RESTRICTED.test(tab.url ?? '')) {
      await this.ensureDebuggerAttached(tab.id, { signal, enablePage: true });
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      if (signal?.aborted) throw makeSignalError(signal, false);
    }
    signal?.onDispatch?.();
    await raceWithSignal(chrome.tabs.update(tab.id, { url }), signal, true);
    await this.waitForLoad({ expectNavigation: true, tabId: tab.id, signal, afterMutation: true });
  }

  async history(direction, { guard = null, tabId = null, signal = null } = {}) {
    const tab = await this.pinnedTab(tabId);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    if (signal?.aborted) throw makeSignalError(signal, false);
    if (typeof chrome.debugger?.onEvent?.addListener === 'function' && !RESTRICTED.test(tab.url ?? '')) {
      await this.ensureDebuggerAttached(tab.id, { signal, enablePage: true });
      if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
      if (signal?.aborted) throw makeSignalError(signal, false);
    }
    signal?.onDispatch?.();
    if (direction === 'back') await raceWithSignal(chrome.tabs.goBack(tab.id), signal, true);
    else if (direction === 'forward') await raceWithSignal(chrome.tabs.goForward(tab.id), signal, true);
    else await raceWithSignal(chrome.tabs.reload(tab.id), signal, true);
    await this.waitForLoad({ expectNavigation: true, tabId: tab.id, signal, afterMutation: true });
  }

  async clickAt(x, y, { button = 'left', clickCount = 1, wait = true, guard = null, target = null, tabId = null, signal = null } = {}) {
    // The tab is taken now and kept: a click must not land in a tab that was
    // opened while it waited.
    const tab = await this.pinnedTab(tabId ?? target?.tabId ?? null);
    if (target && target.tabId !== tab.id) throw new Error(INPUT_CANCELLED);
    // The model reads a JPEG, and its point lands near a control more often
    // than on one: the point is clamped inside the box of the control under
    // it, so the cursor and the press land exactly on the field. A point that
    // is already inside its control stays exactly where the model aimed it.
    try {
      const snapped = await this.inject(pointSnap, [x, y], { tabId: tab.id, signal });
      if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) {
        x = snapped.x;
        y = snapped.y;
      }
    } catch (err) {
      if (err?.dialogPending || err?.outcome) throw err;
      // An unsnappable point (a snapshot that just left, a blank page) is
      // clicked where the model aimed it.
    }
    const precheck = target ? () => this.assertHitTarget(target, x, y, { guard }) : null;
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, { guard, tabId: tab.id, precheck, signal });
    await this.overlay.click(x, y);
    for (let i = 1; i <= clickCount; i += 1) {
      let pressed = false;
      let releaseSent = false;
      try {
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i }, {
          guard,
          tabId: tab.id,
          precheck,
          signal,
          onDispatch: () => { pressed = true; },
        });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i }, {
          tabId: tab.id,
          signal,
          onDispatch: () => { releaseSent = true; },
        });
      } finally {
        if (pressed && !releaseSent) {
          await Promise.resolve(
            chrome.debugger.sendCommand?.({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i }),
          ).catch(() => {});
        }
      }
    }
    if (wait) await this.waitForLoad({ tabId: tab.id, signal, afterMutation: true });
  }

  async hoverAt(x, y, { guard = null, target = null, tabId = null, signal = null } = {}) {
    const tab = await this.pinnedTab(tabId ?? target?.tabId ?? null);
    if (target && target.tabId !== tab.id) throw new Error(INPUT_CANCELLED);
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // The guard goes with the command: the debugger is attached first, and
    // that takes time.
    const precheck = target ? () => this.assertHitTarget(target, x, y, { guard }) : null;
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, { guard, tabId: tab.id, precheck, signal });
    await delay(300, signal);
  }

  /**
   * Types text into whatever has the focus.
   *
   * With a `target`, the text only goes into the element that was approved:
   * the page is asked, right before the text goes out, whether the focus is
   * still that element and whether it is a field that can be written to. The
   * focus is approved for one element: a field that took the focus in the
   * meantime does not inherit the approval.
   */
  async insertText(text, { guard = null, target = null, tabId = null, signal = null } = {}) {
    if (target && tabId != null && tabId !== target.tabId) throw new Error(INPUT_CANCELLED);
    tabId ??= target?.tabId ?? null;
    const precheck = target ? () => this.assertTypingTarget(target, { guard }) : null;
    await this.cdp('Input.insertText', { text }, { guard, tabId, precheck, signal });
  }

  /**
   * Presses a key or chord such as "Enter", "Control+A" or "Shift+Tab".
   *
   * With a `target`, the key only goes to the element that was approved: the
   * focus must still be that element. Enter on the body is an ordinary thing
   * to do, and the body is approved as the body it was.
   */
  async pressKey(combo, { wait = true, guard = null, target = null, tabId = null, signal = null } = {}) {
    if (target && tabId != null && tabId !== target.tabId) throw new Error(INPUT_CANCELLED);
    tabId ??= target?.tabId ?? null;
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop();
    const modifiers = parts.reduce((mask, m) => mask | (MODIFIERS[m] ?? 0), 0);
    const spec = KEYS[keyName] ?? {
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
      text: keyName.length === 1 && !(modifiers & ~MODIFIERS.Shift) ? keyName : undefined,
    };
    const base = {
      key: spec.key ?? keyName,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    };
    const precheck = target ? () => this.assertFocusTarget(target, { guard }) : null;
    let pressed = false;
    let releaseSent = false;
    const targetTab = await this.pinnedTab(tabId);
    try {
      await this.cdp('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text }, {
        guard,
        tabId: targetTab.id,
        precheck,
        signal,
        onDispatch: () => { pressed = true; },
      });
      // The key is always let go, or it stays down in the page.
      await this.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, {
        tabId: targetTab.id,
        signal,
        onDispatch: () => { releaseSent = true; },
      });
    } finally {
      if (pressed && !releaseSent) {
        await Promise.resolve(
          chrome.debugger.sendCommand?.({ tabId: targetTab.id }, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }),
        ).catch(() => {});
      }
    }
    if (wait) await this.waitForLoad({ tabId: targetTab.id, signal, afterMutation: true });
  }

  /** Scrolls by a number of screens (negative = up) at a point, default viewport centre. */
  async scroll(screens, at = null, { guard = null, target = null, tabId = null, signal = null } = {}) {
    const tab = await this.pinnedTab(tabId ?? target?.tabId ?? null);
    if (target && target.tabId !== tab.id) throw new Error(INPUT_CANCELLED);
    const metrics = await this.cdp('Page.getLayoutMetrics', {}, { tabId: tab.id, signal });
    const vp = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const x = at?.x ?? vp.clientWidth / 2;
    const y = at?.y ?? vp.clientHeight / 2;
    const deltaY = Math.round(vp.clientHeight * 0.85 * screens);
    // The metrics took time: the guard is asked again right before the wheel
    // turns, so a scroll that was withdrawn never reaches the page.
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    // The guard goes with the command: the tab is looked up again, and that
    // takes time.
    const precheck = target?.element ? () => this.assertHitTarget(target, x, y, { guard }) : null;
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, { guard, tabId: tab.id, precheck, signal });
    await delay(150, signal); // smooth scrolling and lazy-loaded content start after the wheel event
    await this.settle({ tabId: tab.id, signal });
  }

  /** JPEG screenshot of the viewport in CSS pixels, so coordinates match clickAt. */
  async screenshot({ signal = null } = {}) {
    const metrics = await this.cdp('Page.getLayoutMetrics', {}, { signal });
    const vp = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const dpr = (await this.inject(devicePixelRatioOf, [], { signal })) || 1;
    const { data } = await this.overlay.hiddenDuring(() => this.cdp('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr },
    }, { signal }));
    return { dataUrl: `data:image/jpeg;base64,${data}`, width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) };
  }

  // @store-strip-start
  async evaluate(expression, { guard = null, tabId = null, signal = null } = {}) {
    if (guard && !(await guard())) throw new Error(INPUT_CANCELLED);
    const { result, exceptionDetails } = await this.cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, { guard, tabId, signal });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
  // @store-strip-end

  /** Waits for any navigation the last action triggered to finish loading. */
  async waitForLoad({ expectNavigation = false, timeoutMs = 12000, tabId = null, signal = null, afterMutation = true } = {}) {
    const resolvedTabId = tabId ?? this.tabId;
    const rethrowPostMutationAbort = (err) => {
      if (afterMutation && (signal?.aborted || err?.outcome === 'cancelled')) {
        throw makeSignalError(signal, true);
      }
      throw err;
    };
    try {
      if (this.pendingDialog(resolvedTabId)) throw makeDialogPendingError(this.pendingDialog(resolvedTabId));
      await delay(expectNavigation ? 400 : 120, signal); // long enough for a click to start a navigation
      if (this.pendingDialog(resolvedTabId)) throw makeDialogPendingError(this.pendingDialog(resolvedTabId));
      if (signal?.aborted) throw makeSignalError(signal, afterMutation);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw makeSignalError(signal, afterMutation);
        if (this.pendingDialog(resolvedTabId)) throw makeDialogPendingError(this.pendingDialog(resolvedTabId));
        let tab;
        try {
          tab = await this.pinnedTab(tabId);
        } catch {
          break; // the tab this command acts on is gone.
        }
        if (this.pendingDialog(tab.id)) throw makeDialogPendingError(this.pendingDialog(tab.id));
        if (tab.status === 'complete') {
          if (RESTRICTED.test(tab.url ?? '')) return;
          try {
            const state = await this.inject(pageReadyState, [], { tabId: tab.id, signal });
            if (state?.readyState === 'complete' || state?.readyState === 'interactive') break;
          } catch (err) {
            if (err?.dialogPending || err?.outcome) throw err;
            // Page is mid-navigation; keep polling.
          }
        }
        await delay(250, signal);
      }
      if (this.pendingDialog(resolvedTabId)) throw makeDialogPendingError(this.pendingDialog(resolvedTabId));
      if (signal?.aborted) throw makeSignalError(signal, afterMutation);
      await this.settle({ tabId, signal });
      if (this.pendingDialog(resolvedTabId)) throw makeDialogPendingError(this.pendingDialog(resolvedTabId));
      if (signal?.aborted) throw makeSignalError(signal, afterMutation);
      await this.overlay.frame(); // a navigation wipes the overlay; bring it back
    } catch (err) {
      rethrowPostMutationAbort(err);
    }
  }

  /** The current document's identity, or null when the page cannot be read. */
  async documentId({ tabId = null, signal = null } = {}) {
    try {
      return await this.inject(documentIdOf, [], { tabId, signal });
    } catch {
      return null;
    }
  }

  async settle({ tabId = null, signal = null } = {}) {
    try {
      await this.inject(domSettled, [SETTLE_QUIET_MS, SETTLE_MAX_MS, SETTLE_FIRST_MS], { tabId, signal });
    } catch (err) {
      if (err?.dialogPending) throw err;
      // Restricted or mid-navigation page: nothing to wait for.
    }
  }
}

function makeDialogPendingError(dialog) {
  const err = new Error(`A JavaScript ${dialog.type} dialog opened on the page: "${dialog.message}"`);
  err.dialogPending = true;
  err.dialog = dialog;
  return err;
}

function makeSignalError(signal, dispatched) {
  const isTimeout = signal?.reason === 'timeout' || signal?.reason?.name === 'TimeoutError';
  const why = isTimeout ? 'The tool call timed out' : 'The task was stopped';
  if (!dispatched) {
    const err = new Error(`${why} before the action was sent to the browser (outcome: cancelled).`);
    err.outcome = 'cancelled';
    return err;
  }
  const err = new Error(`${why} after the command had already reached Chrome; its outcome is unknown (outcome: unknown). Check the page state before repeating the action; do not repeat it automatically.`);
  err.outcome = 'unknown';
  return err;
}

function raceWithSignal(promise, signal, dispatched) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeSignalError(signal, false));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(makeSignalError(signal, dispatched));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function assertHttpUrl(url = '') {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`Invalid URL "${url}". Only http and https URLs are allowed.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Navigation to "${parsed.protocol}" URLs is not allowed; only http and https URLs are permitted.`);
  }
}

function assertControllable(url = '') {
  if (RESTRICTED.test(url)) {
    throw new Error(`Chrome does not allow extensions to control ${url.split('/').slice(0, 3).join('/')}. Navigate to a normal website first.`);
  }
}

/** The address of a page without the part that only the page itself changes. */
function stripHash(url = '') {
  const at = url.indexOf('#');
  return at === -1 ? url : url.slice(0, at);
}

function delay(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = signal ? () => {
      clearTimeout(timer);
      resolve();
    } : null;
    if (onAbort) signal.addEventListener('abort', onAbort, { once: true });
  });
}
