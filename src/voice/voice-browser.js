// The browser the fast voice path acts on.
//
// The panel may read a tab; it may not change one. Every change — a
// navigation, a new tab, a click, a keystroke, a scroll, a zoom, a tab that is
// closed — leaves the panel and goes to the worker, which is the only place
// that may decide whether it may happen. The worker asks the session's access
// authority, the authority asks the user (or does not, under Full access), and
// only the action that was allowed runs.
//
// Three rules hold here:
//   - the tab the command started on stays its target; nothing is retargeted
//     behind the user's back, and a tab another session or another panel is
//     working in is refused (a lookup that cannot answer stops the step);
//   - the command holds a claim on the tab it reads or changes, so a task
//     that starts at the same moment cannot work on the same page;
//   - the page is only read here. A click, a keystroke and Enter are real
//     input, sent through the worker to the debugger: a site that ignores
//     untrusted events cannot tell them from a user's.
//
// The command itself is bound to the authority before it is even planned: the
// claim hands back the context the worker keeps for it, and every later
// action names that context. A command that was withdrawn — because the mode
// moved, because the user stopped it, because the panel went away — finds no
// context any more, and nothing it wanted happens.
//
// The shape of a request is fixed: the name of the action, the tab it acts
// on, the lease of that tab, the command it belongs to, and the arguments of
// the action under `args`. The name of the action is never taken from the
// arguments, and the source of a function never travels at all.

import { request } from '../sidepanel/request.js';
import * as page from './voice-page.js';

// The scripts the page may run, by name. The name travels, never the source:
// the worker holds the functions and runs the one that was named, so a panel
// cannot send a function of its own into a page.
const SCRIPTS = new Map([
  [page.pageProbe, { script: 'pageProbe', action: 'probe' }],
  [page.scrollPage, { script: 'scrollPage', action: 'scroll' }],
  [page.mediaControl, { script: 'mediaControl', action: 'media' }],
  [page.findText, { script: 'findText', action: 'find' }],
]);

// The direction of a scroll, a media control and a page search is part of the
// action, so the worker knows what is about to happen before it asks.
const SCROLL_DIRECTIONS = { down: 'scroll_down', up: 'scroll_up', top: 'scroll_top', bottom: 'scroll_bottom' };
const MEDIA_ACTIONS = { toggle: 'media_play_pause', mute: 'media_mute' };

function abortError() {
  return new DOMException('Stopped by user', 'AbortError');
}

/**
 * The Chrome browser. `sessionId` is the panel's own session: a tab another
 * running session is working in is refused, so two sessions never act on the
 * same page. `target` is the pinned tab (or a function that returns it).
 * `panelId` names this panel, so the claim it takes is its own.
 */
