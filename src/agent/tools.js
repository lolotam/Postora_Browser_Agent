// Tool definitions offered to the model and their implementation against the
// BrowserController. Every tool returns { output, images? } where output is the
// text observation the model sees next.

import { NOTE_MAX_CHARS, NOTEBOOK_MAX_CHARS, quoteNotebookHeader } from './notebook.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

// Suggestion lists often arrive after a debounce or a network call.
const SUGGESTION_WAIT_MS = 2000;
const SUGGESTION_SETTLE_MS = 1000;
const SUGGESTION_POLL_MS = 150;

const DEFINITIONS = [
  { name: 'read_page', description: 'Get the current page URL, title, scroll position, the numbered list of interactive elements and the visible text. Call this before interacting with a page you have not seen yet.', parameters: obj({}) },
  { name: 'navigate', description: 'Open a URL in the current tab.', parameters: obj({ url: str('Absolute URL, e.g. https://example.com') }, ['url']) },
  { name: 'web_search', description: 'Search the web with Google in the current tab and return the results page.', parameters: obj({ query: str('Search query') }, ['query']) },
  { name: 'click', description: 'Click an element by its [index] from the latest read_page result.', parameters: obj({ index: int('Element index'), double: { type: 'boolean', description: 'Double-click instead of single click' } }, ['index']) },
  { name: 'click_at', description: 'Click at viewport coordinates (CSS pixels) taken from the latest screenshot. Use only when the element has no index.', parameters: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) },
  { name: 'type_text', description: 'Focus an input/textarea/editable element by index and type text into it.', parameters: obj({ index: int('Element index'), text: str('Text to type'), clear: { type: 'boolean', description: 'Replace existing content (default true)' }, submit: { type: 'boolean', description: 'Press Enter afterwards' } }, ['index', 'text']) },
  { name: 'press_key', description: 'Press a key or chord on the focused element, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A".', parameters: obj({ key: str('Key or chord') }, ['key']) },
  { name: 'select_option', description: 'Choose an option of a <select> element by its visible text or value.', parameters: obj({ index: int('Element index of the <select>'), option: str('Option text or value') }, ['index', 'option']) },
  { name: 'choose_suggestion', description: 'Pick from an autocomplete field or custom dropdown (a list that appears while typing, like city, tag or subject pickers): types text into the field, waits for its list, and clicks the one option that reads exactly `option` (default: the typed text). Never presses Enter.', parameters: obj({ index: int('Element index of the field'), text: str('Text to type to open or filter the list'), option: str('Exact text of the option to pick, when it differs from the typed text') }, ['index', 'text']) },
  { name: 'hover', description: 'Move the mouse over an element (opens hover menus).', parameters: obj({ index: int('Element index') }, ['index']) },
  { name: 'scroll', description: 'Scroll the page (or the scrollable area under an element) up or down by about one screen.', parameters: obj({ direction: { type: 'string', enum: ['up', 'down'] }, index: int('Optional element index to scroll inside'), screens: { type: 'number', description: 'How many screens (default 1)' } }, ['direction']) },
  { name: 'get_text', description: 'Read more of the page text, for collecting information from long pages.', parameters: obj({ start: int('Character offset (default 0)'), length: int('Characters to read (default 6000, max 15000)') }) },
  { name: 'screenshot', description: 'Take a screenshot of the visible viewport to see layout, images, canvases or anything the element list does not capture.', parameters: obj({}), vision: true },
  { name: 'history', description: 'Go back, forward, or reload the current tab.', parameters: obj({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']) },
  { name: 'wait', description: 'Wait for the page to update (e.g. after starting a slow operation).', parameters: obj({ seconds: { type: 'number', description: '1-15' } }, ['seconds']) },
  { name: 'list_tabs', description: 'List all open tabs with their ids. Tabs marked [yours] are in your session\'s tab group.', parameters: obj({}) },
  { name: 'switch_tab', description: 'Control another tab. A tab outside your group joins it; a tab another running session uses is refused.', parameters: obj({ tab_id: int('Tab id from list_tabs') }, ['tab_id']) },
  { name: 'open_tab', description: 'Open a URL in a new background tab in your group and control it. The tab is closed when you leave it, so save what you need with note first.', parameters: obj({ url: str('Absolute URL') }, ['url']) },
  { name: 'close_tab', description: 'Close one of your tabs by id.', parameters: obj({ tab_id: int('Tab id') }, ['tab_id']) },
  // @store-strip-start
  { name: 'run_javascript', description: 'Evaluate a JavaScript expression in the page and return its JSON-serialisable value. Use for precise data extraction.', parameters: obj({ expression: str('JavaScript expression; may be an async IIFE') }, ['expression']), javascript: true },
  // @store-strip-end
  { name: 'note', description: `Save a finding to your notebook (up to 1500 characters): items, prices, names, links. Notes stay when older page states are trimmed, so save what you collect on each page before leaving it when a task spans several pages. The notebook holds ${NOTEBOOK_MAX_CHARS} characters in all; when it is full the oldest notes are dropped, so keep notes short and merge related findings.`, parameters: obj({ text: str('What you found, with enough detail to use in the final report') }, ['text']) },
  { name: 'read_notes', description: 'Read everything saved in your notebook for this session.', parameters: obj({}) },
  { name: 'ask_user', description: 'Ask the user a question and wait for the answer. Required before purchases, payments, sending messages/emails/posts, deleting data, or entering credentials; also use when the task is ambiguous or you hit a login/CAPTCHA you cannot pass.', parameters: obj({ question: str('Question for the user') }, ['question']) },
  { name: 'done', description: 'Finish the task and give the user the final report in Markdown, written in the reply language your instructions set.', parameters: obj({ report: str('Final report: what was done and every piece of information collected, with source links'), success: { type: 'boolean', description: 'Whether the task was fully completed' } }, ['report', 'success']) },
];

export function toolDefinitions({ vision, allowJavascript }) {
  return DEFINITIONS
    .filter((t) => (vision || !t.vision) && (allowJavascript || !t.javascript))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Formats a page snapshot as the text observation the model reads. */
export function formatSnapshot(snap) {
  const { y, viewport, height } = snap.scroll;
  const pct = height > viewport ? Math.round((y / (height - viewport)) * 100) : 100;
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Scroll: ${y}px of ${height}px (${pct}% down, viewport ${viewport}px)`,
    `Interactive elements${snap.offscreen ? ` (${snap.offscreen} more further down/offscreen — scroll to reveal)` : ''}:`,
    snap.elements.length ? snap.elements.join('\n') : '(none)',
    '',
    'Visible text (truncated; use get_text for more):',
    snap.text || '(empty)',
    ...(snap.dates?.length ? ['', 'Dates on this page:', ...snap.dates] : []),
  ].join('\n');
}

export function createToolExecutor(browser, { askUser, signal = null, notebook = null, onNotebookChange = () => {}, allowed = null }) {
  const overlay = browser.overlay;
  // Set per call by execute: inside a batch, an action that left the page where it
  // was skips the snapshot (the batch's last action reports the page state).
  // The page counts as changed when its URL or its document is new: a form post or
  // a reload can replace the document at the same URL, and then indexes are stale.
  let call = { brief: false, at: null, pageChanged: false, notes: false };
  const where = async () => [(await browser.currentTab().catch(() => null))?.url ?? null, await browser.documentId?.()].join(' ');
  const observe = async (prefix) => {
    if (call.brief) {
      if ((await where()) === call.at) return `${prefix} (Page state follows the last action of this turn.)`;
      call.pageChanged = true;
    }
    try {
      const page = `${prefix}\n\n${formatSnapshot(await browser.snapshot())}`;
      call.notes = true; // execute adds the notebook after this; compaction keeps only its latest copy
      return page;
    } catch (err) {
      const tab = await browser.currentTab();
      return `${prefix}\nNow at ${tab.url} — page content unavailable: ${err.message}`;
    }
  };

  const handlers = {
    read_page: async () => observe('Page state:'),
    navigate: async ({ url }) => {
      await browser.navigate(normalizeUrl(url));
      return observe(`Navigated to ${url}.`);
    },
    web_search: async ({ query }) => {
      await browser.navigate(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return observe(`Searched for "${query}".`);
    },
    click: async ({ index, double }) => {
      const target = await browser.locate(index);
      const { x, y, tag, label } = target;
      await overlay.pointTo(target, label ? ['click', { label }] : ['clickPlain']);
      await browser.clickAt(x, y, { clickCount: double ? 2 : 1 });
      return observe(`Clicked [${index}] <${tag}>.`);
    },
    click_at: async ({ x, y }) => {
      await overlay.pointTo({ x, y }, ['clickPlain']);
      await browser.clickAt(x, y);
      return observe(`Clicked at (${x}, ${y}).`);
    },
    type_text: async ({ index, text, clear = true, submit = false }) => {
      const target = await browser.locate(index);
      await overlay.pointTo(target, target.secret ? ['typeSecret'] : ['type', { text: preview(text) }]);
      await browser.clickAt(target.x, target.y);
      if (clear) await browser.element(index, 'select-all');
      await browser.insertText(text);
      if (submit) await browser.pressKey('Enter');
      return observe(`Typed into [${index}]${submit ? ' and pressed Enter' : ''}.`);
    },
    press_key: async ({ key }) => {
      await overlay.say('key', { key });
      await browser.pressKey(key);
      return observe(`Pressed ${key}.`);
    },
    select_option: async ({ index, option }) => {
      await overlay.pointTo(await browser.locate(index), ['select', { option: preview(option) }]);
      const { selected } = await browser.element(index, 'select-option', option);
      return observe(`Selected "${selected}" in [${index}].`);
    },
    choose_suggestion: async ({ index, text, option }) => {
      const wanted = String(option ?? text);
      const field = await browser.locate(index);
      await overlay.pointTo(field, ['select', { option: preview(wanted) }]);
      await browser.clickAt(field.x, field.y);
      await browser.element(index, 'select-all');
      await browser.insertText(String(text));
      let scan;
      for (const end = Date.now() + SUGGESTION_WAIT_MS; ;) {
        scan = await browser.suggestions(index, wanted, 'scan');
        if (scan.matches > 0 || Date.now() >= end || signal?.aborted) break;
        await sleep(SUGGESTION_POLL_MS, signal);
      }
      throwIfStopped(signal); // a stopped task never clicks an option it found while stopping
      if (scan.matches !== 1) {
        const more = scan.total > scan.options.length ? ` (+${scan.total - scan.options.length} more)` : '';
        const shown = scan.options.length ? ` Options shown: ${scan.options.map((o) => `"${o}"`).join(', ')}${more}.` : '';
        const why = scan.matches > 1 ? `${scan.matches} options read exactly "${wanted}"`
          : scan.total ? `No option reads exactly "${wanted}"`
            : `No suggestion list tied to [${index}] appeared within ${SUGGESTION_WAIT_MS / 1000} s`;
        return observe(`Not chosen: ${why}; nothing was clicked and "${preview(text)}" is still typed in [${index}].${shown} Call again with the exact option, or click it from the element list.`);
      }
      const spot = await browser.suggestions(index, wanted, 'locate');
      await overlay.pointTo(spot, ['select', { option: preview(spot.text) }]);
      throwIfStopped(signal);
      await browser.clickAt(spot.x, spot.y);
      let shown = false;
      for (const end = Date.now() + SUGGESTION_SETTLE_MS; ;) {
        shown = (await browser.suggestions(index, wanted, 'verify').catch(() => ({ ok: false }))).ok;
        if (shown || Date.now() >= end || signal?.aborted) break;
        await sleep(SUGGESTION_POLL_MS, signal);
      }
      if (!shown) return observe(`Clicked "${spot.text}" in the list of [${index}], but the field does not show it; check the page before going on.`);
      return observe(`Chose "${spot.text}" in [${index}].`);
    },
    hover: async ({ index }) => {
      const target = await browser.locate(index);
      await overlay.pointTo(target, target.label ? ['hover', { label: target.label }] : ['hoverPlain']);
      await browser.hoverAt(target.x, target.y);
      return observe(`Hovering [${index}].`);
    },
    scroll: async ({ direction, index, screens = 1 }) => {
      const at = Number.isInteger(index) ? await browser.locate(index) : null;
      const sign = direction === 'up' ? -1 : 1;
      const caption = [direction === 'up' ? 'scrollUp' : 'scrollDown'];
      if (at) await overlay.pointTo(at, caption);
      else await overlay.say(...caption);
      await browser.scroll(sign * Math.min(Math.max(screens, 0.2), 10), at);
      return observe(`Scrolled ${direction}.`);
    },
    get_text: async ({ start = 0, length = 6000 }) => {
      const res = await browser.text(Math.max(0, start), Math.min(Math.max(length, 500), 15000));
      const end = res.start + res.text.length;
      // Dates come after the last slice and are not counted in the offsets.
      const dates = end >= res.total && res.dates?.length ? `\n\nDates on this page:\n${res.dates.join('\n')}` : '';
      return `Page text characters ${res.start}-${end} of ${res.total}${end < res.total ? ' (more available)' : ''}:\n${res.text}${dates}`;
    },
    screenshot: async () => {
      const shot = await browser.screenshot();
      return { output: `Screenshot of the viewport attached (${shot.width}x${shot.height} CSS px; use these coordinates with click_at).`, images: [shot.dataUrl] };
    },
    history: async ({ action }) => {
      await browser.history(action);
      return observe(`Did ${action}.`);
    },
    wait: async ({ seconds }) => {
      await sleep(Math.min(Math.max(seconds, 0.5), 15) * 1000, signal);
      return observe(`Waited ${seconds}s.`);
    },
    list_tabs: async () => {
      const tabs = await chrome.tabs.query({});
      const current = (await browser.currentTab()).id;
      return tabs.map((t) => `${t.id === current ? '* ' : '  '}tab_id=${t.id} ${browser.ownsTab(t) ? '[yours] ' : ''}${t.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n');
    },
    switch_tab: async ({ tab_id }) => {
      await browser.useTab(tab_id);
      return observe(`Switched to tab ${tab_id}.${browser.takeClosedNote?.() ?? ''}`);
    },
    open_tab: async ({ url }) => {
      const tab = await browser.openTab(normalizeUrl(url));
      await browser.waitForLoad({ expectNavigation: true });
      return observe(`Opened new tab ${tab.id}.${browser.takeClosedNote?.() ?? ''}`);
    },
    close_tab: async ({ tab_id }) => {
      const owner = browser.isTakenByOther(await chrome.tabs.get(tab_id));
      if (owner) throw new Error(`Tab ${tab_id} belongs to session "${owner}".`);
      await browser.closeOwnedTab(tab_id);
      return `Closed tab ${tab_id}.`;
    },
    // @store-strip-start
    run_javascript: async ({ expression }) => {
      const value = await browser.evaluate(expression);
      const json = JSON.stringify(value, null, 1) ?? 'undefined';
      return json.length > 15000 ? `${json.slice(0, 15000)}… (truncated)` : json;
    },
    // @store-strip-end
    ask_user: async ({ question }) => `User answered: ${await askUser(question)}`,
    note: async ({ text }) => {
      if (!notebook) throw new Error('No notebook in this session.');
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('The note is empty.');
      if (clean.length > NOTE_MAX_CHARS) throw new Error(`The note is ${clean.length} characters; the limit is ${NOTE_MAX_CHARS}. Split it into several notes.`);
      const url = (await browser.currentTab().catch(() => null))?.url ?? '';
      const count = notebook.add(clean, url);
      onNotebookChange();
      return `Saved (${count} note${count === 1 ? '' : 's'}).`;
    },
    read_notes: async () => {
      call.notes = true;
      return notebook?.entries.length ? '' : 'No notes yet.';
    },
  };

  /** `observe: false` marks an action that is not the last of its turn's batch. */
  return async function execute(name, args, { observe: full = true } = {}) {
    // Only tools offered in this session run, even when restored history asks for another.
    const handler = !allowed || allowed.has(name) ? handlers[name] : null;
    if (!handler) return { output: `Unknown tool "${name}".`, isError: true };
    const brief = !full && name !== 'read_page';
    call = { brief, at: brief ? await where() : null, pageChanged: false, notes: false };
    try {
      const result = await handler(args ?? {});
      const out = typeof result === 'string' ? { output: result } : result;
      // Tool output can carry page text; the notebook header is added only here.
      const notes = call.notes ? notebook?.format() : '';
      const output = [quoteNotebookHeader(out.output ?? ''), notes].filter(Boolean).join('\n\n');
      return { ...out, output, ...(call.pageChanged ? { pageChanged: true } : {}) };
    } catch (err) {
      return { output: `Error: ${err.message}`, isError: true };
    }
  };
}

function throwIfStopped(signal) {
  if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
}

/** Resolves after `ms`, or as soon as the task is stopped. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Typed text as shown in the on-page caption: one line, kept short. */
function preview(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > 32 ? `${line.slice(0, 32)}…` : line;
}

export function normalizeUrl(url) {
  const trimmed = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
