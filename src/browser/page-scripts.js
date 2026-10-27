// Functions injected into web pages with chrome.scripting.executeScript.
// Each one is serialized on its own, so it must not reference anything outside
// its own body (no imports, no shared helpers).
//
// Two things travel into a page as arguments instead of as module scope:
//
//   - the secret rule (see ../voice/voice-safety.js): the page and the module
//     must always agree on what a field that holds a secret is, so the lists
//     travel with the script instead of being written down twice;
//   - the target of an operation (see permissionTarget): the element the user
//     approved, so that every effect and every read is bound to that element
//     and to the document it was in.
//
// The identity of an element is the element itself, not a mark on it. The
// elements this extension collected are kept in the extension's own world of
// the frame, which the page cannot read and cannot write to. A page that
// copies a mark onto another element, or replaces an element with a twin, has
// not changed the identity of the element the user approved.
//
// What holds a secret is never described by what it holds: the value of a
// field that holds a secret, and the text of a control that holds one, are
// left out of the description of the control, of the name of its parent and
// of the text of the page. The rest of the page is left as it is: the value
// of an ordinary field is what the page shows, and the text of the page is
// the text of the page. A secret that the page shows as ordinary text is
// ordinary text, and no promise is made about it.

import { secretRule } from '../voice/voice-safety.js';

// The rule the module keeps. A script that is injected into a page always
// gets it as an argument; this is the fallback for a script that is called
// directly (a test). A page can never widen the rule: the lists of the module
// are the only ones that are used, and a page that happens to define a global
// with this name is not read.
const __postoraModuleSecretRule = secretRule();

/**
 * Indexes the interactive elements near the viewport and returns a compact,
 * model-readable description of the page.
 *
 * The description carries the value of an ordinary field (it is what the page
 * shows) and never the value of a field that holds a secret. The text of the
 * page leaves out the contents of the controls that hold a secret.
 */
