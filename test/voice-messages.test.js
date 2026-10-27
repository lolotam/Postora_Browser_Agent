import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../src/sidepanel/messages.js';
import { t } from '../src/sidepanel/i18n.js';
import { runFastCommand } from '../src/voice/voice-runner.js';

// Every word the voice path says exists in every language, and none of them
// reaches the user as a key.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'src/voice/voice-runner.js',
  'src/voice/voice-approval.js',
  'src/voice/voice-controller.js',
  'src/voice/voice-browser.js',
  'src/voice/voice-safety.js',
  'src/voice/voice-page.js',
  'src/background/service-worker.js',
  'src/sidepanel/panel.js',
];

// The words the code builds at runtime, and the words they stand for.
const BUILT = {
  'voice.sayMedia${res.state[0].toUpperCase()}${res.state.slice(1)}': ['voice.sayMediaPlaying', 'voice.sayMediaPaused', 'voice.sayMediaMuted', 'voice.sayMediaUnmuted'],
  'voice.state${state.charAt(0).toUpperCase()}${state.slice(1)}': ['voice.stateIdle', 'voice.stateListening', 'voice.stateThinking', 'voice.stateSpeaking'],
};

// The one word that is an error code and not a message: the browser names the
// page it cannot work on with it.
const CODES = new Set(['voice.pageRestricted', 'voice.claimLost', 'voice.inputUnknown', 'voice.inputCancelled']);

function literals() {
  const keys = new Set();
  for (const file of SOURCES) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/['"`](voice\.[A-Za-z0-9]+)['"`]/g)) {
      if (!CODES.has(match[1])) keys.add(match[1]);
    }
    for (const match of source.matchAll(/`(voice\.[A-Za-z0-9]*\$\{[^`]*?)`/g)) {
      const built = BUILT[match[1]];
      if (built) built.forEach((key) => keys.add(key));
    }
  }
  return [...keys];
}

test('every voice word the code uses is translated in every language', () => {
  const keys = literals();
  assert.ok(keys.length > 40, 'the scan found the words of the voice path');
  for (const language of Object.keys(MESSAGES)) {
    const missing = keys.filter((key) => !(key in MESSAGES[language]));
    assert.deepEqual(missing, [], `${language} is missing a translation`);
  }
});

test('the words the voice path needs are there in both languages', () => {
  for (const key of ['voice.sayClicked', 'voice.sayTheTab', 'voice.sayTabGone', 'voice.pageMediaFailed']) {
    for (const language of Object.keys(MESSAGES)) {
      assert.ok(key in MESSAGES[language], `${language} is missing ${key}`);
      assert.ok(MESSAGES[language][key].trim().length > 0, `${language} has an empty ${key}`);
    }
  }
});

test('no voice word is a key in the words the panel speaks', () => {
  for (const language of Object.keys(MESSAGES)) {
    for (const [key, text] of Object.entries(MESSAGES[language])) {
      if (!key.startsWith('voice.')) continue;
      assert.notEqual(text, key, `${key} is not translated`);
    }
  }
});

/** The runner with a browser that does nothing, so the words can be read. */
function runner(browser, command, action, extra = {}) {
  const choice = (picked) => ({ type: 'choice', choice: picked, confidence: 0.9, probabilities: { [picked]: 0.95 } });
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        const wanted = keys.includes(action) ? action : (keys.find((key) => key !== 'none') ?? 'none');
        answers[name] = choice(wanted);
      } else {
        answers[name] = { type: 'noul', noul: 0.9 };
      }
    }
    return { answers, model: 'mock' };
  };
  return runFastCommand({ ask, browser, command, approve: async () => true, t, ...extra });
}

const BROWSER = {
  async currentTab() { return { id: 1, windowId: 7, url: 'https://example.test/', title: 'Example', active: true }; },
  async tabsInWindow() { return [{ id: 1, windowId: 7, url: 'https://example.test/', title: 'Example', active: true }]; },
  async getTab() { return { id: 1, windowId: 7, url: 'https://example.test/', title: 'Example', active: true }; },
  async inject(tabId, func, args = []) {
    if (func.name === 'pageProbe') {
      if (args[0] === 'collect') return [{ id: '1', kind: 'button', label: 'Go', href: null, inView: true, top: 0, left: 0, secret: false }];
      if (args[0] === 'focused') return { editable: false, secret: false };
      return { ok: true, x: 1, y: 2 };
    }
    if (func.name === 'mediaControl') return { ok: true, state: 'playing' };
    return { ok: true };
  },
  async input() { return { ok: true }; },
  async waitForLoad() {},
  async ownerOf() { return null; },
  async claim() { return { ok: true }; },
  async release() {},
  async updateTab() {},
  async getZoom() { return 1; },
  async setZoom() {},
  async removeTab() {},
  async bindSession() { return { ok: true }; },
  async activateTab() {},
  async openTab() { return { id: 2, windowId: 7, url: '', title: '' }; },
  async goBack() {},
  async goForward() {},
  async reload() {},
};

test('the words the runner says are sentences, not keys', async () => {
  const commands = [
    ['click go', 'click'],
    ['type hello', 'type_text'],
    ['press enter', 'press_enter'],
    ['scroll down', 'scroll_down'],
    ['zoom in', 'zoom_in'],
    ['play the video', 'media_play_pause'],
    ['find cats', 'find_on_page'],
    ['close this tab', 'close_tab'],
    ['stop listening', 'stop_listening'],
  ];
  for (const [command, action] of commands) {
    const result = await runner(BROWSER, command, action);
    assert.ok(result.say, `${command} says something`);
    assert.doesNotMatch(result.say, /^voice\./, `${command} says a key: ${result.say}`);
    assert.doesNotMatch(result.say, /\{/, `${command} says a placeholder: ${result.say}`);
    assert.ok(result.say.length > 3, `${command} says a sentence: ${result.say}`);
  }
});
