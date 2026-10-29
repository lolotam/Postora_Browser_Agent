// The settings panel's API keys, one per provider (see lib/keys.js). Every key
// field edits its provider's key, the other fields showing that provider follow
// as the user types, and a field switched to another provider shows that one's key.
// A key that is already there is not shown in the box: the box is replaced by a
// green line with the key hidden and its last characters, and Sign out clears it.

import { keyGroup } from '../lib/keys.js';
import { t } from './i18n.js';

/** A saved key as the field shows it: hidden, with the last four characters. */
export function maskKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const tail = text.length > 4 ? text.slice(-4) : '';
  return `${'•'.repeat(8)}${tail}`;
}

/**
 * Whether a key field is locked. It locks when it holds a key and the user is
 * not typing in it; Sign out is what empties it.
 */
export function keyFieldState(value, editing) {
  const text = String(value ?? '').trim();
  if (!text || editing) return { locked: false, mask: '' };
  return { locked: true, mask: maskKey(text) };
}

export function createKeyStore() {
  let values = {};
  const fields = []; // { input, provider: () => provider id }
  const listeners = new Set();

  function paint(input) {
    input.paintKey?.();
  }

  function set(provider, value, source) {
    const group = keyGroup(provider);
    if (!group) return;
    const changed = (values[group] ?? '') !== value;
    if (value) values[group] = value;
    else delete values[group];
    for (const field of fields) {
      if (field.input !== source && keyGroup(field.provider()) === group) {
        field.input.value = value;
        paint(field.input);
      }
    }
    if (changed) for (const listener of listeners) listener(group, value);
  }

  // The saved line is built once, and only for a real field. Tests pass plain objects.
  function decorate(input, provider) {
    if (input.dataset?.keyDecorated || typeof input.closest !== 'function') return;
    input.dataset.keyDecorated = '1';
    const saved = document.createElement('span');
    saved.className = 'key-saved';
    saved.hidden = true;
    const mask = document.createElement('span');
    mask.className = 'key-mask';
    mask.dir = 'ltr';
    const mark = document.createElement('span');
    mark.className = 'key-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '✓';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost key-clear';
    button.dataset.i18n = 'auth.logout';
    button.textContent = t('auth.logout');
    saved.append(mask, mark, button);
    input.insertAdjacentElement('afterend', saved);

    input.paintKey = () => {
      const state = keyFieldState(input.value, document.activeElement === input);
      input.hidden = state.locked;
      saved.hidden = !state.locked;
      mask.textContent = state.mask;
    };
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      set(provider(), '', input);
      input.hidden = false;
      saved.hidden = true;
      mask.textContent = '';
      input.focus();
    });
    input.addEventListener('blur', () => input.paintKey());
  }

  return {
    load(keys = {}) {
      values = { ...keys };
    },
    snapshot: () => ({ ...values }),
    /** Shared-key edits (including Sign out), after every matching input is updated. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register(input, provider) {
      fields.push({ input, provider });
      decorate(input, provider);
      input.addEventListener('input', () => set(provider(), input.value.trim(), input));
    },
    /** Shows the provider's key; a provider whose key is not shared shows `own`. */
    show(input, provider, own = '') {
      const group = keyGroup(provider);
      input.value = group ? values[group] ?? '' : own;
      paint(input);
    },
    /** Draws the saved line for a value put straight into the field. */
    refresh(input) {
      paint(input);
    },
  };
}
