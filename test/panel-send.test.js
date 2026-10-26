import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual panel send functions with a mocked port boundary. This
// verifies returned promises and session/cancellation behavior, not source text.
const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
const send = source.slice(source.indexOf('async function send('), source.indexOf('\nfunction onEvent('));
const composer = source.slice(source.indexOf('function submitComposer('), source.indexOf("\n$('composer').addEventListener"));

function panel({ postMessage = () => {}, picking = null } = {}) {
  const elements = new Map();
  const context = vm.createContext({
    Promise, DOMException,
    picking, sessionId: 'original', port: { postMessage },
    attachments: [], settings: {}, ui: { running: false, question: null },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    t: (key) => key, renderFiles() {}, connect() {}, showTabSession: async () => {},
    packFiles: (text) => ({ task: text, display: text, images: [] }),
  });
  vm.runInContext(`${send}\n${composer}`, context);
  return context;
}

test('composer submission returns the real send failure instead of claiming success', async () => {
  const app = panel({ postMessage: () => { throw new Error('port disconnected'); } });
  await assert.rejects(app.submitComposer('voice task'), /port disconnected/);
});

test('a voice submission cancelled while picking a session never reaches the port', async () => {
  let done;
  const picking = new Promise((resolve) => { done = resolve; });
  const posted = [];
  const app = panel({ picking, postMessage: (message) => posted.push(message) });
  const abort = new AbortController();
  const pending = app.submitComposer('voice task', { signal: abort.signal });
  abort.abort();
  app.picking = null;
  done();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(posted, []);
});

test('a voice submission cannot cross into a newly selected session', async () => {
  let done;
  const picking = new Promise((resolve) => { done = resolve; });
  const posted = [];
  const app = panel({ picking, postMessage: (message) => posted.push(message) });
  const pending = app.submitComposer('voice task', { expectedSessionId: 'original' });
  app.sessionId = 'different';
  app.picking = null;
  done();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(posted, []);
});
