// The agent's visible presence on the page it controls: a glowing cursor that
// glides to each target and ripples on click, a caption saying what it is doing,
// a highlight on the element it acts on, and a glowing frame with a Stop button
// while a task runs. Purely visual: it never takes input except the Stop button,
// and it is hidden while screenshots are taken so the model never sees it.

import { MESSAGES } from '../sidepanel/messages.js';
import { resolveLanguage } from '../sidepanel/i18n.js';

const RTL = new Set(['ar']);

export class AgentOverlay {
  constructor(browser) {
    this.browser = browser;
    this.enabled = false;
    this.language = 'en';
    this.position = null; // last cursor point, so the glide continues across page loads
    this.tabs = new Set(); // tabs that may still show the overlay
  }

  /** Called when a task starts; `enabled` is the user's setting. */
  begin({ enabled, uiLanguage }) {
    this.enabled = Boolean(enabled);
    this.language = resolveLanguage(uiLanguage, chrome.i18n?.getUILanguage?.());
    this.position = null;
  }

  /** Called when a task ends: clears the overlay from every tab it touched. */
  async end() {
    const tabs = [...this.tabs];
    this.tabs.clear();
    this.enabled = false;
    await Promise.all(tabs.map((tabId) => this.send({ op: 'remove' }, tabId)));
  }

  /** The agent moved to another tab: the old one stops glowing. */
  async leave(tabId) {
    if (!this.tabs.delete(tabId)) return;
    await this.send({ op: 'remove' }, tabId);
  }

  text(key, vars = {}) {
    const messages = MESSAGES[this.language] ?? MESSAGES.en;
    const template = messages[`overlay.${key}`] ?? MESSAGES.en[`overlay.${key}`] ?? '';
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
  }

  /** Shows the frame and Stop bar; re-creates them after a navigation wiped the page. */
  frame() {
    return this.command({ op: 'frame' });
  }

  /** Glides the cursor to a target and waits until it arrives. `caption` is [key, vars]. */
  async pointTo({ x, y, rect = null }, caption = null) {
    if (!this.enabled) return;
    await this.command({ op: 'move', x, y, rect, caption: caption ? this.text(...caption) : '' });
    this.position = { x, y };
  }

  /** Captions an action that has no single target, such as a key press. */
  say(...caption) {
    return this.command({ op: 'caption', caption: this.text(...caption) });
  }

  click(x, y) {
    return this.command({ op: 'click', x, y });
  }

  /** Runs `capture` with the overlay hidden, so screenshots show only the page. */
  async hiddenDuring(capture) {
    if (!this.enabled) return capture();
    await this.command({ op: 'hide' });
    try {
      return await capture();
    } finally {
      await this.command({ op: 'show' });
    }
  }

  async command(cmd) {
    if (!this.enabled) return;
    const tabId = this.browser.tabId;
    if (tabId === null) return;
    this.tabs.add(tabId);
    await this.send({
      ...cmd,
      from: this.position,
      dir: RTL.has(this.language) ? 'rtl' : 'ltr',
      texts: { working: this.text('working'), stop: this.text('stop') },
    }, tabId);
  }

  /** Visuals must never break an action: restricted pages and closed tabs are ignored. */
  async send(cmd, tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: overlayCommand, args: [cmd] });
    } catch {
      // Not scriptable (chrome:// page, tab closed, mid-navigation).
    }
  }
}

/**
 * Injected into the page. Serialized on its own, so it must not reference
 * anything outside its body. State lives on the isolated world's window, which
 * persists between injections until the page navigates.
 */
