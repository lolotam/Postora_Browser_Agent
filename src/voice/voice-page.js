// Functions injected into web pages with chrome.scripting.executeScript.
// Each one is self-contained (no closures over module scope): the rules about
// secret fields come in as arguments.
//
// A field that holds a secret (a password box, a card number, a one-time
// code) is never described, never read and never written to: it does not
// reach the model, and nothing is typed into it. Its own value is never used
// as a label either, so a typed password cannot travel out with the page.
//
// The errors are message keys, not sentences: the panel translates them, so
// the same page works in the panel's language.

export function collectElements(purpose, secretTokens) {
  const SEL = purpose === 'type'
    ? 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], [role=searchbox], [role=combobox]'
    : 'a[href], button, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [onclick]';
  const vh = window.innerHeight, vw = window.innerWidth;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isSecret = (el) => {
    if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.some((token) => token.startsWith('cc-') || secretTokens.includes(token));
  };
  const labelOf = (el) => {
    let t = clean(el.getAttribute('aria-label'));
    if (!t && el.getAttribute('aria-labelledby')) {
      t = clean(el.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' '));
    }
    if (!t && el.labels && el.labels[0]) t = clean(el.labels[0].innerText);
    if (!t) t = clean(el.innerText);
    if (!t) t = clean(el.getAttribute('title'));
    if (!t) t = clean(el.getAttribute('placeholder'));
    // The field's own value is never a label: it may be a secret.
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

  const seen = new Map();
  const out = [];
  let n = 0;
  // The marks of an earlier collection are cleared first, so a number always
  // names the element this collection found.
  document.querySelectorAll('[data-voice-id]').forEach((el) => el.removeAttribute('data-voice-id'));
  for (const el of document.querySelectorAll(SEL)) {
    if (isSecret(el)) continue; // a secret field is left out entirely
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
    const label = labelOf(el);
    if (!label && purpose !== 'type') continue;
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const key = href ? 'h:' + href : null;
    if (key && seen.has(key)) {
      const prev = seen.get(key);
      if (label.length > prev.label.length) prev.label = label;
      prev.inView = prev.inView || inView;
      continue;
    }
    const id = String(++n);
    el.setAttribute('data-voice-id', id);
    const item = { id, kind: kindOf(el), label: label || '(unlabeled field)', href, inView, top: Math.round(r.top + window.scrollY), left: Math.round(r.left), secret: false };
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

export function clickElement(id, secretTokens) {
  const el = document.querySelector(`[data-voice-id="${id}"]`);
  if (!el) return { ok: false, errorKey: 'voice.pageGone' };
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const secret = (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
    || tokens.some((token) => token.startsWith('cc-') || secretTokens.includes(token));
  if (secret) return { ok: false, errorKey: 'voice.pageSecret' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const prev = el.style.outline;
  el.style.outline = '3px solid #4ff7d1';
  setTimeout(() => { el.style.outline = prev; }, 900);
  if (el.tagName === 'SELECT') { el.focus(); el.showPicker?.(); return { ok: true }; }
  el.focus({ preventScroll: true });
  el.click();
  return { ok: true };
}

/** What the focused element is: a field to write into, and whether it is a secret. */
export function focusedIsEditable(secretTokens) {
  const el = document.activeElement;
  if (!el || el === document.body) return { editable: false, secret: false };
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const secret = (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
    || tokens.some((token) => token.startsWith('cc-') || secretTokens.includes(token));
  const editable = el.isContentEditable || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'image', 'file', 'range', 'color', 'hidden'].includes(el.type));
  return { editable, secret };
}

export function typeInto(id, text, submit, secretTokens) {
  const el = id ? document.querySelector(`[data-voice-id="${id}"]`) : document.activeElement;
  if (!el || el === document.body) return { ok: false, errorKey: 'voice.pageNoField' };
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const secret = (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
    || tokens.some((token) => token.startsWith('cc-') || secretTokens.includes(token));
  if (secret) return { ok: false, errorKey: 'voice.pageSecret' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  if (el.select) el.select(); else document.execCommand('selectAll', false);
  document.execCommand('insertText', false, text);
  const current = el.isContentEditable ? el.innerText.trim() : el.value;
  if (current !== text && !el.isContentEditable) {
    let proto = Object.getPrototypeOf(el), desc;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    desc?.set ? desc.set.call(el, text) : (el.value = text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const prev = el.style.outline;
  el.style.outline = '3px solid #4ff7d1';
  setTimeout(() => { el.style.outline = prev; }, 900);
  if (submit) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (notCancelled && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  }
  return { ok: true };
}

export function pressEnter(secretTokens) {
  const el = document.activeElement || document.body;
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const secret = (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
    || tokens.some((token) => token.startsWith('cc-') || secretTokens.includes(token));
  if (secret) return { ok: false, errorKey: 'voice.pageSecret' };
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  if (notCancelled && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  return { ok: true };
}

export function scrollPage(kind) {
  const h = window.innerHeight * 0.8;
  let target = document.scrollingElement;
  if (target.scrollHeight <= target.clientHeight + 5) {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
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

export function mediaControl(kind) {
  const media = [...document.querySelectorAll('video, audio')];
  if (!media.length) return { ok: false, errorKey: 'voice.pageNoMedia' };
  const m = media.find((x) => !x.paused) ||
    media.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (kind === 'toggle') {
    if (m.paused) { m.play(); return { ok: true, state: 'playing' }; }
    m.pause(); return { ok: true, state: 'paused' };
  }
  m.muted = !m.muted;
  return { ok: true, state: m.muted ? 'muted' : 'unmuted' };
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
