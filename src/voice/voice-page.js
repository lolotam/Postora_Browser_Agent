// Functions injected into web pages with chrome.scripting.executeScript.
//
// One function does everything that has to know about secrets, so the rule is
// written once: page scripts cannot share module scope, and several copies of
// the same check drift apart. The rule itself comes in as an argument (see
// voice-safety.js), so the page and the module always agree.
//
// The names of the elements are the names the page gives them, and nothing
// else: the text of a field is the user's, not a name, and the value of a
// field never leaves the page on its own.
//
// A field that holds a secret is named like any other field — the page names
// it too, and the user has to be able to say which field they mean — but it
// is never incidentally read or described by what is in it, and its value leaves the
// page only for the one read the user allowed (the 'read' kind, which only the
// worker may call, and only after the approval of that exact read).
//
// The identity of an element is the element itself, not a mark on it. The
// elements that were collected are kept in the extension's own world of the
// frame, which the page cannot read and cannot write to. A page that copies
// the mark onto another element, or replaces the element with a twin, has not
// changed the identity of the element the user approved.
//
// The errors are message keys, not sentences: the panel translates them, so
// the same page works in the panel's language.

/**
 * The one page script that knows about secrets.
 *
 * `kind` says what to look at:
 *   - 'collect' with `{ purpose: 'click' | 'type' | 'read' }` lists the elements
 *     of the page, with the label the model may read;
 *   - 'focused' says what has the focus, deep inside a shadow root if that is
 *     where it is (a terminal puts the focus in its own hidden textarea), and
 *     names it (the body is named too, and never described: its text is the
 *     text of the page);
 *   - 'locate' with `{ id }` says where an element is and whether it still
 *     holds a secret;
 *   - 'resolve' with `{ id, expected }` says whether the element the user
 *     approved is still the same element, and where it is now;
 *   - 'focus' with `{ id }` says whether the element the user approved still
 *     has the focus;
 *   - 'read' with `{ id, expected }` reads the value of the element the user
 *     approved: the only way a value leaves the page;
 *   - 'document' says which document the page is, so a page that was replaced
 *     is not the page that was approved.
 */