export function overlayCommand(cmd) {
  const ACCENT = '79, 247, 209';
  let ui = window.__agentOverlay;

  if (cmd.op === 'remove') {
    if (ui) ui.host.remove();
    window.__agentOverlay = null;
    return true;
  }

  if (!ui || !ui.host.isConnected) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap { position: fixed; inset: 0; pointer-events: none; font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif; }
      .frame { position: fixed; inset: 0; opacity: 0; transition: opacity .35s ease; }
      .frame.on { opacity: 1; }
      .glow { position: absolute; inset: 0; box-shadow: inset 0 0 0 2px rgba(${ACCENT}, .9), inset 0 0 26px 4px rgba(${ACCENT}, .35);
        animation: breathe 2.4s ease-in-out infinite alternate; }
      @keyframes breathe { from { opacity: .55; } to { opacity: 1; } }
      .box { position: fixed; border: 1px solid rgba(${ACCENT}, .85); border-radius: 5px; opacity: 0;
        box-shadow: 0 0 0 2px rgba(${ACCENT}, .12), 0 0 8px rgba(${ACCENT}, .2);
        transition: opacity .2s ease; }
      .box.on { opacity: 1; }
      .cursor { position: fixed; left: 0; top: 0; opacity: 0; transition: opacity .25s ease; will-change: transform; }
      .cursor.on { opacity: 1; }
      .cursor svg { position: absolute; left: -3px; top: -2px; overflow: visible;
        filter: drop-shadow(0 0 2px rgba(${ACCENT}, .65)) drop-shadow(0 1px 1px rgba(0, 0, 0, .45)); transition: transform .12s ease; }
      .cursor.press svg { transform: scale(.9); }
      .caption { position: absolute; left: 14px; top: 18px; max-width: 260px; padding: 5px 10px; border-radius: 8px;
        background: rgba(13, 17, 19, .92); color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        border: 1px solid rgba(${ACCENT}, .55); box-shadow: 0 4px 14px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .2s ease; }
      .caption.on { opacity: 1; }
      .cursor.flip .caption { left: auto; right: 6px; }
      .cursor.up .caption { top: auto; bottom: 8px; }
      .ripple { position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%;
        border: 1px solid rgba(${ACCENT}, .85); background: rgba(${ACCENT}, .12); animation: ripple .4s ease-out forwards; }
      @keyframes ripple { from { transform: scale(.4); opacity: .85; } to { transform: scale(1.4); opacity: 0; } }
      .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
        padding: 6px 6px 6px 14px; border-radius: 999px; background: rgba(13, 17, 19, .92); color: #fff;
        border: 1px solid rgba(${ACCENT}, .5); box-shadow: 0 6px 22px rgba(0, 0, 0, .35); pointer-events: auto;
        opacity: 0; transition: opacity .3s ease; }
      .bar[dir="rtl"] { padding: 6px 14px 6px 6px; }
      .bar.on { opacity: 1; }
      .bar.through { pointer-events: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: rgb(${ACCENT}); animation: pulse 1s ease-in-out infinite alternate; }
      @keyframes pulse { from { opacity: .35; } to { opacity: 1; } }
      .stop { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 999px; background: #e5484d; color: #fff; font-weight: 600; }
      .stop:hover { background: #f2555a; }
      .stop:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      .stop:disabled { opacity: .6; cursor: default; }
      @media (prefers-reduced-motion: reduce) { .glow, .dot { animation: none; } .ripple { animation: none; opacity: .5; } .cursor svg { transition: none; } .cursor.press svg { transform: none; } }
    </style>
    <div class="wrap">
      <div class="frame" aria-hidden="true"><div class="glow"></div></div>
      <div class="box" aria-hidden="true"></div>
      <div class="cursor" aria-hidden="true">
        <svg width="16" height="20" viewBox="0 0 24 30" aria-hidden="true">
          <path d="M3 2 L3 24.5 L9 19 L13.2 28 L17.3 26.2 L13.2 17.4 L21.2 17 Z" fill="#0d1113" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
        <div class="caption"></div>
      </div>
      <div class="bar"><span class="dot" aria-hidden="true"></span><span class="label"></span><button type="button" class="stop"></button></div>
    </div>`;
    document.documentElement.appendChild(host);
    const q = (selector) => root.querySelector(selector);
    ui = {
      host, wrap: q('.wrap'), frame: q('.frame'), box: q('.box'), cursor: q('.cursor'), caption: q('.caption'),
      bar: q('.bar'), label: q('.label'), stop: q('.stop'), x: null, y: null, boxTimer: 0, captionTimer: 0, barTimer: 0,
    };
    ui.stop.addEventListener('click', () => {
      ui.stop.disabled = true;
      chrome.runtime.sendMessage({ type: 'overlay-stop' }).catch(() => {});
    });
    window.__agentOverlay = ui;
  }

  ui.label.textContent = cmd.texts.working;
  ui.stop.textContent = cmd.texts.stop;
  ui.bar.dir = cmd.dir;
  ui.caption.dir = cmd.dir;
  ui.frame.classList.add('on');
  ui.bar.classList.add('on');

  const visible = document.visibilityState === 'visible';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nextFrame = () => new Promise((resolve) => {
    if (!visible) return resolve();
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 80); // rAF stalls in background tabs
  });

  const place = (x, y) => {
    ui.x = x;
    ui.y = y;
    ui.cursor.style.transform = `translate(${x}px, ${y}px)`;
    ui.cursor.classList.toggle('flip', x > innerWidth - 280);
    ui.cursor.classList.toggle('up', y > innerHeight - 70);
    ui.cursor.classList.add('on');
  };

  // A fresh page (after a navigation) starts the cursor where it last was.
  if (ui.x === null && cmd.from) place(cmd.from.x, cmd.from.y);

  const showCaption = (text) => {
    clearTimeout(ui.captionTimer);
    if (!text) return;
    ui.caption.textContent = text;
    ui.caption.classList.add('on');
    if (ui.x === null) place(innerWidth / 2, innerHeight * 0.8);
    ui.captionTimer = setTimeout(() => ui.caption.classList.remove('on'), 4000);
  };

  if (cmd.op === 'hide' || cmd.op === 'show') {
    ui.host.style.visibility = cmd.op === 'hide' ? 'hidden' : 'visible';
    return nextFrame().then(() => true);
  }

  if (cmd.op === 'caption') {
    showCaption(cmd.caption);
    return true;
  }

  if (cmd.op === 'click') {
    ui.bar.classList.add('through'); // the click must land on the page, never on the Stop bar
    clearTimeout(ui.barTimer);
    ui.barTimer = setTimeout(() => ui.bar.classList.remove('through'), 900);
    if (!visible) return true;
    // Highlight the live target only on a click; never resize the page's UI.
    clearTimeout(ui.boxTimer);
    const hit = document.elementFromPoint(cmd.x, cmd.y);
    const target = hit?.closest('button,a,input,textarea,select,[role="button"]') ?? hit;
    const rect = target?.getBoundingClientRect();
    ui.box.classList.remove('on');
    if (rect && target !== document.body && target !== document.documentElement && rect.width > 0 && rect.height > 0) {
      const pad = 3;
      Object.assign(ui.box.style, { left: `${rect.left - pad}px`, top: `${rect.top - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
      ui.box.classList.add('on');
      ui.boxTimer = setTimeout(() => ui.box.classList.remove('on'), 450);
    }
    const ring = document.createElement('div');
    ring.className = 'ripple';
    ring.style.left = `${cmd.x}px`;
    ring.style.top = `${cmd.y}px`;
    ui.wrap.appendChild(ring);
    setTimeout(() => ring.remove(), reduced ? 160 : 450);
    ui.cursor.classList.add('press');
    setTimeout(() => ui.cursor.classList.remove('press'), 160);
    return true;
  }

  if (cmd.op === 'move') {
    showCaption(cmd.caption);
    clearTimeout(ui.boxTimer);
    ui.box.classList.remove('on');

    const { x, y } = cmd;
    const fx = ui.x ?? innerWidth / 2;
    const fy = ui.y ?? innerHeight * 0.8;
    const dist = Math.hypot(x - fx, y - fy);
    if (!visible || reduced || dist < 3) {
      place(x, y);
      return true;
    }
    if (ui.x === null) place(fx, fy);
    const duration = Math.min(320, Math.max(160, 120 + dist * 0.2));
    // A gentle arc, like a hand moving a mouse, rather than a straight slide.
    const bend = Math.min(80, dist * 0.18);
    const cx = (fx + x) / 2 - ((y - fy) / dist) * bend;
    const cy = (fy + y) / 2 + ((x - fx) / dist) * bend;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
    return new Promise((resolve) => {
      const start = performance.now();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        place(x, y);
        resolve(true);
      };
      const step = (now) => {
        if (finished) return;
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        const u = 1 - e;
        place(u * u * fx + 2 * u * e * cx + e * e * x, u * u * fy + 2 * u * e * cy + e * e * y);
        if (t < 1) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
      setTimeout(finish, duration + 250); // never hang if the tab is hidden mid-glide
    });
  }

  return true; // 'frame'
}
