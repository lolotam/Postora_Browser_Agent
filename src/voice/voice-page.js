// Functions injected into web pages with chrome.scripting.executeScript.
//
// One function does everything that has to know about secrets, so the rule is
// written once: page scripts cannot share module scope, and several copies of
// the same check drift apart. The rule itself comes in as an argument (see
// voice-safety.js), so the page and the module always agree.
//
// The page is only read here. A click, a keystroke and Enter are real input
// through the debugger, never a fake event a site could tell from a user's.
//
// A field that holds a secret (a password box, a card number, a one-time
// code) is never described, never read and never written to: it does not
// reach the model, and nothing is typed into it. Its own value is never used
// as a label either, so a typed password cannot travel out with the page.
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
 *   - 'collect' with `{ purpose: 'click' | 'type' }` lists the elements of the
 *     page, with the label the model may read;
 *   - 'focused' says what has the focus, and names it (the body is named
 *     too, and never described: its text is the text of the page);
 *   - 'locate' with `{ id }` (or without one, for the focused element) says
 *     where an element is and whether it still holds a secret;
 *   - 'resolve' with `{ id, expected }` says whether the element the user
 *     approved is still the same element, and where it is now;
 *   - 'focus' with `{ id }` says whether the element the user approved still
 *     has the focus, and whether it still holds a secret.
 */