export function createChromeBrowser({ sessionId = null, target = null, panelId = null } = {}) {
  // The lease this panel holds on every tab it works on. The token names the
  // lease, so a request that is late cannot act on a lease that was replaced.
  const leases = new Map();
  // The command the worker is holding for this panel: the context every
  // action of the command names. It comes with the claim, before the command
  // is planned, so nothing of it may run under a context that has moved.
  let command = null;

  /**
   * One action of the voice path, asked of the worker.
   *
   * The worker answers with `{ ok: true, ... }` or with a refusal and the
   * message key the panel shows. A worker that cannot answer does nothing:
   * the action fails closed.
   */
  const act = async (action, { tabId = null, args = null, ...rest } = {}) => {
    try {
      const res = await request('voice-action', {
        ...rest,
        // The name of the action is the worker's own: it is never taken from
        // the arguments of the action.
        action,
        sessionId,
        panelId,
        commandId: command?.id ?? null,
        tabId,
        token: tabId == null ? null : (leases.get(tabId) ?? null),
        args: args ?? null,
      });
      return res ?? { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    } catch {
      return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
    }
  };

  return {
    async currentTab() {
      const pinned = typeof target === 'function' ? await target() : target;
      if (target !== null && !pinned) return null;
      if (pinned) {
        const tab = await chrome.tabs.get(pinned.id).catch(() => null);
        if (!tab) return null;
        return { id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return null;
      return { id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
    },

    async tabsInWindow(windowId) {
      const tabs = await chrome.tabs.query({ windowId });
      return tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '', active: tab.active }));
    },

    async getTab(tabId) {
      const tab = await chrome.tabs.get(tabId);
      return { id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
    },

    /** Moves a tab to another address. The worker asks about it first. */
    async updateTab(tabId, { url } = {}) {
      return act('navigate', { tabId, args: { url: String(url ?? '') } });
    },

    /**
     * Opens a tab without the focus. The worker creates it, and the tab is
     * only shown after it was claimed and bound to this session.
     *
     * `tabId` is the tab the command is on: the lease that covers it is the
     * one the worker checks.
     */
    async openTab({ url, windowId, tabId = null } = {}) {
      const res = await act('open_tab', { tabId, args: { url: String(url ?? ''), windowId: windowId ?? null } });
      return res?.ok ? (res.tab ?? null) : null;
    },

    /** Makes a tab the one the user sees. The caller has bound it first. */
    async activateTab(tabId) {
      return act('switch_tab', { tabId, args: { tabId } });
    },

    /**
     * Binds a tab to this session, so the panel that follows the focused tab
     * stays in this session instead of opening another one.
     */
    async bindSession(tabId) {
      try {
        await request('bind-tab', { tabId, sessionId });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    /**
     * Closes a tab. A tab that this command opened and never showed is an
     * orphan: it is closed without a question, because it was never the user's
     * to keep.
     */
    async removeTab(tabId, { orphan = false } = {}) {
      return act(orphan ? 'discard_tab' : 'close_tab', { tabId, args: { tabId } });
    },

    async goBack(tabId) {
      return act('history', { tabId, args: { action: 'back' } });
    },

    async goForward(tabId) {
      return act('history', { tabId, args: { action: 'forward' } });
    },

    async reload(tabId) {
      return act('history', { tabId, args: { action: 'reload' } });
    },

    /**
     * Changes the zoom of a tab. The worker reads the zoom and works out the
     * new level itself, so the level that is changed is the level the user
     * saw when they said yes.
     */
    async zoom(tabId, mode) {
      return act(`zoom_${mode}`, { tabId, args: {} });
    },

    /**
     * Runs one of the page scripts. The name of the script travels, never its
     * source: the worker holds the functions and runs the one that was named.
     *
     * A reading of the page gives its answer itself: the elements of the page
     * or what has the focus. A change gives the answer of the worker, which
     * says whether it happened.
     */
    async inject(tabId, func, args = [], { signal } = {}) {
      if (signal?.aborted) throw abortError();
      const known = SCRIPTS.get(func);
      if (!known) throw new Error('this page script is not one the voice path may run');
      if (known.action === 'probe') {
        // The elements of the page, or what has the focus. The worker keeps
        // the rule and reads only what it may read.
        const res = await act('probe', { tabId, script: known.script, args: { kind: args?.[0] ?? null, arg: args?.[1] ?? null } });
        if (!res?.ok) return res;
        return res.result ?? null;
      }
      if (known.action === 'scroll') {
        const direction = SCROLL_DIRECTIONS[args?.[0]] ?? 'scroll_down';
        return act(direction, { tabId, script: known.script, args: { direction: args?.[0] ?? 'down' } });
      }
      if (known.action === 'media') {
        const action = MEDIA_ACTIONS[args?.[0]] ?? 'media_play_pause';
        return act(action, { tabId, script: known.script, args: {} });
      }
      return act('find_on_page', { tabId, script: known.script, args: { text: String(args?.[0] ?? '') } });
    },

    /**
     * Real input on the tab: a click, a key, text. The worker sends it
     * through the debugger, so the page sees what a user's hand would do. The
     * element the user approved travels with it, so the worker can resolve it
     * again after the queue and check that the focus is still where it was.
     * A worker that cannot answer fails closed: nothing is done.
     */
    async input(tabId, steps, { element = null, expected = null, action = 'click' } = {}) {
      const args = { element };
      if (action === 'type_text') {
        args.text = String(steps?.find((step) => step.op === 'text')?.text ?? '');
        args.submit = Boolean(steps?.some((step) => step.op === 'key' && step.key === 'Enter'));
      }
      return act(action, { tabId, args, element, expected, steps });
    },

    /**
     * Reads the value of one field. It is the only way a value leaves the
     * page, and the worker only reads it after the user allowed that read.
     */
    async readField(tabId, element, { expected = null } = {}) {
      return act('read_field', { tabId, args: { element }, element, expected });
    },

    /**
     * Types into the field that has the focus right now, without naming it.
     * The worker names that field itself and asks about it.
     */
    async insertText(tabId, text) {
      return act('insert_text', { tabId, args: { text: String(text ?? '') }, steps: [{ op: 'text', text: String(text ?? '') }] });
    },

    /**
     * Resolves when the tab finished loading, and rejects when the command is
     * cancelled: a cancelled command must never look like a finished one.
     */
    waitForLoad(tabId, { signal, timeout = 12000 } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        let loaded = false;
        let aborted = false;
        let settleTimer = null;
        const cleanup = () => {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          clearTimeout(settled);
          clearTimeout(settleTimer);
          signal?.removeEventListener('abort', stop);
        };
        const finish = () => {
          if (loaded || aborted) return;
          loaded = true;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          clearTimeout(settled);
          // The page needs a moment to settle. A cancellation in that moment
          // is a cancellation, not a success.
          settleTimer = setTimeout(() => {
            if (aborted) return;
            signal?.removeEventListener('abort', stop);
            resolve();
          }, 200);
        };
        const stop = () => {
          if (aborted) return;
          aborted = true;
          cleanup();
          reject(abortError());
        };
        const listener = (id, info) => {
          if (id === tabId && info.status === 'complete') finish();
        };
        const timer = setTimeout(finish, timeout);
        // A click that does not navigate leaves the page ready: it must not
        // wait for the whole timeout.
        const settled = setTimeout(() => {
          chrome.tabs.get(tabId).then((tab) => {
            if (tab.status === 'complete') finish();
          }, () => {});
        }, 500);
        signal?.addEventListener('abort', stop, { once: true });
        chrome.tabs.onUpdated.addListener(listener);
      });
    },

    /**
     * The title of the session that is working in this tab, or null when the
     * tab is free. The claim this panel holds is its own: it does not make the
     * tab busy for itself. A lookup that cannot answer fails: the caller stops
     * the step rather than act on a tab it does not own.
     */
    async ownerOf(tabId) {
      const res = await request('tab-owner', { tabId, sessionId, panelId });
      return res?.taken ? res.owner : null;
    },

    /**
     * The claim on a tab: only one command at a time may hold it, and it is
     * held before the tab is read or changed. A claim that cannot be taken
     * names the one that holds it. The token of the lease is kept, so the
     * input that follows may only be sent under that lease.
     *
     * The claim also hands back the command the worker holds for this panel:
     * the context every later action names. It comes before the command is
     * planned, so a step that was planned under an older mode cannot run
     * under a newer one.
     */
    async claim(tabId) {
      const res = await request('voice-claim', { tabId, panelId, sessionId });
      if (res?.ok && res.token) leases.set(tabId, res.token);
      if (res?.command) command = res.command;
      return res ?? { ok: false, owner: null };
    },

    /** Gives the claim back, so the tab is free for the next command. */
    async release(tabId) {
      const token = leases.get(tabId) ?? null;
      try {
        await request('voice-release', { tabId, panelId, token });
      } catch {
        /* the worker is gone: the claim is gone with it */
      } finally {
        leases.delete(tabId);
      }
    },

    /** Gives every claim of this panel back. */
    async releaseAll() {
      try {
        await request('voice-release-all', { panelId });
      } catch {
        /* the worker is gone: the claims are gone with it */
      } finally {
        leases.clear();
        command = null;
      }
    },

    /**
     * The command is over: the worker drops the context it held for it, so
     * nothing of it may run any more. The claims go with it.
     */
    async cancel() {
      const cancelled = command;
      try {
        await request('voice-cancel', { panelId, sessionId, commandId: cancelled?.id ?? null });
      } catch {
        /* the worker is gone: the command is gone with it */
      } finally {
        if (command === cancelled) command = null;
      }
    },
  };
}