export function pageProbe(kind, arg, rule) {
  if (arg?.documentId && String(performance.timeOrigin) !== arg.documentId) {
    return { ok: false, errorKey: 'voice.pageGone' };
  }
  const R = rule && Array.isArray(rule.tokens) && Array.isArray(rule.words) && Array.isArray(rule.fragments)
    ? rule
    : { tokens: [], words: [], fragments: [] };
  const tokens = R.tokens;
  const words = R.words;
  const fragments = R.fragments;

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // The name of a field with its separators and its case removed. The letters
  // of every language are kept: an Arabic name is not emptied by the cleaning.
  const compact = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  // The words of a name: "cardNumber" and "card_number" both give card, number.
  const nameWords = (s) => String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  // True for a name that marks a field as holding a secret.
  const secretName = (...parts) => {
    const text = parts.filter(Boolean).join(' ');
    if (!text.trim()) return false;
    const flat = compact(text);
    if (fragments.some((fragment) => flat.includes(fragment))) return true;
    return nameWords(text).some((word) => words.includes(word));
  };

  const autocompleteTokens = (el) => String(el.getAttribute?.('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);

  // Whether an element holds a value the user can write into. A role is a
  // claim, not a capability: only a real field can be written to.
  const canWrite = (el) => el?.isContentEditable === true || el?.tagName === 'TEXTAREA' ||
    (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden', 'reset']
      .includes(String(el.type ?? '').toLowerCase()));

  // A field that can really be written to: not the body, not read-only, not
  // disabled. A role on its own is not enough.
  const writable = (el) => canWrite(el) && el !== document.body && el !== document.documentElement &&
    !el.readOnly && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';

  // An element that only looks like a field still holds the user's text: that
  // text is not a name either.
  const looksEditable = (el) => canWrite(el) ||
    ['textbox', 'searchbox', 'combobox'].includes(String(el.getAttribute?.('role') ?? '').toLowerCase());

  const isSecret = (el, label) => {
    if (!el) return false;
    if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') return true;
    if (autocompleteTokens(el).some((token) => token.startsWith('cc-') || tokens.includes(token))) return true;
    return secretName(el.getAttribute?.('id'), el.getAttribute?.('name'), el.getAttribute?.('aria-label'), label);
  };

  // Whether an element holds another one, shadow roots included.
  const holds = (el, other) => Boolean(el) && (el === other || Boolean(el.contains && el.contains(other)) ||
    Boolean(el.shadowRoot && el.shadowRoot.contains && el.shadowRoot.contains(other)));

  // The elements this extension collected, kept in the extension's own world
  // of the frame. The page cannot read them and cannot move them.
  const REGISTRY = '__postoraVoiceElements';
  const registry = () => {
    let reg = globalThis[REGISTRY];
    if (!reg || typeof reg.get !== 'function' || typeof reg.set !== 'function') {
      reg = new Map();
      globalThis[REGISTRY] = reg;
    }
    return reg;
  };

  // A mark that names one element for the extension. The page may copy it
  // around, so it is never the identity of an element on its own.
  const mark = (el, n) => {
    let token = `v${n}`;
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bits = crypto.getRandomValues(new Uint32Array(2));
      token += `-${bits[0].toString(36)}${bits[1].toString(36)}`;
    }
    const reg = registry();
    if (reg) reg.set(token, el);
    el.setAttribute('data-voice-id', token);
    return token;
  };

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label, and neither does the draft of another field. An editor is
  // never a name: what is written in it belongs to the user.
  const textWithout = (node, field) => {
    if (!node || node === field) return '';
    if (node.isContentEditable === true) return '';
    const tag = String(node.tagName ?? '');
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return '';
    const role = String(node.getAttribute?.('role') ?? '').toLowerCase();
    if (['textbox', 'searchbox', 'combobox'].includes(role)) return '';
    if (node.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? '');
    const children = node.childNodes ?? [];
    if (!children.length) return String(node.innerText ?? node.textContent ?? '');
    let out = '';
    for (const child of children) out += textWithout(child, field);
    return out;
  };

  // The names the page gives an element: what it says about itself, the
  // elements that name it, and the label that belongs to it. A label inside a
  // shadow root counts: a terminal names its own field from its own tree.
  const labelledBy = (el) => {
    const parts = [];
    const aria = el.getAttribute?.('aria-label');
    if (aria) parts.push(aria);
    for (const id of String(el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
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

  const nameOf = (el) => labelledBy(el) || el.getAttribute?.('title') ||
    el.getAttribute?.('placeholder') || el.getAttribute?.('name') || el.id || '';

  // The controls that hold a secret and carry text of their own.
  const secretTexts = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll?.('*') ?? []) {
        if (isSecret(el, nameOf(el))) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found;
  };

  // The text of a node, without the contents of the controls that hold a
  // secret: the name of an element is never the text of a secret field.
  const safeText = (root, hidden) => {
    const inside = hidden.filter((control) => holds(root, control));
    if (!inside.length) return root.innerText || '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue ?? node.textContent ?? ''); return; }
      if (node.nodeType !== undefined && node.nodeType !== 1) return;
      if (inside.includes(node)) return; // a control that holds a secret
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
      const children = node.childNodes ?? [];
      if (!children.length) {
        if (node.innerText) parts.push(node.innerText);
        return;
      }
      for (const child of children) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
    };
    walk(root);
    return parts.join('');
  };

  // The controls that hold a secret, once for this run of the script: the
  // page is walked once, not once per element.
  let hiddenCache = null;
  const hiddenControls = () => (hiddenCache ??= secretTexts(document));

  // The label the model may read. An editable field never falls back to its
  // own text: what is in it is the user's, not a name. A field that holds a
  // secret is named by what the page calls it, never by what is in it.
  const labelOf = (el) => {
    if (!el || el === document.body) return '';
    const hidden = hiddenControls();
    const own = looksEditable(el) || isSecret(el, nameOf(el)) ? '' : safeText(el, hidden);
    return (el.getAttribute?.('aria-label') || labelledBy(el) || own || el.getAttribute?.('placeholder') ||
      el.getAttribute?.('title') || el.getAttribute?.('name') || el.id || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
  };

  const kindOf = (el) => {
    const role = el.getAttribute?.('role');
    if (el.isContentEditable) return 'text editor';
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'TEXTAREA') return 'text area';
    if (el.tagName === 'SELECT') return 'dropdown';
    if (el.tagName === 'INPUT') return `${el.type || 'text'} input`;
    return role || el.tagName.toLowerCase();
  };

  // The element the extension collected under this mark, or null. The mark on
  // the page is never the identity: the element itself is, and only the
  // extension's own world holds it.
  const collected = (id) => {
    const reg = registry();
    if (!reg) return null;
    return reg.get(id) ?? null;
  };

  // The element that has the focus, deep inside a shadow root if that is where
  // it is: a terminal puts the focus in its own hidden textarea.
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  // The document the page is, so a page that was replaced is not the page that
  // was approved.
  const documentId = () => {
    const time = typeof performance !== 'undefined' ? performance.timeOrigin : null;
    return time === null || time === undefined ? '' : String(time);
  };

  // Whether the element is still the one that was approved: the same kind and
  // the same label it really had when it was collected.
  const sameIdentity = (el, expected) => {
    if (!expected) return true;
    const kindName = kindOf(el);
    if (expected.kind && kindName !== expected.kind) return false;
    // The label that is compared is the one the element really had when it
    // was collected: an empty label is a label too.
    if (expected.label != null && clean(expected.label) !== labelOf(el)) return false;
    return true;
  };

  if (kind === 'document') {
    return { ok: true, documentId: documentId() };
  }

  if (kind === 'focused') {
    const el = deepActive();
    if (!el) return { editable: false, writable: false, secret: false, id: null };
    // The body is an element like every other one: it is registered too, so
    // an approved Enter is tied to the body it was approved on and not to
    // whatever has the focus later. It is never described: its text is the
    // text of the page, and the page does not belong to the model.
    if (el === document.body) {
      const id = mark(el, 0);
      return { editable: false, writable: false, secret: false, body: true, id, label: undefined };
    }
    // The label is the safe one: the text of an editable field is never used,
    // but the name beside it still says what the field is.
    const label = labelOf(el);
    // The element that has the focus is named, so the worker may check later
    // that the same element still has it.
    const id = mark(el, 0);
    return {
      editable: canWrite(el),
      writable: writable(el),
      secret: isSecret(el, label),
      body: false,
      id,
      label,
      kind: kindOf(el),
    };
  }

  if (kind === 'locate') {
    // The element is brought into view and its place is named. This changes
    // the page, so it only runs after the user allowed the action: a capture
    // that is done before the question never moves anything.
    const el = arg?.id ? collected(arg.id) : deepActive();
    if (!el || el === document.body) return { ok: false, errorKey: 'voice.pageNoField' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    const label = labelOf(el);
    if (!sameIdentity(el, arg?.expected ?? null)) return { ok: false, errorKey: 'voice.pageGone' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) return { ok: false, errorKey: 'voice.pageGone' };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Something that covers the element would get the click instead of it.
    const at = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : el;
    if (at && at !== el && !(typeof el.contains === 'function' && el.contains(at))) {
      return { ok: false, errorKey: 'voice.pageMoved' };
    }
    return {
      ok: true,
      x,
      y,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      label,
      kind: kindOf(el),
      secret: isSecret(el, label),
      documentId: documentId(),
    };
  }

  // The element the user approved: is it still the same element, and is it
  // still the one that was approved? Nothing of the page is changed here: the
  // question is asked before anything moves.
  if (kind === 'resolve') {
    const el = arg?.id ? collected(arg.id) : null;
    if (!el) return { ok: false, errorKey: 'voice.pageGone' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    const label = labelOf(el);
    if (!sameIdentity(el, arg?.expected ?? null)) return { ok: false, errorKey: 'voice.pageGone' };
    return {
      ok: true,
      label,
      kind: kindOf(el),
      secret: isSecret(el, label),
      body: el === document.body,
      focused: deepActive() === el,
      writable: writable(el),
      // The document the element was found in: a page that was replaced is
      // not the page that was approved.
      documentId: documentId(),
    };
  }

  // The point that was approved: is the element still under it, and is it
  // still the same element in the same document? Nothing of the page is
  // changed here, so it may be used in the last check before an effect.
  if (kind === 'hit') {
    const el = arg?.id ? collected(arg.id) : null;
    if (!el) return { ok: false, errorKey: 'voice.pageGone' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    if (!sameIdentity(el, arg?.expected ?? null)) return { ok: false, errorKey: 'voice.pageGone' };
    const r = el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) return { ok: false, errorKey: 'voice.pageGone' };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // The element has to lie under the point that was approved still.
    if (Number.isFinite(arg?.x) && (x !== arg.x || y !== arg.y)) {
      return { ok: false, errorKey: 'voice.pageMoved' };
    }
    // Something that covers the element would get the click instead of it.
    const at = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : el;
    if (at && at !== el && !(typeof el.contains === 'function' && el.contains(at))) {
      return { ok: false, errorKey: 'voice.pageMoved' };
    }
    return { ok: true, x, y, documentId: documentId() };
  }

  // The focus the user approved: the same element still has it.
  if (kind === 'focus') {
    const active = deepActive();
    // The focus is approved for one element. Without its identity nothing is
    // approved: there is no fallback to whatever has the focus now.
    if (!arg?.id) return { ok: false, errorKey: 'voice.pageFocusLost' };
    const el = collected(arg.id);
    if (!el) return { ok: false, errorKey: 'voice.pageGone' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    // The body is approved as the body it was: a child that has the focus
    // now is another element, and it does not inherit the approval.
    if (el.tagName === 'BODY') {
      if (active !== el) return { ok: false, errorKey: 'voice.pageFocusLost' };
      return { ok: true, body: true, writable: false, secret: false, documentId: documentId() };
    }
    // The focus is approved for one element: a field that has the focus now
    // is another element, and it does not inherit the approval, not even when
    // it is a child of the element that was approved.
    if (active !== el) return { ok: false, errorKey: 'voice.pageFocusLost' };
    const label = labelOf(active);
    return { ok: true, body: false, writable: writable(active), secret: isSecret(active, label), label, documentId: documentId() };
  }

  // The value of the element the user approved. This is the only way a value
  // leaves the page, and the worker only asks for it after the approval of
  // that one read.
  if (kind === 'read') {
    const el = arg?.id ? collected(arg.id) : null;
    if (!el) return { ok: false, errorKey: 'voice.pageGone' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    if (!sameIdentity(el, arg?.expected ?? null)) return { ok: false, errorKey: 'voice.pageGone' };
    // Only a field that can be written to is read: the page marker is never a
    // fallback, and the body is never read.
    if (!canWrite(el)) return { ok: false, errorKey: 'voice.pageNoField' };
    const value = 'value' in el && typeof el.value === 'string'
      ? el.value
      : (el.isContentEditable ? String(el.textContent ?? '') : '');
    return { ok: true, value, tag: String(el.tagName ?? '').toLowerCase(), secret: isSecret(el, labelOf(el)) };
  }

  if (kind !== 'collect') return { ok: false, errorKey: 'voice.pageGone' };

  const purpose = arg?.purpose === 'type' || arg?.purpose === 'read' ? 'type' : 'click';
  const SEL = purpose === 'type'
    ? 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], [role=searchbox], [role=combobox]'
    : 'a[href], button, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [onclick]';
  const vh = window.innerHeight, vw = window.innerWidth;

  const out = [];
  let n = 0;
  // The marks of an earlier collection are cleared first, so a number always
  // names the element this collection found.
  document.querySelectorAll('[data-voice-id]').forEach((el) => el.removeAttribute('data-voice-id'));
  const reg = registry();
  if (reg) reg.clear();
  for (const el of document.querySelectorAll(SEL)) {
    const label = labelOf(el);
    const secret = isSecret(el, label);
    // A field that cannot be written to cannot take the text: it is not a
    // candidate for it, and it is not a candidate for a read either.
    if (purpose === 'type' && !writable(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.disabled || el.getAttribute?.('aria-hidden') === 'true') continue;
    if (!label && purpose !== 'type') continue;
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    // Matching addresses do not imply matching actions: each DOM element
    // keeps its own candidate, label and approved identity.
    const id = mark(el, ++n);
    const item = {
      id,
      kind: kindOf(el),
      label: label || '(unlabeled field)',
      // The label the element really has. The label above is what the model
      // reads: it may be a fallback or a merged one, and it never changes the
      // identity of the element that was collected.
      identityLabel: label,
      href,
      inView,
      top: Math.round(r.top + window.scrollY),
      left: Math.round(r.left),
      // A field that holds a secret is named, never described by its value:
      // the user has to be able to say which field they mean.
      secret,
      // The field that has the focus is marked, so the model can tell it from
      // the others without the command having to name it.
      focused: el === deepActive(),
    };
    out.push(item);
  }
  const cap = purpose === 'type' ? 40 : 110;
  const visible = out.filter((e) => e.inView);
  const rest = out.filter((e) => !e.inView)
    .sort((a, b) => Math.abs(a.top - window.scrollY) - Math.abs(b.top - window.scrollY))
    .slice(0, Math.max(0, cap - visible.length));
  return visible.concat(rest).slice(0, cap).sort((a, b) => a.top - b.top || a.left - b.left);
}

export async function mediaControl(kind, documentId = null) {
  if (documentId && String(performance.timeOrigin) !== documentId) return { ok: false, errorKey: 'voice.pageGone' };
  const media = [...document.querySelectorAll('video, audio')];
  if (!media.length) return { ok: false, errorKey: 'voice.pageNoMedia' };
  const m = media.find((x) => !x.paused) ||
    media.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (kind === 'toggle') {
    if (m.paused) {
      // The browser may refuse to play: the failure is the page's, and it is
      // reported instead of a success that never happened.
      try {
        await m.play();
      } catch {
        return { ok: false, errorKey: 'voice.pageMediaFailed' };
      }
      return { ok: true, state: 'playing' };
    }
    m.pause();
    return { ok: true, state: 'paused' };
  }
  m.muted = !m.muted;
  return { ok: true, state: m.muted ? 'muted' : 'unmuted' };
}

export function scrollPage(kind, documentId = null) {
  if (documentId && String(performance.timeOrigin) !== documentId) return { ok: false, errorKey: 'voice.pageGone' };
  const h = window.innerHeight * 0.8;
  let target = document.scrollingElement;
  if (target.scrollHeight <= target.clientHeight + 5) {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        if (!best || el.clientWidth * el.clientHeight > best.clientWidth * best.clientHeight) best = el;
      }
    }
    if (best) target = best;
  }
  const opts = { behavior: 'smooth' };
  if (kind === 'down') target.scrollBy({ top: h, ...opts });
  else if (kind === 'up') target.scrollBy({ top: -h, ...opts });
  else if (kind === 'top') target.scrollTo({ top: 0, ...opts });
  else if (kind === 'bottom') target.scrollTo({ top: target.scrollHeight, ...opts });
  return { ok: true };
}

export function findText(text, documentId = null) {
  if (documentId && String(performance.timeOrigin) !== documentId) return { ok: false, errorKey: 'voice.pageGone' };
  window.getSelection().removeAllRanges();
  const found = window.find(text, false, false, true, false, false, false);
  if (found) {
    const sel = window.getSelection();
    if (sel.rangeCount) sel.getRangeAt(0).startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return { ok: found, errorKey: found ? null : 'voice.pageNotFound', errorParams: { text } };
}
