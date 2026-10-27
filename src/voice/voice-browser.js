// The browser the fast voice path acts on. Chrome's calls sit behind one
// object, so the runner can be exercised without Chrome and so every step
// knows which tab it is allowed to touch.
//
// The tab the command acts on is pinned: the microphone window that asks for
// the permission takes the focus, and the active tab would then be that
// window instead of the page the user meant.
//
// Two rules hold here:
//   - a tab is read or changed only while this command holds the claim on it,
//     so another session or another panel cannot work on the same page;
//   - the page is only read here. A click, a keystroke and Enter are real
//     input, sent through the worker to the debugger, never a fake event.

import { request } from '../sidepanel/request.js';

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/;

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
  return {
    async currentTab() {
      const pinned = typeof target === 'function' ? await target() : target;
      if (target !== null && !pinned) return null;
      if (pinned) {
        const tab = await chrome.tabs.get(pinned.id).catch(() => null);
        if (!tab || RESTRICTED.test(tab.url ?? '')) return null;
        return { id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || RESTRICTED.test(tab.url ?? '')) return null;
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

    /** Opens a tab without the focus: it is bound and claimed before it is shown. */
    async openTab({ url, windowId }) {
      const created = await chrome.tabs.create({ url: url || undefined, windowId, active: false });
      return { id: created.id, windowId: created.windowId ?? windowId, url: created.url || url || '', title: created.title || '' };
    },

    async updateTab(tabId, { url, active } = {}) {
      const changes = {};
      if (url) changes.url = url;
      if (active !== undefined) changes.active = active;
      if (Object.keys(changes).length) await chrome.tabs.update(tabId, changes);
    },

    /** Makes a tab the one the user sees. The caller has bound it first. */
    async activateTab(tabId) {
      await chrome.tabs.update(tabId, { active: true });
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

    async removeTab(tabId) {
      await chrome.tabs.remove(tabId);
    },

    async goBack(tabId) {
      await chrome.tabs.goBack(tabId);
    },

    async goForward(tabId) {
      await chrome.tabs.goForward(tabId);
    },

    async reload(tabId) {
      await chrome.tabs.reload(tabId);
    },

    async getZoom(tabId) {
      return chrome.tabs.getZoom(tabId);
    },

    async setZoom(tabId, level) {
      await chrome.tabs.setZoom(tabId, level);
    },

    async inject(tabId, func, args = [], { signal } = {}) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      // The command may have been cancelled while the tab was read.
      if (signal?.aborted) throw abortError();
      if (tab && RESTRICTED.test(tab.url ?? '')) {
        const error = new Error('voice.pageRestricted');
        error.code = 'voice.pageRestricted';
        throw error;
      }
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
        return res?.result;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error(/Cannot access|chrome:\/\/|extensions gallery/i.test(err.message)
          ? 'voice.pageRestricted'
          : err.message);
      }
    },

    /**
     * Real input on the tab: a click, a key, text. The worker sends it through
     * the debugger, so the page sees what a user's hand would do. The element
     * the user approved travels with it, so the worker can resolve it again
     * after the queue and check that the focus is still where it was.
     * A worker that cannot answer fails closed: nothing is done.
     */
    async input(tabId, steps, { element = null, expected = null, rule = null } = {}) {
      const token = leases.get(tabId) ?? null;
      try {
        const res = await request('voice-input', { tabId, panelId, token, steps, element, expected, rule });
        return res ?? { ok: false, errorKey: 'voice.sayOwnerUnknown' };
      } catch {
        return { ok: false, errorKey: 'voice.sayOwnerUnknown' };
      }
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
     */
    async claim(tabId) {
      const res = await request('voice-claim', { tabId, panelId, sessionId });
      if (res?.ok && res.token) leases.set(tabId, res.token);
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
      }
    },
  };
}
