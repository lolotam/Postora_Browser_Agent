import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual panel send functions with a mocked port boundary. This
// verifies returned promises and session/cancellation behavior, not source text.
const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
const send = source.slice(source.indexOf('async function send('), source.indexOf('\nfunction onEvent('));
const composer = source.slice(source.indexOf('function submitComposer('), source.indexOf("\n$('composer').addEventListener"));
const voiceMessage = source.slice(source.indexOf('function sendVoiceMessage('), source.indexOf("\n$('composer').addEventListener"));
const voiceCommand = source.slice(source.indexOf('async function runVoiceCommand('), source.indexOf('\n/** The fast layer runs the command itself'));
const connectSource = source.slice(source.indexOf('function connect('), source.indexOf('\n// Picking the session'));

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

/** The panel's own voice command, with the port and the settings mocked. */
function voicePanel({ question = null, engine = 'postora' } = {}) {
  const posted = [];
  const elements = new Map();
  const context = vm.createContext({
    Promise, DOMException,
    ui: { running: false, question },
    settings: { voiceEngine: engine },
    sessionId: 'session-a',
    voiceTask: null,
    t: (key) => key,
    voiceTarget: async () => ({ id: 5, windowId: 1, url: 'https://example.test/', title: 'Example' }),
    finishVoiceTask: () => {},
    runFastVoiceCommand: async () => {},
    send: (message) => { posted.push(message); return Promise.resolve(); },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    },
  });
  vm.runInContext(`${voiceMessage}\n${voiceCommand}`, context);
  return { context, posted };
}

const entry = { setErr() {}, setOk() {}, addNote() {} };

test('a voice command is a message of its own: the files and the draft are left alone', async () => {
  const { context, posted } = voicePanel();
  context.runVoiceCommand('scroll down', { signal: new AbortController().signal, entry });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    type: 'run',
    text: 'scroll down',
    display: 'scroll down',
    images: [],
    tabId: 5,
  }], 'the message carries the voice text and nothing else');
});

test('a voice command is sent even when a file of the composer is still being read', async () => {
  const { context, posted } = voicePanel();
  context.runVoiceCommand('scroll down', { signal: new AbortController().signal, entry });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(posted.length, 1, 'the voice command is not held back by the composer');
  assert.equal(posted[0].type, 'run');
});

test('a voice command answers the question that is waiting, and the question stays in the chat', async () => {
  const { context, posted } = voicePanel({ question: 'Which one do you mean?' });
  context.runVoiceCommand('the first one', { signal: new AbortController().signal, entry });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    type: 'answer',
    text: 'the first one',
    display: 'the first one',
    images: [],
  }], 'the answer carries the voice text and nothing else');
});

test('a voice command that was cancelled never reaches the port', async () => {
  const { context, posted } = voicePanel();
  const controller = new AbortController();
  controller.abort();
  context.runVoiceCommand('scroll down', { signal: controller.signal, entry });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(posted, []);
});

test('the port carries the panel, so the worker can give its tabs back', () => {
  const names = [];
  const context = vm.createContext({
    Promise, DOMException,
    sessionId: 'session-a',
    voicePanelId: 'panel-a',
    reconnected: false,
    t: (key) => key,
    cancelVoiceTask() {},
    releaseVoiceClaims() {},
    refreshAuthStates() {},
    onEvent() {},
    chrome: { runtime: { connect: ({ name }) => { names.push(name); return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } } },
  });
  vm.runInContext(connectSource, context);
  context.connect();

  assert.deepEqual(names, ['panel:session-a:panel-a']);
});
