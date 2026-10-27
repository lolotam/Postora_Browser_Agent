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
const fastCommand = source.slice(source.indexOf('async function runFastVoiceCommand('), source.indexOf("\n/** The name of a step, in the panel"));
const questionSource = source.slice(source.indexOf('function showPendingQuestion('), source.indexOf('\nfunction setRunning('));
const finishTaskSource = source.slice(source.indexOf('function finishVoiceTask('), source.indexOf('\nfunction cancelVoiceTask('));
const connectSource = source.slice(source.indexOf('function connect('), source.indexOf('\n// Picking the session'));

function panel({ postMessage = () => {}, picking = null } = {}) {
  const elements = new Map();
  const context = vm.createContext({
    Promise, DOMException,
    picking, sessionId: 'original', port: { postMessage },
    attachments: [], settings: {}, ui: { running: false, question: null, questionId: 0 },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    },
    t: (key) => key, renderFiles() {}, connect() {}, showTabSession: async () => {},
    packFiles: (text) => ({ task: text, display: text, images: [] }),
  });
  vm.runInContext(`${send}\n${composer}\n${questionSource}`, context);
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
    ui: { running: false, question, questionId: question ? 1 : 0 },
    settings: { voiceEngine: engine },
    sessionId: 'session-a',
    voiceTask: null,
    t: (key) => key,
    voiceTarget: async () => ({ id: 5, windowId: 1, url: 'https://example.test/', title: 'Example' }),
    runFastVoiceCommand: async () => {},
    send: (message) => { posted.push(message); return Promise.resolve(); },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    },
  });
  vm.runInContext(`${voiceMessage}\n${voiceCommand}\n${questionSource}\n${finishTaskSource}`, context);
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

test('a voice command that was cancelled finishes its task', async () => {
  const { context } = voicePanel();
  const controller = new AbortController();
  controller.abort();
  context.runVoiceCommand('scroll down', { signal: controller.signal, entry });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(context.voiceTask, null, 'the task does not keep the screen busy for ever');
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

test('the question that was answered is cleared only after the answer went out', async () => {
  const sent = [];
  const app = panel({ postMessage: (message) => sent.push(message) });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  const pending = app.sendVoiceMessage('the first one');
  assert.equal(app.ui.question, 'Which one do you mean?', 'the question waits until the answer is delivered');
  await pending;

  assert.equal(app.ui.question, null, 'the question is cleared once the answer went out');
  assert.equal(app.$('voicePending').hidden, true, 'the pending card is hidden too');
  assert.equal(sent[0].type, 'answer');
});

test('a question that could not be answered stays', async () => {
  const app = panel({ postMessage: () => { throw new Error('port disconnected'); } });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  await assert.rejects(app.sendVoiceMessage('the first one'), /port disconnected/);

  assert.equal(app.ui.question, 'Which one do you mean?', 'the question is still waiting for an answer');
  assert.equal(app.$('voicePending').hidden, false, 'the pending card is still shown');
});

test('a question that arrived while the answer was on its way is not cleared', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = panel({ postMessage: () => gate });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  const pending = app.sendVoiceMessage('the first one');
  // A newer question arrives while the answer is still on its way.
  app.ui.question = 'And now, which one?';
  app.ui.questionId = 2;
  release();
  await pending;

  assert.equal(app.ui.question, 'And now, which one?', 'the newer question is still waiting');
  assert.equal(app.$('voicePending').hidden, false, 'the pending card is still shown');
});

test('a newer question keeps the button and the hint of a question that waits', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = panel({ postMessage: () => gate });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  const pending = app.sendVoiceMessage('the first one');
  // A newer question arrives while the answer is still on its way. It shows
  // its own controls: the hint that says that an answer is waited for, and
  // the button to answer it.
  app.ui.question = 'And now, which one?';
  app.ui.questionId = 2;
  app.$('hint').textContent = 'status.waiting';
  app.$('sendBtn').hidden = false;
  release();
  await pending;

  assert.equal(app.$('hint').textContent, 'status.waiting', 'the hint of the newer question is kept');
  assert.equal(app.$('sendBtn').hidden, false, 'the button of the newer question is kept');
});

test('a question that was answered in the composer is cleared after the answer went out', async () => {
  const app = panel();
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 3;

  await app.submitComposer('the first one');

  assert.equal(app.ui.question, null, 'the question is cleared once the answer went out');
});

/** The fast command of the panel, with the browser and the provider mocked. */
function fastPanel({ fail = null, result = { ok: true, say: 'voice.success' } } = {}) {
  const errors = [];
  const spoken = [];
  const context = vm.createContext({
    Promise, DOMException,
    settings: { voiceEngine: 'fast_only', fast: { apiKey: 'k', baseUrl: 'https://provider.test' } },
    sessionId: 'session-a',
    voicePanelId: 'panel-a',
    voiceOrigin: null,
    voiceTarget: async () => ({ id: 5, windowId: 1, url: 'https://example.test/', title: 'Example' }),
    t: (key) => key,
    createFastAsk: () => async () => ({}),
    createChromeBrowser: () => ({}),
    SECRET_TOKENS: ['password'],
    runFastCommand: async () => { if (fail) throw fail; return result; },
    askVoiceApproval: async () => true,
    voiceController: { speak: (text) => spoken.push(text), stopListening() {} },
    $: (id) => ({ hidden: false, textContent: '', value: '' }),
  });
  vm.runInContext(fastCommand, context);
  return { context, errors, spoken };
}

const fastEntry = (errors) => ({
  setErr: (message) => errors.push(message),
  setOk: () => {},
  addNote: () => {},
  addDecision: () => {},
});

test('a cancelled fast command writes nothing into the screen', async () => {
  const errors = [];
  const app = fastPanel({ fail: new DOMException('The operation was aborted.', 'AbortError') });
  const controller = new AbortController();

  await app.context.runFastVoiceCommand('scroll down', { signal: controller.signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, [], 'the raw error is not written into the screen');
  assert.deepEqual(app.spoken, [], 'nothing is spoken after the cancellation');
});

test('a fast command that was cancelled while it ran writes nothing into the screen', async () => {
  const errors = [];
  const app = fastPanel({ fail: new Error('the worker is gone') });
  const controller = new AbortController();
  controller.abort();

  await app.context.runFastVoiceCommand('scroll down', { signal: controller.signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, [], 'the raw error is not written into the screen');
});

test('a fast command that failed for another reason says so', async () => {
  const errors = [];
  const app = fastPanel({ fail: new Error('the worker is gone') });

  await app.context.runFastVoiceCommand('scroll down', { signal: new AbortController().signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, ['the worker is gone'], 'the failure is shown');
});

test('a fast command that worked says so and speaks the answer', async () => {
  const errors = [];
  const app = fastPanel();

  await app.context.runFastVoiceCommand('scroll down', { signal: new AbortController().signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, []);
  assert.deepEqual(app.spoken, ['voice.success']);
});
