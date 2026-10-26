import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { heardText, MIC_PANEL, MIC_WINDOW, speechLang, voiceErrorKey } from '../src/sidepanel/voice.js';

// Run the actual microphone page with a small browser boundary. No recognizer
// or relay logic is duplicated in the test.
const source = fs.readFileSync(new URL('../src/sidepanel/mic.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');

function microphone() {
  const messages = [];
  const created = [];
  const opened = [];
  const scheduled = [];
  let relay;
  let pagehide;
  let click;
  let closes = 0;
  const elements = {
    allow: { addEventListener: (_name, handler) => { click = handler; } },
    live: {},
  };
  class Recognition {
    constructor() { created.push(this); }
    start() { this.onstart?.(); }
    abort() { this.onend?.(); }
    stop() { this.onend?.(); }
    final(text) {
      this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    }
  }
  const location = { search: '?epoch=42&continuous=1', href: 'chrome-extension://test/src/sidepanel/mic.html?epoch=42&continuous=1' };
  vm.runInNewContext(source, {
    heardText, MIC_PANEL, MIC_WINDOW, speechLang, voiceErrorKey,
    setLanguage() {}, t: (key) => key,
    URL, URLSearchParams, location,
    document: { getElementById: (id) => elements[id] },
    navigator: { permissions: { query: async () => ({ state: 'prompt' }) } },
    setTimeout: (fn) => { scheduled.push(fn); return scheduled.length; },
    window: {
      SpeechRecognition: Recognition,
      close: () => { closes += 1; pagehide?.(); },
      addEventListener: (_name, handler) => { pagehide = handler; },
    },
    chrome: {
      runtime: {
        sendMessage: async (message) => { messages.push(message); },
        onMessage: { addListener: (handler) => { relay = handler; } },
      },
      tabs: { create: async (tab) => { opened.push(tab); } },
    },
  });
  return {
    messages, created, opened, scheduled,
    start: () => click(),
    relay: (kind, epoch = 42) => relay({ source: MIC_PANEL, kind, epoch }),
    closes: () => closes,
  };
}

test('microphone pause and replacement retire late results from the old capture', () => {
  const mic = microphone();
  mic.start();
  const old = mic.created[0];
  mic.relay('pause');
  old.final('speaker feedback during pause');
  mic.relay('resume');
  assert.equal(mic.created.length, 2);
  old.final('late feedback after resume');
  mic.created[1].final('real command');
  assert.deepEqual(mic.messages.filter((m) => m.kind === 'final').map((m) => m.text), ['real command']);
  mic.relay('cancel');
});

test('a permission popup moving into a tab does not finish the new capture', async () => {
  const mic = microphone();
  mic.start();
  const rec = mic.created[0];
  rec.onerror({ error: 'not-allowed' });
  rec.onend(); // Chrome ends capture before the asynchronous permission lookup finishes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mic.opened.length, 1);
  assert.ok(mic.opened[0].url.includes('tab=1'));
  assert.ok(mic.opened[0].url.includes('epoch=42'));
  assert.deepEqual(mic.messages.filter((m) => ['moved', 'ended', 'end'].includes(m.kind)).map((m) => m.kind), ['moved']);
  assert.equal(mic.closes(), 1, 'only the obsolete popup closes');
});

test('a different microphone epoch cannot pause, cancel or restart this window', () => {
  const mic = microphone();
  mic.start();
  mic.relay('pause', 99);
  mic.created[0].final('still listening');
  mic.relay('cancel', 99);
  mic.relay('resume', 99);
  assert.equal(mic.closes(), 0);
  assert.equal(mic.created.length, 1);
  assert.equal(mic.messages.some((m) => m.kind === 'final' && m.text === 'still listening'), true);
  mic.relay('cancel');
});
