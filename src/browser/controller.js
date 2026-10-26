// Drives one browser tab through the Chrome DevTools Protocol (chrome.debugger)
// so clicks and keystrokes are trusted input events, indistinguishable from a
// real user's, and work on sites that ignore synthetic DOM events.

import { AgentOverlay } from './overlay.js';
import { snapshotPage, elementAction, suggestionAction, pageText, pageReadyState, devicePixelRatioOf, domSettled, documentIdOf } from './page-scripts.js';

const CDP_VERSION = '1.3';
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/webstore/;

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
// After an action, the page counts as settled once its content stops changing for
// SETTLE_QUIET_MS (capped at SETTLE_MAX_MS), instead of a fixed pause: a static page
// moves on at once, results that load by script still get time to appear.
const SETTLE_QUIET_MS = 150;
const SETTLE_FIRST_MS = 300; // until the first change: time for a started request to answer
const SETTLE_MAX_MS = 800;

/**
 * One controller per session. The session's tabs live in a Chrome tab group
 * titled with the session name: the group is how parallel sessions keep off
 * each other's tabs and how the user sees which agent works where. Tabs are
 * never brought to the front; input and screenshots go through CDP.
 */
export class BrowserController {
  constructor({ title = 'Postora', color = 'cyan', isTakenByOther = () => null } = {}) {
    this.title = title;
    this.color = color;
    this.isTakenByOther = isTakenByOther;
    this.groupId = null;
    this.tabId = null;
    // The tab the task started on stays open. Tabs this session opened are closed
    // once it leaves them, so a long task does not keep every page in memory.
    this.homeTabId = null;
    this.disposable = new Set();
    this.justClosed = null;
    this.attached = new Set();
    this.overlay = new AgentOverlay(this);
    chrome.debugger.onDetach.addListener(({ tabId }) => this.attached.delete(tabId));
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attached.delete(tabId);
      if (tabId === this.tabId) this.tabId = null;
    });
  }

  async currentTab() {
    if (this.tabId !== null) {
      try {
        return await chrome.tabs.get(this.tabId);
      } catch {
        this.tabId = null;
      }
    }
    return this.startOn();
  }

  /**
   * A task begins on the tab the user is looking at, which joins the session's
   * group. `tabId` names the tab to work on when the caller knows it: a voice
   * command pins the tab it was meant for, and the microphone window that asks
   * for the permission must not become the target.
   */
  async startOn(tabId = null) {
    const tab = tabId == null
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('No active tab found.');
    const claimed = await this.useTab(tab.id);
    this.homeTabId = claimed.id;
    return claimed;
  }

  async useTab(tabId) {
    const tab = await this.claimTab(tabId);
    const previous = this.tabId;
    this.tabId = tabId;
    if (previous !== null && previous !== tabId) {
      await this.overlay.leave(previous);
      await this.closeIfLeft(previous);
    }
    await this.overlay.frame();
    return tab;
  }

  async openTab(url) {
    const created = await chrome.tabs.create({ url, active: false });
    this.disposable.add(created.id);
    return this.useTab(created.id);
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

  async closeOwnedTab(tabId) {
    this.disposable.delete(tabId);
    if (this.homeTabId === tabId) this.homeTabId = null;
    if (this.attached.has(tabId)) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Already detached, or the tab is already gone.
      }
      this.attached.delete(tabId);
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already closed.
    }
    if (this.tabId === tabId) this.tabId = null;
  }

  ownsTab(tab) {
    return this.groupId !== null && tab.groupId === this.groupId;
  }

  async claimTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (this.ownsTab(tab)) return tab;
    const owner = this.isTakenByOther(tab);
    if (owner) throw new Error(`Tab ${tabId} is used by session "${owner}". Use a tab of your own or open a new one.`);
    if (this.groupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tabId], groupId: this.groupId });
        return { ...tab, groupId: this.groupId };
      } catch {
        this.groupId = null; // every tab of the group was closed, so the group is gone
      }
    }
    this.groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(this.groupId, { title: this.title, color: this.color });
    return { ...tab, groupId: this.groupId };
  }

  async rename(title) {
    this.title = title;
    if (this.groupId === null) return;
    await chrome.tabGroups.update(this.groupId, { title }).catch(() => {}); // the group may have closed
  }

  async cdp(method, params = {}) {
    const tab = await this.currentTab();
    assertControllable(tab.url);
    if (!this.attached.has(tab.id)) {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, CDP_VERSION);
      } catch (err) {
        if (!String(err.message).includes('already attached')) throw err;
      }
      this.attached.add(tab.id);
    }
    return chrome.debugger.sendCommand({ tabId: tab.id }, method, params);
  }

  async detachAll() {
    for (const tabId of [...this.attached]) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Tab closed or already detached.
      }
    }
    this.attached.clear();
  }

  async inject(func, args = []) {
    const tab = await this.currentTab();
    assertControllable(tab.url);
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
    return result?.result;
  }

  async snapshot({ maxElements = 250, maxTextChars = 3500 } = {}) {
    return this.inject(snapshotPage, [maxElements, maxTextChars]);
  }

  /** Scrolls an indexed element into view and returns its centre, label and box. */
  async locate(index) {
    return this.element(index, 'locate');
  }

  async element(index, action, value = null) {
    const result = await this.inject(elementAction, [index, action, value, this.overlay.enabled]);
    if (result?.error) throw new Error(result.error);
    return result;
  }

  /** Reads or acts on the suggestion list tied to an autocomplete field (see suggestionAction). */
  async suggestions(index, wanted, mode) {
    const result = await this.inject(suggestionAction, [index, wanted, mode]);
    if (result?.error) throw new Error(result.error);
    return result;
  }

  async text(start, length) {
    return this.inject(pageText, [start, length]);
  }

  async navigate(url) {
    const tab = await this.currentTab();
    await chrome.tabs.update(tab.id, { url });
    await this.waitForLoad({ expectNavigation: true });
  }

  async history(direction) {
    const tab = await this.currentTab();
    if (direction === 'back') await chrome.tabs.goBack(tab.id);
    else if (direction === 'forward') await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.reload(tab.id);
    await this.waitForLoad({ expectNavigation: true });
  }

  async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.overlay.click(x, y);
    for (let i = 1; i <= clickCount; i += 1) {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
    }
    await this.waitForLoad();
  }

  async hoverAt(x, y) {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await delay(300);
  }

  async insertText(text) {
    await this.cdp('Input.insertText', { text });
  }

  /** Presses a key or chord such as "Enter", "Control+A" or "Shift+Tab". */
  async pressKey(combo) {
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
    await this.cdp('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text });
    await this.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    await this.waitForLoad();
  }

  /** Scrolls by a number of screens (negative = up) at a point, default viewport centre. */
  async scroll(screens, at = null) {
    const metrics = await this.cdp('Page.getLayoutMetrics');
    const vp = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const x = at?.x ?? vp.clientWidth / 2;
    const y = at?.y ?? vp.clientHeight / 2;
    const deltaY = Math.round(vp.clientHeight * 0.85 * screens);
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    await delay(150); // smooth scrolling and lazy-loaded content start after the wheel event
    await this.settle();
  }

  /** JPEG screenshot of the viewport in CSS pixels, so coordinates match clickAt. */
  async screenshot() {
    const metrics = await this.cdp('Page.getLayoutMetrics');
    const vp = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const dpr = (await this.inject(devicePixelRatioOf)) || 1;
    const { data } = await this.overlay.hiddenDuring(() => this.cdp('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr },
    }));
    return { dataUrl: `data:image/jpeg;base64,${data}`, width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) };
  }

  // @store-strip-start
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
  // @store-strip-end

  /** Waits for any navigation the last action triggered to finish loading. */
  async waitForLoad({ expectNavigation = false, timeoutMs = 12000 } = {}) {
    await delay(expectNavigation ? 400 : 120); // long enough for a click to start a navigation
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await this.currentTab();
      if (tab.status === 'complete') {
        if (RESTRICTED.test(tab.url ?? '')) return;
        try {
          const state = await this.inject(pageReadyState);
          if (state?.readyState === 'complete' || state?.readyState === 'interactive') break;
        } catch {
          // Page is mid-navigation; keep polling.
        }
      }
      await delay(250);
    }
    await this.settle();
    await this.overlay.frame(); // a navigation wipes the overlay; bring it back
  }

  /** The current document's identity, or null when the page cannot be read. */
  async documentId() {
    try {
      return await this.inject(documentIdOf);
    } catch {
      return null;
    }
  }

  async settle() {
    try {
      await this.inject(domSettled, [SETTLE_QUIET_MS, SETTLE_MAX_MS, SETTLE_FIRST_MS]);
    } catch {
      // Restricted or mid-navigation page: nothing to wait for.
    }
  }
}

function assertControllable(url = '') {
  if (RESTRICTED.test(url)) {
    throw new Error(`Chrome does not allow extensions to control ${url.split('/').slice(0, 3).join('/')}. Navigate to a normal website first.`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