export function snapshotPage(maxElements, maxTextChars, rule) {
  // The rule the module keeps (src/voice/voice-safety.js). A script that is
  // injected into a page always gets it as an argument; the fallback is for a
  // script that is called directly.
  const R = rule && Array.isArray(rule.tokens) && Array.isArray(rule.words) && Array.isArray(rule.fragments)
    ? rule
    : (typeof __postoraModuleSecretRule === 'undefined' ? null : __postoraModuleSecretRule);
  if (!R) return { error: 'The secret rule is missing: the page cannot be described safely.' };

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="combobox"]',
    '[role="textbox"]', '[role="searchbox"]', '[role="slider"]', '[contenteditable=""]',
    '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const collect = (root, out) => {
    root.querySelectorAll(INTERACTIVE).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collect(el.shadowRoot, out);
    });
    return out;
  };

  const isVisible = (el, rect) => {
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };

  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // Whether an element holds a value the user can write into. A role is a
  // claim, not a capability: only a real field can be written into.
  const canWrite = (el) => el.isContentEditable === true || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden', 'reset']
      .includes(String(el.type ?? '').toLowerCase()));

  // An element that only looks like a field still holds the user's text: that
  // text is not a name either.
  const looksEditable = (el) => canWrite(el) ||
    ['textbox', 'searchbox', 'combobox'].includes(String(el.getAttribute('role') ?? '').toLowerCase());

  // The name of a field with its separators and its case removed. The letters
  // of every language are kept: an Arabic name is not emptied by the cleaning.
  const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  // The words of a name: "cardNumber" and "card_number" both give card, number.
  const nameWords = (s) => String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label.
  const textWithout = (node, field) => {
    if (!node || node === field || node.isContentEditable === true ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) ||
      ['textbox', 'searchbox', 'combobox'].includes(node.getAttribute?.('role'))) return '';
    if (node.nodeType === 3) return node.nodeValue ?? '';
    return [...(node.childNodes ?? [])].map((child) => textWithout(child, field)).join('');
  };

  // The names the page gives an element: what it says about itself, the
  // elements that name it, and the label that belongs to it. The text of the
  // field itself is never part of it.
  const labelledBy = (el) => {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const scope = el.getRootNode?.() ?? document;
      const node = scope.getElementById?.(id) ?? document.getElementById?.(id);
      if (node) parts.push(textWithout(node, el));
    }
    for (const label of el.labels ?? []) {
      const text = textWithout(label, el);
      if (text) { parts.push(text); break; }
    }
    return parts.map((part) => String(part).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  };

  // The name the page gives an element, without any text of its own.
  const nameOf = (el) => labelledBy(el) || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';

  /**
   * True for a field that holds a secret: a password, a code, a card. The same
   * rule the module keeps (src/voice/voice-safety.js), so the page and the
   * module never disagree about what a secret field is.
   */
  const isSecret = (el, label = nameOf(el)) => {
    if (!el) return false;
    if (el.tagName === 'INPUT' && String(el.type ?? '').toLowerCase() === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token.startsWith('cc-') || R.tokens.includes(token))) return true;
    const names = [el.getAttribute('id'), el.getAttribute('name'), el.getAttribute('aria-label'), label]
      .filter(Boolean).join(' ');
    const flat = compact(names);
    if (R.fragments.some((fragment) => flat.includes(fragment))) return true;
    return nameWords(names).some((word) => R.words.includes(word));
  };

  // Whether an element holds another one, shadow roots included: the helper of
  // a terminal lives in the shadow root of the terminal.
  const holds = (el, other) => Boolean(el) && (el === other || Boolean(el.contains && el.contains(other)) ||
    Boolean(el.shadowRoot && el.shadowRoot.contains && el.shadowRoot.contains(other)));

  // The controls that hold a secret and carry text of their own: their
  // contents are not part of the page and not part of the name of anything.
  const secretTexts = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if ((el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'OUTPUT'].includes(el.tagName) ||
          ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role'))) && isSecret(el)) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found;
  };

  // The text of a node, without the contents of the controls that hold a
  // secret. The ordinary node is read as the browser shows it.
  const safeText = (root, hidden) => {
    const inside = hidden.filter((control) => holds(root, control));
    if (!inside.length) return root.innerText || '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      if (inside.includes(node)) return; // a control that holds a secret
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const block = /^(block|flex|grid|list-item|table|flow-root)/.test(style.display);
      if (block) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (block) parts.push('\n');
    };
    walk(root);
    return parts.join('');
  };

  // The label the model may read. A field never falls back to its own text:
  // what is in it is the user's, not a name. A control that holds a secret is
  // never named by its own text, and neither is the element around it.
  const labelOf = (el, hidden) => {
    const own = looksEditable(el) || isSecret(el) ? '' : safeText(el, hidden);
    return clean(
      el.getAttribute('aria-label') || labelledBy(el) || own || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.querySelector && el.querySelector('img[alt]')?.getAttribute('alt')),
      80,
    );
  };

  const describe = (el, hidden) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');
    let head = tag;
    if (type && tag === 'input') head += `[type=${type}]`;
    if (role) head += `[role=${role}]`;
    const label = labelOf(el, hidden);
    const parts = [head];
    if (label) parts.push(JSON.stringify(label));
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) parts.push(`placeholder=${JSON.stringify(clean(placeholder, 50))}`);
    if (el.name) parts.push(`name=${el.name}`);
    // The value of an ordinary field is what the page shows. The value of a
    // field that holds a secret is never read here, not even to leave it out.
    if (!isSecret(el, label) && 'value' in el && typeof el.value === 'string' && el.value) {
      parts.push(`value=${JSON.stringify(clean(el.value, 60))}`);
    }
    if (type === 'checkbox' || type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
    if (tag === 'select') {
      const options = [...el.options].slice(0, 12).map((o) => clean(o.text, 30));
      parts.push(`options=${JSON.stringify(options)}`);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`href=${clean(href, 80)}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.getAttribute('aria-expanded')) parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
    return parts.join(' ');
  };

  document.querySelectorAll('[data-agent-idx]').forEach((el) => el.removeAttribute('data-agent-idx'));
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const seen = new Set();
  const elements = [];
  let offscreen = 0;

  for (const el of collect(document, [])) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const near = rect.bottom > -vh * 0.25 && rect.top < vh * 1.5 && rect.right > 0 && rect.left < vw;
    if (!near || elements.length >= maxElements) {
      offscreen += 1;
      continue;
    }
    // Skip wrappers whose only purpose is to contain an already-indexed control.
    const owner = el.parentElement && el.parentElement.closest('a[href],button');
    if (owner && elements.includes(owner)) continue;
    elements.push(el);
  }

  // The elements of this snapshot, in the extension's own world of the frame.
  // The page cannot read this list and cannot change it: it is the only place
  // an index is resolved.
  window.__agentElements = elements;
  const hidden = secretTexts(document);
  const lines = elements.map((el, i) => {
    // The mark on the element is a display marker for the model, nothing more:
    // the identity of an element is the element itself.
    el.setAttribute('data-agent-idx', String(i));
    const rect = el.getBoundingClientRect();
    const where = rect.top >= 0 && rect.bottom <= vh ? '' : ' (below fold)';
    return `[${i}] ${describe(el, hidden)}${where}`;
  });

  // Machine-readable dates (<time>, GitHub's <relative-time>, any [datetime]). Their
  // shown text ("2 days ago") can live in a shadow root that innerText skips, so
  // each is listed with the nearest heading or link that says what it dates.
  const pageDates = () => {
    const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?)?$/;
    const squash = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[datetime]')) {
      if (lines.length >= 40) break;
      // A date inside a control that holds a secret is not a date of the page:
      // its contents are not read at all.
      if (hidden.some((control) => holds(control, el))) continue;
      // A date nobody sees (a hidden template or the other layout) takes no place in the 40.
      const look = getComputedStyle(el);
      if (!el.getClientRects().length || look.visibility === 'hidden' || Number(look.opacity) === 0) continue;
      const iso = (el.getAttribute('datetime') || '').trim();
      const parsed = ISO.test(iso) ? new Date(iso.replace(' ', 'T').replace(/ ?UTC$/, 'Z')) : null; // GitHub also writes '2026-09-04 22:12:00 UTC'
      // A real calendar date as written: V8 rolls 2026-02-30 over to March instead of
      // failing. The written day is checked, not the instant's UTC day, which differs
      // near midnight for offsets such as 2026-10-10T00:30:00+02:00.
      const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
      const written = new Date(Date.UTC(year, month - 1, day));
      if (!parsed || Number.isNaN(parsed.getTime()) || written.getUTCMonth() !== month - 1 || written.getUTCDate() !== day) continue;
      const shown = squash(el.innerText || (el.shadowRoot && el.shadowRoot.textContent), 40);
      // The heading just above a date names what it dates (a release, a post); headings
      // after it belong to the body. Only what is on screen: a hidden menu's heading names nothing.
      // A date inside the link or heading that names it (a card "Launch · Yesterday").
      // The box's visible text without the date element's own (a title may repeat the
      // date's words: "Yesterday's update" around a <time>Yesterday</time>).
      const textBesides = (box, skip) => {
        const parts = [];
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (skip.contains(n) || !n.parentElement || !n.parentElement.getClientRects().length) continue;
          // The text of a control that holds a secret is not the name of the
          // heading around it.
          if (hidden.some((control) => holds(control, n.parentElement))) continue;
          parts.push(n.nodeValue);
        }
        return parts.join(' ');
      };
      // Walks outward: a date-only link inside its heading gives nothing, the heading does.
      const around = () => {
        for (let box = el.parentElement && el.parentElement.closest('h1, h2, h3, h4, a[href]'); box; box = box.parentElement && box.parentElement.closest('h1, h2, h3, h4, a[href]')) {
          if (!box.getClientRects().length || getComputedStyle(box).visibility === 'hidden') continue;
          const own = squash(textBesides(box, el), 80);
          if (own) return own;
        }
        return '';
      };
      const near = (selector, levels) => {
        for (let a = el.parentElement, i = 0; a && i < levels; a = a.parentElement, i += 1) {
          let closest = '';
          const dated = [...a.querySelectorAll('[datetime]')].filter((d) => d !== el);
          for (const named of a.querySelectorAll(selector)) {
            if (named === el || named.contains(el) || !(named.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            // Another date between them means this heading names that one, not this.
            if (dated.some((d) => (named.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) && (d.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) continue;
            if (!named.getClientRects().length || getComputedStyle(named).visibility === 'hidden') continue;
            closest = squash(safeText(named, hidden), 80) || closest;
          }
          if (closest) return closest;
        }
        return '';
      };
      // A heading names only the first date after it, so a page or section heading
      // further up never labels every unrelated date below it.
      const label = around() || near('h1, h2, h3, h4', 8) || near('a[href]', 4);
      // The same date rendered twice (desktop and mobile layouts) counts once.
      const key = `${label} ${iso}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${label || '(no label)'} · ${shown || '—'} — ${iso}`);
    }
    return lines;
  };
  const text = clean(safeText(document.body, hidden), maxTextChars * 2)
    .slice(0, maxTextChars);
  const scrollHeight = document.documentElement.scrollHeight;
  return {
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(window.scrollY), viewport: vh, height: scrollHeight },
    elements: lines,
    offscreen,
    text,
    dates: pageDates(),
  };
}

/**
 * Runs one action against an element indexed by the latest snapshot. `quiet`
 * skips the outline flash when the on-page overlay draws its own highlight.
 *
 * `target` is the operation target (see permissionTarget). When there is one,
 * it is checked here, in the same script that acts, so an index cannot be
 * swapped while the action waits: the element must still be the element the
 * user approved, in the document the user approved it in.
 */
export function elementAction(index, action, value, quiet, rule, target) {
  const R = rule && Array.isArray(rule.tokens) && Array.isArray(rule.words) && Array.isArray(rule.fragments)
    ? rule
    : (typeof __postoraModuleSecretRule === 'undefined' ? null : __postoraModuleSecretRule);
  if (!R) return { error: 'The secret rule is missing: the page cannot be acted on safely.' };
  // The elements of the latest snapshot, in the extension's own world of the
  // frame. The mark on an element is a display marker for the model: it is
  // never the identity of an element, and the page cannot write to it.
  const list = window.__agentElements || [];
  const el = list[index];
  if (!el || !el.isConnected) return { error: `Element [${index}] no longer exists. Call read_page to refresh the element list.` };

  // Whether the element this action acts on is still the element that was
  // approved. The check lives in the script that acts, so an index cannot be
  // swapped while the action waits.
  const checkTarget = (node, wanted) => {
    const target = wanted?.element ?? null;
    if (!target || !target.token) return { ok: false, error: 'This action has no approved target.' };
    const reg = globalThis.__postoraTargetElements;
    const known = reg && typeof reg.get === 'function' ? reg.get(target.token) : null;
    if (known !== node) return { ok: false, error: 'The element that was approved is not the element that would be used.' };
    if (node.isConnected === false) return { ok: false, error: 'The element that was approved is no longer on the page.' };
    if (wanted.documentId && String(performance.timeOrigin) !== wanted.documentId) {
      return { ok: false, error: 'The page was replaced since the element was approved.' };
    }
    if (target.kind === 'element') {
      const current = window.__agentElements || [];
      if (current[index] !== node) return { ok: false, error: 'The element list was rebuilt since the element was approved.' };
    }
    if (target.kind === 'point') {
      const at = document.elementFromPoint(target.x, target.y);
      if (at !== node && !(node.contains && node.contains(at))) {
        return { ok: false, error: 'Another element is under the point that was approved.' };
      }
    }
    return { ok: true };
  };
  if (target) {
    const check = checkTarget(el, target);
    if (!check.ok) return { error: check.error };
  }

  // Whether an element holds a value the user can write into. A role is a
  // claim, not a capability: only a real field can be written into.
  const canWrite = (node) => node.isContentEditable === true || node.tagName === 'TEXTAREA' ||
    (node.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden', 'reset']
      .includes(String(node.type ?? '').toLowerCase()));

  // An element that only looks like a field still holds the user's text: that
  // text is not a name either.
  const looksEditable = (node) => canWrite(node) ||
    ['textbox', 'searchbox', 'combobox'].includes(String(node.getAttribute('role') ?? '').toLowerCase());

  // The name of a field with its separators and its case removed.
  const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const nameWords = (s) => String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label.
  const textWithout = (node, field) => {
    if (!node || node === field || node.isContentEditable === true ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) ||
      ['textbox', 'searchbox', 'combobox'].includes(node.getAttribute?.('role'))) return '';
    if (node.nodeType === 3) return node.nodeValue ?? '';
    return [...(node.childNodes ?? [])].map((child) => textWithout(child, field)).join('');
  };

  // The names the page gives an element: what it says about itself, the
  // elements that name it, and the label that belongs to it. The text of the
  // field itself is never part of it.
  const labelledBy = (node) => {
    const parts = [];
    const aria = node.getAttribute('aria-label');
    if (aria) parts.push(aria);
    for (const id of (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const scope = node.getRootNode?.() ?? document;
      const found = scope.getElementById?.(id) ?? document.getElementById?.(id);
      if (found) parts.push(textWithout(found, node));
    }
    for (const label of node.labels ?? []) {
      const text = textWithout(label, node);
      if (text) { parts.push(text); break; }
    }
    return parts.map((part) => String(part).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  };

  const nameOf = (node) => labelledBy(node) || node.getAttribute('title') ||
    node.getAttribute('placeholder') || node.getAttribute('name') || node.id || '';

  const isSecret = (node, label = nameOf(node)) => {
    if (!node) return false;
    if (node.tagName === 'INPUT' && String(node.type ?? '').toLowerCase() === 'password') return true;
    const tokens = String(node.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token.startsWith('cc-') || R.tokens.includes(token))) return true;
    const names = [node.getAttribute('id'), node.getAttribute('name'), node.getAttribute('aria-label'), label]
      .filter(Boolean).join(' ');
    const flat = compact(names);
    if (R.fragments.some((fragment) => flat.includes(fragment))) return true;
    return nameWords(names).some((word) => R.words.includes(word));
  };

  // Whether an element holds another one, shadow roots included.
  const holds = (node, other) => Boolean(node) && (node === other || Boolean(node.contains && node.contains(other)) ||
    Boolean(node.shadowRoot && node.shadowRoot.contains && node.shadowRoot.contains(other)));

  // The controls that hold a secret and carry text of their own.
  const secretTexts = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const node of scope.querySelectorAll('*')) {
        if ((node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'OUTPUT'].includes(node.tagName) ||
          ['textbox', 'searchbox', 'combobox'].includes(node.getAttribute('role'))) && isSecret(node)) found.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(root);
    return found;
  };

  // The text of a node, without the contents of the controls that hold a secret.
  const safeText = (root, hidden) => {
    const inside = hidden.filter((control) => holds(root, control));
    if (!inside.length) return root.innerText || '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      if (inside.includes(node)) return; // a control that holds a secret
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const block = /^(block|flex|grid|list-item|table|flow-root)/.test(style.display);
      if (block) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (block) parts.push('\n');
    };
    walk(root);
    return parts.join('');
  };

  // The label of the element. A field never falls back to its own text: what is
  // in it is the user's, not a name. A control that holds a secret is never
  // named by its own text, and neither is the element around it.
  const labelOf = (node) => {
    const own = looksEditable(node) || isSecret(node)
      ? ''
      : safeText(node, typeof document === 'undefined' ? [] : secretTexts(document));
    return (node.getAttribute('aria-label') || labelledBy(node) || own || node.getAttribute('placeholder') ||
      node.getAttribute('title') || node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  };

  const flash = () => {
    if (quiet) return;
    const prev = el.style.outline;
    el.style.outline = '3px solid #7c3aed';
    setTimeout(() => { el.style.outline = prev; }, 700);
  };

  if (action === 'locate') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    flash();
    const label = labelOf(el);
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      tag: el.tagName.toLowerCase(),
      label,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      secret: isSecret(el, label),
    };
  }
  if (action === 'select-all') {
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return { ok: true };
  }
  if (action === 'select-option') {
    if (el.tagName !== 'SELECT') return { error: `Element [${index}] is not a <select>; click it and pick the option instead.` };
    const wanted = String(value).trim().toLowerCase();
    const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted)
      || [...el.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
    if (!option) return { error: `No option matching "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(' | ')}` };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    flash();
    return { ok: true, selected: option.text.trim() };
  }
  if (action === 'text') {
    // The value of a field is not read here: a selected value leaves the page
    // only when it was asked for by name.
    if (canWrite(el)) return { error: `Element [${index}] is a field: its value is only read when it is asked for by name.` };
    return { text: (el.innerText || '').slice(0, value || 4000) };
  }
  return { error: `Unknown element action ${action}` };
}

