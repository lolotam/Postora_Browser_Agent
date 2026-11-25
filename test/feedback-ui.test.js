import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackUi } from '../src/sidepanel/feedback-ui.js';

function fakeElement(tag = 'div', id = '') {
  const listeners = new Map();
  const classSet = new Set();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    textContent: '',
    value: '',
    hidden: tag === 'menu',
    parentNode: null,
    children,
    classList: {
      toggle(cls, force) {
        if (force) classSet.add(cls);
        else classSet.delete(cls);
      },
      contains(cls) {
        return classSet.has(cls);
      },
    },
    setAttribute(name, val) {
      this[name] = val;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    click() {
      return listeners.get('click')?.({ target: el });
    },
    append(...nodes) {
      for (const n of nodes) {
        n.parentNode = el;
        children.push(n);
      }
    },
    replaceChildren(...nodes) {
      children.length = 0;
      el.append(...nodes);
    },
    replaceWith(replacement) {
      if (this.id && MapRef.current) MapRef.current.set(this.id, replacement);
    },
    querySelectorAll(sel) {
      if (sel === '.star') return children;
      return [];
    },
    contains(target) {
      return target === el || children.includes(target);
    },
    remove() {
      this.removed = true;
    },
    focus() {
      this.focused = true;
    },
  };
  return el;
}

const MapRef = { current: null };

function createFixture({ formId = 'form-1', send = async () => {} } = {}) {
  const elements = new Map([
    ['feedbackMenu', Object.assign(fakeElement('div', 'feedbackMenu'), { hidden: true })],
    ['feedbackStars', fakeElement('div', 'feedbackStars')],
    ['feedbackStatus', fakeElement('small', 'feedbackStatus')],
    ['feedbackEmail', fakeElement('input', 'feedbackEmail')],
    ['feedbackText', fakeElement('textarea', 'feedbackText')],
    ['feedbackBtn', fakeElement('button', 'feedbackBtn')],
    ['feedbackSend', fakeElement('button', 'feedbackSend')],
  ]);
  MapRef.current = elements;
  const docListeners = new Map();
  const doc = {
    createElement: (tag) => fakeElement(tag),
    addEventListener: (type, fn) => docListeners.set(type, fn),
  };
  const storage = {};
  const chrome = {
    runtime: {
      id: 'ext-123',
      getManifest: () => ({ version: '0.4.17', update_url: 'https://clients2.google.com/service/update2/crx' }),
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (obj) => Object.assign(storage, obj),
      },
    },
  };
  const cards = [];
  let closedOthers = 0;
  const ui = createFeedbackUi({
    $: (id) => elements.get(id),
    document: doc,
    chrome,
    t: (key, vars) => (vars?.n ? `${key}:${vars.n}` : key),
    currentLanguage: () => 'en',
    getAccount: () => ({ email: 'owner@example.com' }),
    addCard: (cls, text) => {
      const card = Object.assign(fakeElement('div'), { className: cls, textContent: text });
      cards.push(card);
      return card;
    },
    closeIconButton: (label, onClick) => {
      const btn = fakeElement('button');
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    },
    closeOtherMenus: () => {
      closedOthers += 1;
    },
    formId,
    send,
  });
  return { ui, elements, cards, storage, getClosedOthers: () => closedOthers };
}

test('toggleFeedbackMenu opens menu, closes other menus, and prefills account email', () => {
  const { elements, getClosedOthers } = createFixture();
  elements.get('feedbackBtn').click();
  assert.equal(elements.get('feedbackMenu').hidden, false);
  assert.equal(getClosedOthers(), 1);
  assert.equal(elements.get('feedbackEmail').value, 'owner@example.com');
  assert.equal(elements.get('feedbackText').focused, true);
});

test('submitFeedback validates empty payload and sends feedback with account email fallback', async () => {
  const sent = [];
  const { ui } = createFixture({
    send: async (payload) => {
      sent.push(payload);
    },
  });
  const status = fakeElement('small');
  let finished = false;

  await ui.submitFeedback({ message: '', rating: 0 }, status, () => {
    finished = true;
  });
  assert.equal(status.textContent, 'feedback.empty');
  assert.equal(finished, false);

  await ui.submitFeedback({ message: 'Great voice mode', rating: 4 }, status, () => {
    finished = true;
  });
  assert.equal(finished, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, 'Great voice mode');
  assert.equal(sent[0].rating, 4);
  assert.equal(sent[0].email, 'owner@example.com');
});

test('askForRating renders rating card and records 5-star rating state', async () => {
  const { ui, cards, storage } = createFixture();
  await ui.askForRating();
  assert.equal(cards.length, 1);
  const starContainer = cards[0].children[1];
  await starContainer.children[4].click();
  assert.equal(storage.reviewPrompt?.rated, true);
});