export function pageProbe(kind, arg, rule) {
  const tokens = rule?.tokens ?? [];
  const words = rule?.words ?? [];
  const fragments = rule?.fragments ?? [];

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

  const autocompleteTokens = (el) => String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);

  const isSecret = (el, label) => {
    if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') return true;
    if (autocompleteTokens(el).some((token) => token.startsWith('cc-') || tokens.includes(token))) return true;
    return secretName(el.getAttribute('id'), el.getAttribute('name'), el.getAttribute('aria-label'), label);
  };

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

  // A field the user writes into: its content is the user's own text.
  const isEditable = (el) => el.isContentEditable || el.tagName === 'TEXTAREA' ||
    ['textbox', 'searchbox', 'combobox'].includes(String(el.getAttribute('role') || '').toLowerCase());

  // The text of a node without the text of the field it labels: a draft never
  // becomes a label, and never becomes a word of a name either.
  const textWithout = (node, field) => {
    if (!node) return '';
    let out = '';
    for (const child of node.childNodes ?? []) {
      if (child === field) continue;
      if (child.nodeType === 1 && typeof child.contains === 'function' && child.contains(field)) continue;
      out += child.textContent ?? '';
    }
    return out;
  };

  // The label the model may read. An editable field never falls back to its
  // own text: what is in it is the user's, not a name.
  const labelOf = (el) => {
    const editable = isEditable(el);
    const own = (node) => clean(textWithout(node, el));
    let t = clean(el.getAttribute('aria-label'));
    if (!t && el.getAttribute('aria-labelledby')) {
      t = clean(el.getAttribute('aria-labelledby').split(/\s+/).map((id) => own(document.getElementById(id))).join(' '));
    }
    if (!t && el.labels && el.labels.length) {
      for (const label of el.labels) {
        t = own(label);
        if (t) break;
      }
    }
    if (!t && !editable) t = clean(el.innerText);
    if (!t) t = clean(el.getAttribute('title'));
    if (!t) t = clean(el.getAttribute('placeholder'));
    if (!t) { const img = el.querySelector('img[alt]'); if (img) t = clean(img.alt); }
    if (!t) t = clean(el.getAttribute('name') || el.id);
    return t.slice(0, 120);
  };

  const kindOf = (el) => {
    const role = el.getAttribute('role');
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

  if (kind === 'focused') {
    const el = document.activeElement;
    if (!el) return { editable: false, secret: false, id: null };
    // The body is an element like every other one: it is registered too, so
    // an approved Enter is tied to the body it was approved on and not to
    // whatever has the focus later. It is never described: its text is the
    // text of the page, and the page does not belong to the model.
    if (el === document.body) return { editable: false, secret: false, id: mark(el, 0) };
    const editable = isEditable(el) || (el.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden'].includes(el.type));
    // The label is the safe one: the text of an editable field is never used,
    // but the name beside it still says what the field is.
    const label = labelOf(el);
    // The element that has the focus is named, so the worker may check later
    // that the same element still has it.
    let id = null;
    if (registry()) id = mark(el, 0);
    return { editable, secret: isSecret(el, label), id, label };
  }

  if (kind === 'locate') {
    const el = arg?.id ? collected(arg.id) : document.activeElement;
    if (!el || el === document.body) return { ok: false, errorKey: 'voice.pageNoField' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    const label = labelOf(el);
    if (isSecret(el, label)) return { ok: false, errorKey: 'voice.pageSecret', secret: true };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) return { ok: false, errorKey: 'voice.pageGone' };
    return {
      ok: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      secret: false,
    };
  }

  // The element the user approved: is it still the same element, is it still
  // there, and is it still the one that is under the point that will be
  // clicked?
  if (kind === 'resolve') {
    const el = arg?.id ? collected(arg.id) : null;
    if (!el) return { ok: false, errorKey: 'voice.pageGone' };
    if (el.isConnected === false) return { ok: false, errorKey: 'voice.pageGone' };
    const label = labelOf(el);
    if (isSecret(el, label)) return { ok: false, errorKey: 'voice.pageSecret', secret: true };
    const expected = arg?.expected ?? null;
    if (expected) {
      const kindName = kindOf(el);
      if (expected.kind && kindName !== expected.kind) return { ok: false, errorKey: 'voice.pageGone' };
      // The label that is compared is the one the element really had when it
      // was collected: an empty label is a label too.
      if (expected.label != null && clean(expected.label) !== label) return { ok: false, errorKey: 'voice.pageGone' };
    }
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
      label,
      kind: kindOf(el),
      secret: false,
      focused: document.activeElement === el,
    };
  }

  // The focus the user approved: the same element still has it, and it does
  // not hold a secret.
  if (kind === 'focus') {
    const active = document.activeElement;
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
      return { ok: true, body: true };
    }
    if (!active || (active !== el && !(typeof el.contains === 'function' && el.contains(active)))) {
      return { ok: false, errorKey: 'voice.pageFocusLost' };
    }
    const label = labelOf(active);
    if (isSecret(active, label)) return { ok: false, errorKey: 'voice.pageSecret', secret: true };
    return { ok: true, body: false, label };
  }

  if (kind !== 'collect') return { ok: false, errorKey: 'voice.pageGone' };

  const purpose = arg?.purpose === 'type' ? 'type' : 'click';
  const SEL = purpose === 'type'
    ? 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], [role=searchbox], [role=combobox]'
    : 'a[href], button, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [onclick]';
  const vh = window.innerHeight, vw = window.innerWidth;

  const seen = new Map();
  const out = [];
  let n = 0;
  // The marks of an earlier collection are cleared first, so a number always
  // names the element this collection found.
  document.querySelectorAll('[data-voice-id]').forEach((el) => el.removeAttribute('data-voice-id'));
  const reg = registry();
  if (reg) reg.clear();
  for (const el of document.querySelectorAll(SEL)) {
    const label = labelOf(el);
    if (isSecret(el, label)) continue; // a secret field is left out entirely
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
    if (!label && purpose !== 'type') continue;
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const key = href ? 'h:' + href : null;
    if (key && seen.has(key)) {
      const prev = seen.get(key);
      // Only the label the model reads becomes the longer one: the identity
      // of the element that was collected keeps its own label.
      if (label.length > prev.label.length) prev.label = label;
      prev.inView = prev.inView || inView;
      continue;
    }
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
      secret: false,
      // The field that has the focus is marked, so the model can tell it from
      // the others without the command having to name it.
      focused: el === document.activeElement,
    };
    if (key) seen.set(key, item);
    out.push(item);
  }
  const cap = purpose === 'type' ? 40 : 110;
  const visible = out.filter((e) => e.inView);
  const rest = out.filter((e) => !e.inView)
    .sort((a, b) => Math.abs(a.top - window.scrollY) - Math.abs(b.top - window.scrollY))
    .slice(0, Math.max(0, cap - visible.length));
  return visible.concat(rest).slice(0, cap).sort((a, b) => a.top - b.top || a.left - b.left);
}

export async function mediaControl(kind) {
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

export function scrollPage(kind) {
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

export function findText(text) {
  window.getSelection().removeAllRanges();
  const found = window.find(text, false, false, true, false, false, false);
  if (found) {
    const sel = window.getSelection();
    if (sel.rangeCount) sel.getRangeAt(0).startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return { ok: found, errorKey: found ? null : 'voice.pageNotFound', errorParams: { text } };
}
