// Tool definitions offered to the model and their implementation against the
// BrowserController. Every tool returns { output, images? } where output is the
// text observation the model sees next.
//
// Everything that can change a page, and every explicit read of a value out of
// one, runs through the same guarded boundary: the session's access authority
// is asked first, and only the exact operation it allowed runs afterwards.
// A tool argument, a setting, a page, a transcript or a replayed message can
// never allow an action by itself, and the user is never asked through
// ask_user — the authority asks the real question and waits for the real
// answer. Without an authority nothing that changes a page runs at all.

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
  { name: 'read_field', description: 'Read the current value of ONE field, by its [index] from the latest read_page result. Use it when the value itself is needed (a one-time code, a token, a name of a saved card) and not for anything else: the ordinary snapshot already shows the values of ordinary fields. The value is read only after the user allowed this exact read.', parameters: obj({ index: int('Element index of the field to read') }, ['index']) },
  { name: 'navigate', description: 'Open a URL in the current tab.', parameters: obj({ url: str('Absolute URL, e.g. https://example.com') }, ['url']) },
  { name: 'web_search', description: 'Search the web with Google in the current tab and return the results page.', parameters: obj({ query: str('Search query') }, ['query']) },
  { name: 'click', description: 'Click an element by its [index] from the latest read_page result.', parameters: obj({ index: int('Element index'), double: { type: 'boolean', description: 'Double-click instead of single click' } }, ['index']) },
  { name: 'click_at', description: 'Click at viewport coordinates (CSS pixels) taken from the latest screenshot. Use only when the element has no index.', parameters: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) },
  { name: 'type_text', description: 'Focus an input/textarea/editable element by index and type text into it.', parameters: obj({ index: int('Element index'), text: str('Text to type'), clear: { type: 'boolean', description: 'Replace existing content (default true)' }, submit: { type: 'boolean', description: 'Press Enter afterwards' } }, ['index', 'text']) },
  { name: 'insert_text', description: 'Type text into the field that has the focus right now, without naming it. Use it for a terminal or any helper field that takes the focus itself; use type_text for a field you can see. The text goes into that one focused field, or nowhere.', parameters: obj({ text: str('Text to type') }, ['text']) },
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
  { name: 'ask_user', description: 'Ask for missing information, genuine task ambiguity, or a login/CAPTCHA step only the user can complete. Browser tools enforce action permissions automatically; do not duplicate their authorization questions.', parameters: obj({ question: str('Question for the user') }, ['question']) },
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