/**
 * The suggestion list of an autocomplete field or custom dropdown. `mode` is
 * 'scan' (what the list offers), 'locate' (where the one exact match is, checked
 * again right before the click) or 'verify' (whether the field now shows it).
 * Only options tied to this field count: named by its aria-controls / aria-owns /
 * aria-activedescendant, or inside its own widget, so a second widget's open list
 * is never used. Text inside an open list never counts as chosen.
 */
export function suggestionAction(index, wanted, mode, rule, target) {
  // The rule is not needed here: a suggestion list carries the text of the
  // options, never the value of a field. The parameter is kept so that every
  // page script takes the same arguments.
  // The elements of the latest snapshot, in the extension's own world of the
  // frame: the mark on an element is a display marker, never the identity.
  const list = window.__agentElements || [];
  const field = list[index];
  if (!field || !field.isConnected) return { error: `Element [${index}] no longer exists. Call read_page to refresh the element list.` };

  // Whether the field this action acts on is still the field that was
  // approved. The check lives in the script that acts, so an index cannot be
  // swapped while the action waits.
  const checkTarget = (node, wanted) => {
    const target = wanted?.element ?? null;
    if (!target || !target.token) return { ok: false, error: 'This action has no approved target.' };
    const reg = globalThis.__postoraTargetElements;
    const known = reg && typeof reg.get === 'function' ? reg.get(target.token) : null;
    if (known !== node) return { ok: false, error: 'The element that was approved is not the element that would be used.' };
    if (node.isConnected === false) return { ok: false, error: 'The element that was approved is no longer on the page.' };
    if (wanted.documentId && String(performance.timeOrigin) !== wanted.documentId) {
      return { ok: false, error: 'The page was replaced since the element was approved.' };
    }
    if (target.kind === 'element') {
      const current = window.__agentElements || [];
      if (current[index] !== node) return { ok: false, error: 'The element list was rebuilt since the element was approved.' };
    }
    if (target.kind === 'point') {
      const at = document.elementFromPoint(target.x, target.y);
      if (at !== node && !(node.contains && node.contains(at))) {
        return { ok: false, error: 'Another element is under the point that was approved.' };
      }
    }
    return { ok: true };
  };
  if (target) {
    const check = checkTarget(field, target);
    if (!check.ok) return { error: check.error };
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target_ = norm(wanted);
  const visible = (el) => {
    if (!el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const isOtherField = (el) => el !== field && !el.contains(field) && !el.closest('[role=listbox]') && visible(el) &&
    (el.isContentEditable || el.matches('textarea, select, [role=combobox]') ||
      (el.tagName === 'INPUT' && !/^(hidden|submit|button|reset|image|checkbox|radio)$/i.test(el.type)));

  // Ancestors (up to 6 levels) that hold no other field: the field's own widget.
  const own = [];
  for (let p = field.parentElement, depth = 0; p && p !== document.body && depth < 6; p = p.parentElement, depth += 1) {
    if ([...p.querySelectorAll('input, textarea, select, [role=combobox], [contenteditable]')].some(isOtherField)) break;
    own.push(p);
  }
  const widget = own.at(-1) ?? null; // the widest, where a chosen value shows

  // ARIA ids resolve in the field's own tree first: a field in a shadow root names a
  // list in that same shadow root, which document.getElementById cannot see.
  const scope = field.getRootNode();
  const byId = (id) => (scope.getElementById && scope.getElementById(id)) || document.getElementById(id);
  const containers = [];
  const named = (el) => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
        const found = id && byId(id);
        if (found) containers.push(found);
      }
    }
  };
  named(field);
  const activeId = field.getAttribute('aria-activedescendant');
  const active = activeId && byId(activeId);
  if (active) containers.push(active.closest('[role=listbox]') || active.parentElement || active);
  // The owning combobox may be the field's shadow host (a custom element), so the
  // search walks out of shadow roots.
  let combo = null;
  for (let n = field; n && !combo; n = n.getRootNode().host || null) {
    const from = n === field ? field.parentElement : n;
    combo = from ? from.closest('[role=combobox]') : null;
  }
  if (combo && combo !== field) {
    named(combo);
    // A host's own popup lives in its shadow root, which the host's light DOM does not reach.
    containers.push(combo.shadowRoot && combo.shadowRoot.contains(field) ? combo.shadowRoot : combo);
  }

  const optionsIn = (list) => {
    const seen = new Set();
    const found = [];
    for (const c of list) {
      let candidates = [...(c.matches && c.matches('[role=option]') ? [c] : []), ...c.querySelectorAll('[role=option]')];
      if (!candidates.length) candidates = [...c.querySelectorAll('[id*="-option-"]')]; // react-select before v5 marks options only by id
      for (const o of candidates) {
        if (seen.has(o) || !visible(o) || o.matches('[aria-disabled=true], [disabled]')) continue;
        seen.add(o);
        found.push(o);
      }
    }
    return found;
  };
  // A list the field names is the only one used. Without one, the closest ancestor
  // of the field's own widget that shows options, so an unrelated list stays out.
  let options = optionsIn(containers);
  if (!containers.length) {
    for (const p of own) {
      options = optionsIn([p]);
      if (options.length) break;
    }
  }
  const label = (o) => (o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim();
  const matches = options.filter((o) => norm(label(o)) === target_);

  if (mode === 'scan') {
    return { tied: containers.length > 0 || own.length > 0, total: options.length, options: options.slice(0, 10).map(label), matches: matches.length };
  }
  if (mode === 'locate') {
    if (matches.length !== 1) return { error: `The list changed: ${matches.length} options now read "${wanted}". Nothing was clicked.` };
    const option = matches[0];
    option.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = option.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Bind the actual tied option here, before returning to the worker. A
    // later point capture could accidentally name a covering control instead.
    const registry = globalThis.__postoraTargetElements ??= new Map();
    const bits = globalThis.crypto.getRandomValues(new Uint32Array(2));
    const token = `option-${registry.size + 1}-${bits[0]}-${bits[1]}`;
    registry.set(token, option);
    const optionTarget = {
      scope: 'element', kind: 'point', tabId: target?.tabId ?? null,
      url: location.href, documentId: String(performance.timeOrigin), capturedAt: Date.now(),
      element: { kind: 'point', token, index: null, x, y, tag: option.tagName.toLowerCase(),
        editable: false, secret: false, focused: document.activeElement === option,
        body: false, label: label(option).slice(0, 80) },
    };
    return { x, y, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, text: label(option), target: optionTarget };
  }
  if (mode === 'verify') {
    // A plain autocomplete shows the choice as the field's value once its list closed;
    // a chip or single-value widget shows it as an element whose own text is exactly
    // the option. Not a label or heading ("City" when choosing City), not a longer
    // chip ("New York" when choosing York), and nothing inside an open list.
    if (norm(field.value) === target_ && !matches.length) return { ok: true };
    const root = widget || field.parentElement;
    for (const host of root.querySelectorAll('*')) {
      if (host.matches('label, legend, h1, h2, h3, h4, h5, h6') || host.closest('[role=listbox], [role=option], [id*="-option-"]') || !visible(host)) continue;
      const own = [...host.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' ');
      if (norm(own) === target_) return { ok: true };
    }
    return { ok: false };
  }
  return { error: `Unknown suggestion action ${mode}` };
}

/**
 * The identity of what an operation acts on: the element the user approved, and
 * whether it is still the same thing.
 *
 * `kind` says what to do:
 *   - 'capture' with `{ kind: 'element' | 'point' | 'focus', index?, x?, y? }`
 *     names an element: the indexed element of the latest snapshot, the element
 *     under a point, or the element that has the focus (deep inside a shadow
 *     root, if that is where it is). Nothing is scrolled, focused, flashed or
 *     read: the answer is an identity and nothing else.
 *   - 'resolve' with `{ target }` says whether the approved element is still the
 *     same element, in the same document, under the same point.
 *   - 'focus' with `{ target }` says whether the focus is still the approved
 *     element. The focus is approved for one element: another element that has
 *     the focus now does not inherit the approval, not even a child of the one
 *     that was approved.
 *   - 'typing' with `{ target }` says the same, and that the element that would
 *     receive the text is one that can really be written into.
 *   - 'apply-focus' with `{ target }` puts the focus on the approved element.
 *   - 'read' with `{ target }` reads the current value of the approved editable
 *     element. It is the only way a selected value leaves the page.
 *
 * The element itself stays in the extension's own world of the frame: the page
 * cannot read it and cannot move it. A clone that carries the mark of the
 * element, an element that was taken out of the page, an element that was
 * re-indexed and a document that was replaced at the same address all fail.
 */
export function permissionTarget(kind, arg, rule) {
  const R = rule && Array.isArray(rule.tokens) && Array.isArray(rule.words) && Array.isArray(rule.fragments)
    ? rule
    : (typeof __postoraModuleSecretRule === 'undefined' ? null : __postoraModuleSecretRule);
  if (!R) return { ok: false, reason: 'no-secret-rule' };

  // The elements this extension named, kept in the extension's own world of the
  // frame. The page cannot read this map and cannot write to it.
  const REGISTRY = '__postoraTargetElements';
  const registry = () => {
    let reg = globalThis[REGISTRY];
    if (!reg || typeof reg.get !== 'function' || typeof reg.set !== 'function') {
      reg = new Map();
      globalThis[REGISTRY] = reg;
    }
    return reg;
  };
  const register = (el) => {
    const reg = registry();
    let token = `t${reg.size + 1}-`;
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bits = crypto.getRandomValues(new Uint32Array(2));
      token += bits[0].toString(36) + bits[1].toString(36);
    } else {
      token += Math.random().toString(36).slice(2);
    }
    reg.set(token, el);
    return token;
  };

  // Whether an element holds a value the user can write into. A role is a
  // claim, not a capability: only a real field can be written into, and only a
  // real field is read.
  const canWrite = (el) => el.isContentEditable === true || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden', 'reset']
      .includes(String(el.type ?? '').toLowerCase()));
  // A field that can be written to: not the body, not read-only, not disabled.
  const writable = (el) => canWrite(el) && el !== document.body && el !== document.documentElement &&
    !el.readOnly && !el.disabled && el.getAttribute('aria-disabled') !== 'true';

  // An element that only looks like a field still holds the user's text: that
  // text is not a name either.
  const looksEditable = (el) => canWrite(el) ||
    ['textbox', 'searchbox', 'combobox'].includes(String(el.getAttribute('role') ?? '').toLowerCase());

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label.
  const textWithout = (node, field) => {
    if (!node || node === field || node.isContentEditable === true ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) ||
      ['textbox', 'searchbox', 'combobox'].includes(node.getAttribute?.('role'))) return '';
    if (node.nodeType === 3) return node.nodeValue ?? '';
    return [...(node.childNodes ?? [])].map((child) => textWithout(child, field)).join('');
  };

  // The names the page gives an element: what it says about itself, the
  // elements that name it, and the label that belongs to it. The text of the
  // field itself is never part of it.
  const labelledBy = (el) => {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const scope = el.getRootNode?.() ?? document;
      const found = scope.getElementById?.(id) ?? document.getElementById?.(id);
      if (found) parts.push(textWithout(found, el));
    }
    for (const label of el.labels ?? []) {
      const text = textWithout(label, el);
      if (text) { parts.push(text); break; }
    }
    return parts.map((part) => String(part).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  };

  const nameOf = (el) => labelledBy(el) || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';

  // The name of a field with its separators and its case removed.
  const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const nameWords = (s) => String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  const isSecret = (el, label = nameOf(el)) => {
    if (!el) return false;
    if (el.tagName === 'INPUT' && String(el.type ?? '').toLowerCase() === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token.startsWith('cc-') || R.tokens.includes(token))) return true;
    const names = [el.getAttribute('id'), el.getAttribute('name'), el.getAttribute('aria-label'), label]
      .filter(Boolean).join(' ');
    const flat = compact(names);
    if (R.fragments.some((fragment) => flat.includes(fragment))) return true;
    return nameWords(names).some((word) => R.words.includes(word));
  };

  // Whether an element holds another one, shadow roots included.
  const holds = (el, other) => Boolean(el) && (el === other || Boolean(el.contains && el.contains(other)) ||
    Boolean(el.shadowRoot && el.shadowRoot.contains && el.shadowRoot.contains(other)));

  // The element that has the focus, deep inside a shadow root if that is where
  // it is: a terminal puts the focus in its own hidden textarea.
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  const deepAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot?.elementFromPoint) {
      const next = el.shadowRoot.elementFromPoint(x, y);
      if (!next || next === el) break;
      el = next;
    }
    return el;
  };

  // Decorative descendants belong to the approved control; another control
  // nested inside it does not. In particular, blank-body consent cannot cover
  // every control a page might subsequently insert into the body.
  const receivesHit = (owner, hit) => {
    if (owner === hit) return true;
    if (!hit || owner === document.body || owner === document.documentElement) return false;
    const controls = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="option"],[role="textbox"],[contenteditable],[onclick],[tabindex]';
    for (let node = hit; node; node = node.parentElement ?? node.getRootNode?.()?.host ?? null) {
      if (node === owner) return true;
      if (node.matches?.(controls)) return false;
    }
    return false;
  };

  // The controls that hold a secret and carry text of their own.
  const secretTexts = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if ((el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'OUTPUT'].includes(el.tagName) ||
          ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role'))) && isSecret(el)) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found;
  };

  // The text of a node, without the contents of the controls that hold a secret.
  const safeText = (root, hidden) => {
    const inside = hidden.filter((control) => holds(root, control));
    if (!inside.length) return root.innerText || '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      if (inside.includes(node)) return; // a control that holds a secret
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const block = /^(block|flex|grid|list-item|table|flow-root)/.test(style.display);
      if (block) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (block) parts.push('\n');
    };
    walk(root);
    return parts.join('');
  };

  // The label of the element. A field never falls back to its own text: what is
  // in it is the user's, not a name. A control that holds a secret is never
  // named by its own text, and neither is the element around it. The body is
  // never described: its text is the text of the page.
  const labelOf = (el) => {
    if (!el || el === document.body) return '';
    const own = looksEditable(el) || isSecret(el)
      ? ''
      : safeText(el, typeof document === 'undefined' ? [] : secretTexts(document));
    return (el.getAttribute('aria-label') || labelledBy(el) || own || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.id || '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  };

  const shape = (el, kind, token, index, point) => {
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const label = labelOf(el);
    return {
      kind,
      token,
      index: index ?? null,
      x: point ? point.x : (rect ? rect.left + rect.width / 2 : null),
      y: point ? point.y : (rect ? rect.top + rect.height / 2 : null),
      tag: el && el.tagName ? String(el.tagName).toLowerCase() : '',
      editable: canWrite(el),
      secret: isSecret(el, label),
      focused: deepActive() === el,
      body: el === document.body,
      label,
    };
  };

  if (kind === 'capture') {
    const what = arg?.kind === 'element' || arg?.kind === 'point' ? arg.kind : 'focus';
    let el = null;
    let index = null;
    let point = null;
    if (what === 'element') {
      index = Number(arg?.index);
      const list = window.__agentElements || [];
      el = list[index];
    } else if (what === 'point') {
      point = { x: Number(arg?.x), y: Number(arg?.y) };
      el = deepAt(point.x, point.y);
    } else {
      el = deepActive();
    }
    if (!el) return { ok: false, reason: what === 'element' ? 'no-element' : 'nothing-focused' };
    const token = register(el);
    return { ok: true, documentId: String(performance.timeOrigin), element: shape(el, what, token, index, point) };
  }

  if (kind === 'document') {
    // The identity of the document, for a target that names a tab and not an
    // element. Nothing of the page is read.
    return { ok: true, documentId: String(performance.timeOrigin) };
  }

  const target = arg?.target ?? null;
  const wanted = target?.element ?? null;
  if (!target || !wanted || !wanted.token) return { ok: false, reason: 'no-target' };
  const el = registry().get(wanted.token);
  if (!el) return { ok: false, reason: 'unknown-element' };
  if (el.isConnected === false) return { ok: false, reason: 'element-gone' };
  // The same address, a new document: the page was replaced.
  if (target.documentId && String(performance.timeOrigin) !== target.documentId) {
    return { ok: false, reason: 'document-changed' };
  }
  // The element of the snapshot must still be the element that was approved:
  // a rebuilt list has other elements at that index.
  if (wanted.kind === 'element') {
    const list = window.__agentElements || [];
    if (list[wanted.index] !== el) return { ok: false, reason: 'reindexed' };
  }
  // The point must still lie on the element that was approved.
  if (wanted.kind === 'point') {
    const at = deepAt(wanted.x, wanted.y);
    if (!receivesHit(el, at)) return { ok: false, reason: 'hit-replaced' };
  }

  const active = deepActive();
  if (kind === 'hit') {
    if (!Number.isFinite(arg?.x) || !Number.isFinite(arg?.y)) return { ok: false, reason: 'invalid-point' };
    if (!receivesHit(el, deepAt(arg.x, arg.y))) return { ok: false, reason: 'hit-replaced' };
    return { ok: true };
  }
  if (kind === 'focus' || kind === 'typing') {
    // The focus is approved for one element: a field that has the focus now is
    // another element, and it does not inherit the approval, not even when it
    // is a child of the element that was approved.
    if (active !== el) return { ok: false, reason: 'focus-lost' };
    // The text may only go into something that can really be written to: never
    // into the body, never into a field that is read-only or disabled.
    if (kind === 'typing' && !writable(active)) return { ok: false, reason: 'not-editable' };
    return { ok: true, tag: String(active?.tagName ?? '').toLowerCase(), editable: canWrite(active) };
  }

  if (kind === 'apply-focus') {
    el.focus();
    return { ok: true, focused: deepActive() === el, tag: String(el.tagName ?? '').toLowerCase() };
  }

  if (kind === 'read') {
    // Only the value of the approved element, and only when it is a field that
    // can be written to. The page marker is never a fallback.
    if (!canWrite(el)) return { ok: false, reason: 'not-editable' };
    const value = 'value' in el && typeof el.value === 'string'
      ? el.value
      : (el.isContentEditable ? String(el.textContent ?? '') : '');
    return {
      ok: true,
      value,
      tag: String(el.tagName ?? '').toLowerCase(),
      secret: isSecret(el),
    };
  }

  return { ok: true };
}

/** Returns a slice of the page's visible text for reading long pages, and the page's dates. */
export function pageText(start, length, rule) {
  const R = rule && Array.isArray(rule.tokens) && Array.isArray(rule.words) && Array.isArray(rule.fragments)
    ? rule
    : (typeof __postoraModuleSecretRule === 'undefined' ? null : __postoraModuleSecretRule);
  if (!R) return { error: 'The secret rule is missing: the page text cannot be read safely.' };

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label.
  const textWithout = (node, field) => {
    if (!node || node === field || node.isContentEditable === true ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) ||
      ['textbox', 'searchbox', 'combobox'].includes(node.getAttribute?.('role'))) return '';
    if (node.nodeType === 3) return node.nodeValue ?? '';
    return [...(node.childNodes ?? [])].map((child) => textWithout(child, field)).join('');
  };

  // The names the page gives an element: what it says about itself, the
  // elements that name it, and the label that belongs to it. The text of the
  // field itself is never part of it.
  const labelledBy = (el) => {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const scope = el.getRootNode?.() ?? document;
      const found = scope.getElementById?.(id) ?? document.getElementById?.(id);
      if (found) parts.push(textWithout(found, el));
    }
    for (const label of el.labels ?? []) {
      const text = textWithout(label, el);
      if (text) { parts.push(text); break; }
    }
    return parts.map((part) => String(part).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  };

  // The name of a field with its separators and its case removed.
  const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const nameWords = (s) => String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  const nameOf = (el) => labelledBy(el) || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';

  const isSecret = (el, label = nameOf(el)) => {
    if (!el) return false;
    if (el.tagName === 'INPUT' && String(el.type ?? '').toLowerCase() === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token.startsWith('cc-') || R.tokens.includes(token))) return true;
    const names = [el.getAttribute('id'), el.getAttribute('name'), el.getAttribute('aria-label'), label]
      .filter(Boolean).join(' ');
    const flat = compact(names);
    if (R.fragments.some((fragment) => flat.includes(fragment))) return true;
    return nameWords(names).some((word) => R.words.includes(word));
  };

  // Whether an element holds another one, shadow roots included.
  const holds = (el, other) => Boolean(el) && (el === other || Boolean(el.contains && el.contains(other)) ||
    Boolean(el.shadowRoot && el.shadowRoot.contains && el.shadowRoot.contains(other)));

  // The controls that hold a secret and carry text of their own.
  const secretTexts = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if ((el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'OUTPUT'].includes(el.tagName) ||
          ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role'))) && isSecret(el)) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found;
  };

  // The text of a node, without the contents of the controls that hold a secret.
  const safeText = (root, hidden) => {
    const inside = hidden.filter((control) => holds(root, control));
    if (!inside.length) return root.innerText || '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      if (inside.includes(node)) return; // a control that holds a secret
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const block = /^(block|flex|grid|list-item|table|flow-root)/.test(style.display);
      if (block) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (block) parts.push('\n');
    };
    walk(root);
    return parts.join('');
  };

  // Machine-readable dates (<time>, GitHub's <relative-time>, any [datetime]). Their
  // shown text ("2 days ago") can live in a shadow root that innerText skips, so
  // each is listed with the nearest heading or link that says what it dates.
  const pageDates = () => {
    const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?)?$/;
    const squash = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[datetime]')) {
      if (lines.length >= 40) break;
      // A date inside a control that holds a secret is not a date of the page:
      // its contents are not read at all.
      if (hidden.some((control) => holds(control, el))) continue;
      // A date nobody sees (a hidden template or the other layout) takes no place in the 40.
      const look = getComputedStyle(el);
      if (!el.getClientRects().length || look.visibility === 'hidden' || Number(look.opacity) === 0) continue;
      const iso = (el.getAttribute('datetime') || '').trim();
      const parsed = ISO.test(iso) ? new Date(iso.replace(' ', 'T').replace(/ ?UTC$/, 'Z')) : null; // GitHub also writes '2026-09-04 22:12:00 UTC'
      // A real calendar date as written: V8 rolls 2026-02-30 over to March instead of
      // failing. The written day is checked, not the instant's UTC day, which differs
      // near midnight for offsets such as 2026-10-10T00:30:00+02:00.
      const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
      const written = new Date(Date.UTC(year, month - 1, day));
      if (!parsed || Number.isNaN(parsed.getTime()) || written.getUTCMonth() !== month - 1 || written.getUTCDate() !== day) continue;
      const shown = squash(el.innerText || (el.shadowRoot && el.shadowRoot.textContent), 40);
      // The heading just above a date names what it dates (a release, a post); headings
      // after it belong to the body. Only what is on screen: a hidden menu's heading names nothing.
      // A date inside the link or heading that names it (a card "Launch · Yesterday").
      // The box's visible text without the date element's own (a title may repeat the
      // date's words: "Yesterday's update" around a <time>Yesterday</time>).
      const textBesides = (box, skip) => {
        const parts = [];
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (skip.contains(n) || !n.parentElement || !n.parentElement.getClientRects().length) continue;
          // The text of a control that holds a secret is not the name of the
          // heading around it.
          if (hidden.some((control) => holds(control, n.parentElement))) continue;
          parts.push(n.nodeValue);
        }
        return parts.join(' ');
      };
      // Walks outward: a date-only link inside its heading gives nothing, the heading does.
      const around = () => {
        for (let box = el.parentElement && el.parentElement.closest('h1, h2, h3, h4, a[href]'); box; box = box.parentElement && box.parentElement.closest('h1, h2, h3, h4, a[href]')) {
          if (!box.getClientRects().length || getComputedStyle(box).visibility === 'hidden') continue;
          const own = squash(textBesides(box, el), 80);
          if (own) return own;
        }
        return '';
      };
      const near = (selector, levels) => {
        for (let a = el.parentElement, i = 0; a && i < levels; a = a.parentElement, i += 1) {
          let closest = '';
          const dated = [...a.querySelectorAll('[datetime]')].filter((d) => d !== el);
          for (const named of a.querySelectorAll(selector)) {
            if (named === el || named.contains(el) || !(named.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            // Another date between them means this heading names that one, not this.
            if (dated.some((d) => (named.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) && (d.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) continue;
            if (!named.getClientRects().length || getComputedStyle(named).visibility === 'hidden') continue;
            closest = squash(safeText(named, hidden), 80) || closest;
          }
          if (closest) return closest;
        }
        return '';
      };
      // A heading names only the first date after it, so a page or section heading
      // further up never labels every unrelated date below it.
      const label = around() || near('h1, h2, h3, h4', 8) || near('a[href]', 4);
      // The same date rendered twice (desktop and mobile layouts) counts once.
      const key = `${label} ${iso}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${label || '(no label)'} · ${shown || '—'} — ${iso}`);
    }
    return lines;
  };
  const hidden = secretTexts(document);
  const text = safeText(document.body, hidden).replace(/\n{3,}/g, '\n\n');
  return { total: text.length, start, text: text.slice(start, start + length), dates: pageDates() };
}

/**
 * Resolves once the page's content has not changed for `quietMs`, or after `maxMs`
 * at most. Until the first change it waits `firstQuietMs`, long enough for a click
 * that starts a request (search, autocomplete) to show its result. Attribute
 * changes (animations, hover styles) do not count, so busy pages end at the cap.
 */
export function domSettled(quietMs, maxMs, firstQuietMs = quietMs) {
  return new Promise((resolve) => {
    let timer = setTimeout(done, firstQuietMs);
    const cap = setTimeout(done, maxMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(true);
    }
  });
}

/** Identifies the current document: a new one (reload, form post) gets a new value even at the same URL. */
export function documentIdOf() {
  return String(performance.timeOrigin);
}

export function pageReadyState() {
  return { readyState: document.readyState, url: location.href };
}

export function devicePixelRatioOf() {
  return window.devicePixelRatio || 1;
}
