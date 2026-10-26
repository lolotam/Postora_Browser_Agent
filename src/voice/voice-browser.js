// The browser the fast voice path acts on. Chrome's calls sit behind one
// object, so the runner can be exercised without Chrome and so every step
// knows which tab it is allowed to touch.
//
// The tab the command acts on is pinned: the microphone window that asks for
// the permission takes the focus, and the active tab would then be that
// window instead of the page the user meant.

import { request } from '../sidepanel/request.js';

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/;

/**
 * The Chrome browser. `sessionId` is the panel's own session: a tab another
 * running session is working in is refused, so two sessions never act on the
 * same page. `target` is the pinned tab (or a function that returns it).
 */
export function createChromeBrowser({ sessionId = null, target = null } = {}) {
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

    async openTab({ url, windowId }) {
      const created = await chrome.tabs.create({ url: url || undefined, windowId });
      return { id: created.id, windowId: created.windowId ?? windowId, url: created.url || url || '', title: created.title || '' };
    },

    async updateTab(tabId, { url, active } = {}) {
      const changes = {};
      if (url) changes.url = url;
      if (active !== undefined) changes.active = active;
      if (Object.keys(changes).length) await chrome.tabs.update(tabId, changes);
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
      if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
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

    /** Resolves when the tab finished loading, or when the command is cancelled. */
    waitForLoad(tabId, { signal, timeout = 12000 } = {}) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          clearTimeout(settled);
          signal?.removeEventListener('abort', finish);
          setTimeout(resolve, 200);
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
        signal?.addEventListener('abort', finish, { once: true });
        chrome.tabs.onUpdated.addListener(listener);
      });
    },

    /**
     * The title of the session that is working in this tab, or null when the
     * tab is free. A lookup that cannot answer fails: the caller stops the
     * step rather than act on a tab it does not own.
     */
    async ownerOf(tabId) {
      const res = await request('tab-owner', { tabId, sessionId });
      return res?.taken ? res.owner : null;
    },
  };
}