export function createToolExecutor(rawBrowser, {
  askUser,
  signal = null,
  notebook = null,
  onNotebookChange = () => {},
  allowed = null,
  access = null,
} = {}) {
  // The page may only be changed under an approval: a call that can change it
  // without a guard is a bug, and this turns that bug into a refusal instead
  // of an action nobody allowed.
  const browser = guardOnly(rawBrowser);
  const overlay = browser.overlay;
  // The worker's own authority for this session. It is the only thing that may
  // allow an action: a session without one may still read the page, because
  // reading changes nothing, but nothing that changes a page runs at all.
  const authority = typeof access?.authorize === 'function' && typeof access?.grantValid === 'function'
    ? access
    : null;

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

  /**
   * Asks the authority about one exact operation, and hands back the permit
   * together with the guard that keeps it honest while the action runs.
   *
   * The operation is plain JSON: the action, its exact arguments, the tab it
   * acts on and the target it acts on. The authority copies it, so the thing
   * that was allowed is the thing that runs — a different argument, another tab
   * or another target is a different operation and is refused.
   */
  const approve = async ({ action, args, tabId = null, target = null, describe = null }) => {
    if (!authority) throw new Error('This session has no access authority, so nothing was allowed.');
    const operation = { action, args, tabId, target, describe };
    const answer = await authority.authorize(operation, { signal });
    if (!answer?.permit) throw new Error(refusal(answer?.reason));
    const permit = answer.permit;
    // The grant is asked again every time the browser is about to change
    // something: a mode change, a stop or the end of the run withdraws it.
    const granted = () => {
      if (signal?.aborted) throw new Error('The task was stopped before this action could run.');
      if (!authority.grantValid(permit, operation)) throw new Error('The approval for this action is no longer valid.');
    };
    const guard = async () => {
      granted();
      if (target && (target.element || target.scope === 'tab')) {
        // The target is checked against the page, and the grant is asked again
        // after that check: a wait must not carry a stale approval into the page.
        const state = await browser.validateTarget(target);
        granted();
        if (!state?.ok) {
          const what = target.scope === 'tab' ? 'The tab that was approved' : 'The element that was approved';
          throw new Error(`${what} is not the one that would be used (${state?.reason ?? 'unknown'}).`);
        }
      }
      return true;
    };
    return { permit, operation, guard, granted };
  };

  /**
   * Asks the authority about a read of the page.
   *
   * A read changes nothing, so the authority allows it without a question —
   * but a session without an authority may not read the page either: there is
   * nobody who could say what this session is allowed to see.
   */
  const permitRead = async ({ action, args = {}, tabId = null, describe = null }) => {
    const { permit } = await approve({ action, args, tabId, target: null, describe });
    return permit;
  };

  /** The tab this session works on, when it can be named. */
  const currentTabId = async () => (await browser.currentTab().catch(() => null))?.id ?? null;

  /**
   * The identity of an element of the latest snapshot, captured before
   * anything is asked: nothing is scrolled, focused, flashed or read.
   */
  const elementTarget = async (index) => {
    const target = await browser.captureTarget({ kind: 'element', index });
    if (!target?.element) throw new Error(`Element [${index}] is not on the page any more. Call read_page to refresh the element list.`);
    return target;
  };

  /** The identity of the element that has the focus, deep inside a shadow root if that is where it is. */
  const focusTarget = async () => {
    const target = await browser.captureTarget({ kind: 'focus' });
    if (!target?.element) throw new Error('Nothing that can be typed into has the focus right now.');
    return target;
  };

  /** The identity of the element under a point. */
  const pointTarget = async (x, y) => {
    const target = await browser.captureTarget({ kind: 'point', x, y });
    if (!target?.element) throw new Error(`Nothing is at (${x}, ${y}) any more.`);
    return target;
  };

  /**
   * The scope of an operation that acts on a tab rather than on an element:
   * the tab it acts on, and the page that was there when it was approved.
   *
   * The tab is named before anything is asked, and it is not taken: a switch
   * waits for the answer like everything else. A browser that cannot name the
   * tab has nothing to approve, so the operation is refused.
   */
  const tabScope = async (tabId = null) => {
    const id = tabId ?? (await browser.currentTab()).id;
    const scope = await browser.captureTarget({ kind: 'tab', tabId: id });
    if (scope?.scope !== 'tab' || scope.tabId !== id) {
      throw new Error(`Tab ${id} could not be named, so nothing was approved for it.`);
    }
    return scope;
  };

  /**
   * The focus must still be the approved element, and it must be a field that
   * can really be written to. A click that moved the focus somewhere else is
   * not followed: the text does not go into another field.
   */
  const typingTarget = async (target, guard) => {
    try {
      await browser.assertTypingTarget(target, { guard });
    } catch (err) {
      if (String(err?.message ?? '').includes('inputCancelled')) {
        throw new Error('The approved field cannot take the text: the focus moved to another element, or it cannot be written to.');
      }
      throw err;
    }
  };

  const handlers = {
    read_page: async () => {
      await permitRead({ action: 'read_page', tabId: await currentTabId(), describe: 'Read the page' });
      return observe('Page state:');
    },
    read_field: async ({ index }) => {
      const at = indexOf(index);
      const target = await elementTarget(at);
      const { guard } = await approve({
        action: 'read_field',
        args: { index: at },
        tabId: target.tabId,
        target,
        describe: `Read the value of element [${at}]`,
      });
      // The one way a value leaves the page: the field that was approved, and
      // nothing else.
      const field = await browser.readField(target, { guard });
      const value = field?.value ?? '';
      return `The value of element [${at}]${field?.secret ? ' (a field that holds a secret)' : ''}: ${value === '' ? '(empty)' : value}`;
    },
    navigate: async ({ url }) => {
      const scope = await tabScope();
      const place = normalizeUrl(url);
      const { guard } = await approve({
        action: 'navigate',
        args: { url: place },
        tabId: scope.tabId,
        target: scope,
        describe: `Open ${place}`,
      });
      await browser.navigate(place, { guard, tabId: scope.tabId });
      return observe(`Navigated to ${url}.`);
    },
    web_search: async ({ query }) => {
      const scope = await tabScope();
      const place = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const { guard } = await approve({
        action: 'web_search',
        args: { query: String(query) },
        tabId: scope.tabId,
        target: scope,
        describe: `Search for "${query}"`,
      });
      await browser.navigate(place, { guard, tabId: scope.tabId });
      return observe(`Searched for "${query}".`);
    },
    click: async ({ index, double }) => {
      const at = indexOf(index);
      const target = await elementTarget(at);
      const { guard } = await approve({
        action: 'click',
        args: { index: at, double: Boolean(double) },
        tabId: target.tabId,
        target,
        describe: describeOf('Click', at, target),
      });
      const spot = await browser.element(at, 'locate', null, { guard, target });
      await overlay.pointTo(spot, spot.label ? ['click', { label: spot.label }] : ['clickPlain']);
      // The click is bound to the element that was approved: another element
      // that covers the point takes no approval, not even at the last moment.
      await browser.clickAt(spot.x, spot.y, { clickCount: double ? 2 : 1, guard, target, tabId: target.tabId });
      return observe(`Clicked [${at}] <${spot.tag}>.`);
    },
    click_at: async ({ x, y }) => {
      const at = { x: Number(x), y: Number(y) };
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error('A click needs a point in the viewport.');
      const target = await pointTarget(at.x, at.y);
      const { guard } = await approve({
        action: 'click_at',
        args: { x: at.x, y: at.y },
        tabId: target.tabId,
        target,
        describe: `Click at (${at.x}, ${at.y})`,
      });
      await overlay.pointTo({ x: at.x, y: at.y }, ['clickPlain']);
      // The click is bound to the point that was approved: another element
      // that covers it takes no approval.
      await browser.clickAt(at.x, at.y, { guard, target, tabId: target.tabId });
      return observe(`Clicked at (${at.x}, ${at.y}).`);
    },
    type_text: async ({ index, text, clear = true, submit = false }) => {
      const at = indexOf(index);
      const target = await elementTarget(at);
      const { guard } = await approve({
        action: 'type_text',
        args: { index: at, text: String(text), clear: Boolean(clear), submit: Boolean(submit) },
        tabId: target.tabId,
        target,
        // The text itself is never part of the preview of the operation.
        describe: describeOf('Type text into', at, target),
      });
      const spot = await browser.element(at, 'locate', null, { guard, target });
      // A field that holds a secret is captioned as one: its text is never
      // shown, not on the page and not in the caption.
      await overlay.pointTo(spot, target.element?.secret ? ['typeSecret'] : ['type', { text: preview(text) }]);
      // The click is bound to the field that was approved: something that
      // covers it takes no approval.
      await browser.clickAt(spot.x, spot.y, { guard, target, tabId: target.tabId });
      // The click may have moved the focus somewhere else. The text does not
      // follow the focus: the field that was approved is the only one that may
      // take it, and the focus is never forced back.
      await typingTarget(target, guard);
      if (clear) await browser.element(at, 'select-all', null, { guard, target });
      await browser.insertText(String(text), { guard, target, tabId: target.tabId });
      if (submit) await browser.pressKey('Enter', { guard, target, tabId: target.tabId });
      return observe(`Typed into [${at}]${submit ? ' and pressed Enter' : ''}.`);
    },
    insert_text: async ({ text }) => {
      const target = await focusTarget();
      const { guard } = await approve({
        action: 'insert_text',
        args: { text: String(text) },
        tabId: target.tabId,
        target,
        describe: 'Type text into the focused field',
      });
      // The field that has the focus is the one that was captured: the body, a
      // field that cannot be written to and a field that took the focus in the
      // meantime all take nothing.
      await typingTarget(target, guard);
      await overlay.say(target.element?.secret ? 'typeSecret' : 'type', target.element?.secret ? {} : { text: preview(text) });
      await browser.insertText(String(text), { guard, target, tabId: target.tabId });
      return observe('Typed into the focused field.');
    },
    press_key: async ({ key }) => {
      const target = await focusTarget();
      const { guard } = await approve({
        action: 'press_key',
        args: { key: String(key) },
        tabId: target.tabId,
        target,
        describe: `Press ${key}`,
      });
      await overlay.say('key', { key });
      await browser.pressKey(String(key), { guard, target, tabId: target.tabId });
      return observe(`Pressed ${key}.`);
    },
    select_option: async ({ index, option }) => {
      const at = indexOf(index);
      const target = await elementTarget(at);
      const { guard } = await approve({
        action: 'select_option',
        args: { index: at, option: String(option) },
        tabId: target.tabId,
        target,
        describe: describeOf(`Choose "${option}" in`, at, target),
      });
      const spot = await browser.element(at, 'locate', null, { guard, target });
      await overlay.pointTo(spot, ['select', { option: preview(option) }]);
      const { selected } = await browser.element(at, 'select-option', option, { guard, target });
      return observe(`Selected "${selected}" in [${at}].`);
    },
    choose_suggestion: async ({ index, text, option }) => {
      const at = indexOf(index);
      const wanted = String(option ?? text);
      const target = await elementTarget(at);
      // One approval covers this one composite action: the field it types into
      // and the one option it clicks out of that field's list.
      const { guard, granted } = await approve({
        action: 'choose_suggestion',
        args: { index: at, text: String(text), option: option === undefined ? null : String(option) },
        tabId: target.tabId,
        target,
        describe: describeOf(`Choose "${wanted}" in`, at, target),
      });
      const field = await browser.element(at, 'locate', null, { guard, target });
      await overlay.pointTo(field, ['select', { option: preview(wanted) }]);
      // The click on the field is bound to the field that was approved.
      await browser.clickAt(field.x, field.y, { guard, target, tabId: target.tabId });
      await typingTarget(target, guard);
      await browser.element(at, 'select-all', null, { guard, target });
      await browser.insertText(String(text), { guard, target, tabId: target.tabId });
      let scan;
      for (const end = Date.now() + SUGGESTION_WAIT_MS; ;) {
        scan = await browser.suggestions(at, wanted, 'scan', { guard, target });
        if (scan.matches > 0 || Date.now() >= end || signal?.aborted) break;
        await sleep(SUGGESTION_POLL_MS, signal);
      }
      throwIfStopped(signal); // a stopped task never clicks an option it found while stopping
      if (scan.matches !== 1) {
        const more = scan.total > scan.options.length ? ` (+${scan.total - scan.options.length} more)` : '';
        const shown = scan.options.length ? ` Options shown: ${scan.options.map((o) => `"${o}"`).join(', ')}${more}.` : '';
        const why = scan.matches > 1 ? `${scan.matches} options read exactly "${wanted}"`
          : scan.total ? `No option reads exactly "${wanted}"`
            : `No suggestion list tied to [${at}] appeared within ${SUGGESTION_WAIT_MS / 1000} s`;
        return observe(`Not chosen: ${why}; nothing was clicked and "${preview(text)}" is still typed in [${at}].${shown} Call again with the exact option, or click it from the element list.`);
      }
      const spot = await browser.suggestions(at, wanted, 'locate', { guard, target });
      // The browser names the actual tied option in the same injected script
      // that locates it; never recapture whichever control now covers its point.
      const choice = spot.target;
      if (choice?.scope !== 'element' || !choice.element?.token || choice.tabId !== target.tabId) {
        throw new Error('The suggestion option could not be bound to its original element.');
      }
      await overlay.pointTo(spot, ['select', { option: preview(spot.text) }]);
      throwIfStopped(signal);
      // Both are checked again right before the click — the field the choice
      // was made in and the point the option is at — and the grant is asked
      // again after each check.
      const choiceGuard = async () => {
        await guard();
        const hit = await browser.validateTarget(choice);
        granted();
        if (!hit?.ok) throw new Error(`The option that was found is not there any more (${hit?.reason ?? 'unknown'}).`);
        return true;
      };
      await browser.clickAt(spot.x, spot.y, { guard: choiceGuard, target: choice, tabId: choice.tabId });
      let shown = false;
      for (const end = Date.now() + SUGGESTION_SETTLE_MS; ;) {
        shown = (await browser.suggestions(at, wanted, 'verify', { guard, target }).catch(() => ({ ok: false }))).ok;
        if (shown || Date.now() >= end || signal?.aborted) break;
        await sleep(SUGGESTION_POLL_MS, signal);
      }
      if (!shown) return observe(`Clicked "${spot.text}" in the list of [${at}], but the field does not show it; check the page before going on.`);
      return observe(`Chose "${spot.text}" in [${at}].`);
    },
    hover: async ({ index }) => {
      const at = indexOf(index);
      const target = await elementTarget(at);
      const { guard } = await approve({
        action: 'hover',
        args: { index: at },
        tabId: target.tabId,
        target,
        describe: describeOf('Hover', at, target),
      });
      const spot = await browser.element(at, 'locate', null, { guard, target });
      await overlay.pointTo(spot, spot.label ? ['hover', { label: spot.label }] : ['hoverPlain']);
      // The pointer is bound to the element that was approved.
      await browser.hoverAt(spot.x, spot.y, { guard, target, tabId: target.tabId });
      return observe(`Hovering [${at}].`);
    },
    scroll: async ({ direction, index, screens = 1 }) => {
      const at = Number.isInteger(index) ? index : null;
      const howMany = Number.isFinite(Number(screens)) ? Number(screens) : 1;
      const target = at === null ? await tabScope() : await elementTarget(at);
      const { guard } = await approve({
        action: 'scroll',
        args: { direction: String(direction), index: at, screens: howMany },
        tabId: target.tabId,
        target,
        describe: `Scroll ${direction}`,
      });
      const spot = at === null ? null : await browser.element(at, 'locate', null, { guard, target });
      const sign = direction === 'up' ? -1 : 1;
      const caption = [direction === 'up' ? 'scrollUp' : 'scrollDown'];
      if (spot) await overlay.pointTo(spot, caption);
      else await overlay.say(...caption);
      // A scroll inside an element is bound to that element: something that
      // covers the point takes no approval. A scroll of the page is bound to
      // the tab and its document.
      await browser.scroll(sign * Math.min(Math.max(howMany, 0.2), 10), spot, { guard, target, tabId: target.tabId });
      return observe(`Scrolled ${direction}.`);
    },
    get_text: async ({ start = 0, length = 6000 }) => {
      await permitRead({ action: 'get_text', args: { start, length }, tabId: await currentTabId(), describe: 'Read the text of the page' });
      const res = await browser.text(Math.max(0, start), Math.min(Math.max(length, 500), 15000));
      const end = res.start + res.text.length;
      // Dates come after the last slice and are not counted in the offsets.
      const dates = end >= res.total && res.dates?.length ? `\n\nDates on this page:\n${res.dates.join('\n')}` : '';
      return `Page text characters ${res.start}-${end} of ${res.total}${end < res.total ? ' (more available)' : ''}:\n${res.text}${dates}`;
    },
    screenshot: async () => {
      await permitRead({ action: 'screenshot', tabId: await currentTabId(), describe: 'Take a screenshot of the viewport' });
      const shot = await browser.screenshot();
      return { output: `Screenshot of the viewport attached (${shot.width}x${shot.height} CSS px; use these coordinates with click_at).`, images: [shot.dataUrl] };
    },
    history: async ({ action }) => {
      const scope = await tabScope();
      const { guard } = await approve({
        action: 'history',
        args: { action: String(action) },
        tabId: scope.tabId,
        target: scope,
        describe: `Go ${action}`,
      });
      await browser.history(action, { guard, tabId: scope.tabId });
      return observe(`Did ${action}.`);
    },
    wait: async ({ seconds }) => {
      await sleep(Math.min(Math.max(seconds, 0.5), 15) * 1000, signal);
      return observe(`Waited ${seconds}s.`);
    },
    list_tabs: async () => {
      await permitRead({ action: 'list_tabs', tabId: await currentTabId(), describe: 'List the open tabs' });
      const tabs = await chrome.tabs.query({});
      const current = (await browser.currentTab()).id;
      return tabs.map((t) => `${t.id === current ? '* ' : '  '}tab_id=${t.id} ${browser.ownsTab(t) ? '[yours] ' : ''}${t.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n');
    },
    switch_tab: async ({ tab_id }) => {
      const tab = tabIdOf(tab_id);
      const scope = await tabScope(tab);
      const { guard } = await approve({
        action: 'switch_tab',
        args: { tab_id: tab },
        tabId: scope.tabId,
        target: scope,
        describe: `Switch to tab ${tab}`,
      });
      await browser.useTab(tab, { guard });
      return observe(`Switched to tab ${tab}.${browser.takeClosedNote?.() ?? ''}`);
    },
    open_tab: async ({ url }) => {
      const place = normalizeUrl(url);
      const { guard } = await approve({
        action: 'open_tab',
        args: { url: place },
        tabId: null,
        target: null,
        describe: `Open ${place} in a new tab`,
      });
      const tab = await browser.openTab(place, { guard });
      await browser.waitForLoad({ expectNavigation: true });
      return observe(`Opened new tab ${tab.id}.${browser.takeClosedNote?.() ?? ''}`);
    },
    close_tab: async ({ tab_id }) => {
      const tab = tabIdOf(tab_id);
      const owner = browser.isTakenByOther(await chrome.tabs.get(tab));
      if (owner) throw new Error(`Tab ${tab} belongs to session "${owner}".`);
      const scope = await tabScope(tab);
      const { guard } = await approve({
        action: 'close_tab',
        args: { tab_id: tab },
        tabId: scope.tabId,
        target: scope,
        describe: `Close tab ${tab}`,
      });
      await guard();
      await browser.closeOwnedTab(tab, { guard });
      return `Closed tab ${tab}.`;
    },
    // @store-strip-start
    run_javascript: async ({ expression }) => {
      const scope = await tabScope();
      const { guard } = await approve({
        action: 'run_javascript',
        args: { expression: String(expression) },
        tabId: scope.tabId,
        target: scope,
        describe: 'Run JavaScript in the page',
      });
      const value = await browser.evaluate(expression, { guard, tabId: scope.tabId });
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
      // A command that was stopped runs nothing at all: not a question, not a
      // page, not a note.
      throwIfStopped(signal);
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

/** The index of an element of the latest snapshot, as a number. */
function indexOf(index) {
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0) throw new Error(`Element index ${JSON.stringify(index ?? null)} is not an element of the latest page.`);
  return at;
}

/** The id of a tab, as a number. */
function tabIdOf(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error(`Tab id ${JSON.stringify(tabId ?? null)} is not a tab id.`);
  return id;
}

/**
 * The calls of the browser that can change the page, or that can read a value
 * out of it.
 *
 * Each of them takes a guard: the thing that says the approval for this exact
 * operation is still there. The browser asks the guard again right before
 * every effect, so an approval that was withdrawn while the page was being
 * prepared stops the action instead of reaching the page.
 */
const PAGE_EFFECTS = new Set([
  'element', 'suggestions', 'clickAt', 'hoverAt', 'insertText', 'pressKey',
  'scroll', 'navigate', 'history', 'useTab', 'openTab', 'closeOwnedTab',
  'evaluate', 'readField', 'focusTarget', 'assertTypingTarget',
]);

/**
 * The browser, with one rule: a call that can change the page is only made
 * with a guard. A handler that forgot to ask for the approval gets a refusal
 * instead of an action nobody allowed.
 */
function guardOnly(browser) {
  return new Proxy(browser, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        const options = args.at(-1);
        const guarded = Boolean(options) && typeof options === 'object' && typeof options.guard === 'function';
        if (PAGE_EFFECTS.has(prop) && !guarded) {
          throw new Error(`The page may only be changed under an approval (${String(prop)}).`);
        }
        return value.apply(target, args);
      };
    },
  });
}

/** What the user is told an operation is about. Never a value of any field. */
function describeOf(what, index, target) {
  const label = target?.element?.label ?? '';
  return label ? `${what} element [${index}] "${label}"` : `${what} element [${index}]`;
}

/** Why an action was not allowed, in the words of the user. */
function refusal(reason) {
  if (reason === 'denied') return 'The user did not allow this action.';
  if (reason === 'aborted' || reason === 'cancelled') return 'The task was stopped before this action was allowed.';
  if (reason === 'stale-revision') return 'The access mode changed while the question was open, so nothing was allowed.';
  if (reason === 'unknown-action') return 'This session may not run that action.';
  return `This action was not allowed (${reason ?? 'no reason given'}).`;
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
