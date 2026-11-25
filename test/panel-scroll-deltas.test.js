import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { contentDirection } from '../src/sidepanel/content-direction.js';

const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');

const scrollSource = source.slice(
  source.indexOf('const STICK_THRESHOLD_PX ='),
  source.indexOf('\nlet attachments = [];'),
);

test('chat log includes a jump-to-latest chip button', () => {
  assert.match(html, /<button type="button" id="jumpLatestBtn" class="jump-latest" data-i18n="chat\.jumpLatest" hidden><\/button>/);
});

test('scrollDown only scrolls when stuck to the bottom and shows jumpLatestBtn when scrolled up', () => {
  const listeners = new Map();
  const messagesBox = {
    scrollTop: 500,
    scrollHeight: 500,
    clientHeight: 200,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const jumpBtn = {
    hidden: true,
    addEventListener: (name, fn) => listeners.set(`jump:${name}`, fn),
  };
  const context = vm.createContext({
    replaying: false,
    ui: {},
    contentDirection,
    threadTitle: () => '',
    threadPart: () => ({ textContent: '', dir: 'auto' }),
    $: (id) => (id === 'messages' ? messagesBox : id === 'jumpLatestBtn' ? jumpBtn : null),
  });
  vm.runInContext(scrollSource, context);

  // Simulate user scrolling up away from the bottom
  messagesBox.scrollTop = 100;
  messagesBox.scrollHeight = 600;
  listeners.get('scroll')();
  assert.equal(jumpBtn.hidden, false, 'jump chip appears when scrolled up');

  // New content arrives; scrollDown must not yank the scroll position
  messagesBox.scrollHeight = 800;
  context.scrollDown();
  assert.equal(messagesBox.scrollTop, 100, 'scrollTop is preserved while user reads above');
  assert.equal(jumpBtn.hidden, false);

  // Clicking jump chip forces scroll to bottom and hides chip
  listeners.get('jump:click')();
  assert.equal(messagesBox.scrollTop, 800);
  assert.equal(jumpBtn.hidden, true);
});

test('scheduleDeltaFlush batches reasoning and text deltas into a single animation frame update', () => {
  const frames = [];
  const messagesBox = { scrollTop: 0, scrollHeight: 400, clientHeight: 400, addEventListener() {} };
  const jumpBtn = { hidden: true, addEventListener() {} };
  const liveReasoning = { textContent: '', dir: 'auto' };
  const liveText = { textContent: '', dir: 'auto' };
  const thread = { reasoning: '', title: { textContent: '' } };
  let scrolls = 0;

  const context = vm.createContext({
    replaying: false,
    ui: { liveReasoning, liveText, thread },
    contentDirection,
    threadTitle: (th) => th.reasoning.slice(0, 20),
    threadPart: () => liveText,
    requestAnimationFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    $: (id) => (id === 'messages' ? messagesBox : id === 'jumpLatestBtn' ? jumpBtn : null),
  });
  vm.runInContext(scrollSource, context);
  const origScrollDown = context.scrollDown;
  context.scrollDown = (opts) => {
    scrolls += 1;
    return origScrollDown(opts);
  };

  vm.runInContext(`
    pendingReasoningDelta += 'First ';
    scheduleDeltaFlush();
    pendingReasoningDelta += 'thought.';
    scheduleDeltaFlush();
    pendingTextDelta += 'Hello ';
    scheduleDeltaFlush();
    pendingTextDelta += 'world!';
    scheduleDeltaFlush();
  `, context);

  assert.equal(frames.length, 1, 'only one rAF scheduled for multiple deltas');
  assert.equal(liveReasoning.textContent, '', 'DOM not mutated before frame fires');

  frames[0]();
  assert.equal(liveReasoning.textContent, 'First thought.');
  assert.equal(liveText.textContent, 'Hello world!');
  assert.equal(thread.reasoning, 'First thought.');
  assert.equal(scrolls, 1, 'scrolled once per frame');
});
