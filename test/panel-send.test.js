import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual panel send functions with a mocked port boundary. This
// verifies returned promises and session/cancellation behavior, not source text.
const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
// The approvals have their own section between the send and the event handler.
const send = source.slice(source.indexOf('async function send('), source.indexOf('\n// ---------- approvals ----------'));
const composer = source.slice(source.indexOf('function submitComposer('), source.indexOf("\n$('composer').addEventListener"));
const voiceMessage = source.slice(source.indexOf('function sendVoiceMessage('), source.indexOf("\n$('composer').addEventListener"));
const voiceCommand = source.slice(source.indexOf('async function runVoiceCommand('), source.indexOf('\n/** The fast layer runs the command itself'));
const fastCommand = source.slice(source.indexOf('async function runFastVoiceCommand('), source.indexOf("\n/** The name of a step, in the panel"));
const questionSource = source.slice(source.indexOf('function showPendingQuestion('), source.indexOf('\nfunction setRunning('));
const chatSource = source.slice(source.indexOf('function closeVoice('), source.indexOf('\n// ---------- the commands ----------'));
const finishTaskSource = source.slice(source.indexOf('function finishVoiceTask('), source.indexOf('\nfunction cancelVoiceTask('));
const connectSource = source.slice(source.indexOf('function connect('), source.indexOf('\n// Picking the session'));

function panel({ postMessage = () => {}, picking = null } = {}) {
  const elements = new Map();
  const context = vm.createContext({
    Promise, DOMException,
    picking, sessionId: 'original', port: { postMessage },
    attachments: [], settings: {}, ui: { running: false, question: null, questionId: 0, answering: null },
    voiceViewToken: 0, voiceController: null, voiceApproval: null,
    syncHeaderContext() {}, placeApprovals() {},
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    },
    t: (key) => key, renderFiles() {}, connect() {}, showTabSession: async () => {},
    packFiles: (text) => ({ task: text, display: text, images: [] }),
  });
  vm.runInContext(`${send}\n${composer}\n${questionSource}\n${chatSource}`, context);
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

const requestAccessSource = source.slice(source.indexOf('async function requestAccess('), source.indexOf('\n/** The reason the last mode request'));

test('an acknowledged mode request is bound to its live connection while session picking waits', async () => {
  let done;
  const picking = new Promise((resolve) => { done = resolve; });
  const posted = [];
  const app = panel({ picking, postMessage: (message) => posted.push(message) });
  app.renderAccessError = () => {};
  vm.runInContext(requestAccessSource, app);
  const message = { type: 'access-mode', sessionId: 'original', mode: 'full-access', acknowledged: true, expectedRevision: 1 };
  const pending = app.requestAccess(message);
  // The restarted worker can have the same numeric revision: only the old
  // connection read that warning, so the request must not cross to this one.
  app.port = { postMessage: (value) => posted.push(value) };
  app.picking = null;
  done();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(posted, []);
});

test('consent does not reconnect and resend after its connection disappears', async () => {
  let done;
  const picking = new Promise((resolve) => { done = resolve; });
  const posted = [];
  const app = panel({ picking, postMessage: (message) => posted.push(message) });
  let reconnects = 0;
  app.connect = () => { reconnects += 1; };
  app.renderAccessError = () => {};
  vm.runInContext(requestAccessSource, app);
  const pending = app.requestAccess({ type: 'access-mode', sessionId: 'original', mode: 'full-access', acknowledged: true, expectedRevision: 1 });
  app.port = null;
  app.picking = null;
  done();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(reconnects, 0);
  assert.deepEqual(posted, []);
});

test('consent sends normally on the connection that confirmed the warning state', async () => {
  const posted = [];
  const app = panel({ postMessage: (message) => posted.push(message) });
  app.renderAccessError = () => {};
  vm.runInContext(requestAccessSource, app);
  const message = { type: 'access-mode', sessionId: 'original', mode: 'full-access', acknowledged: true, expectedRevision: 1 };
  assert.equal(await app.requestAccess(message), true);
  assert.deepEqual(posted, [message]);
});

/** The panel's own voice command, with the port and the settings mocked. */
function voicePanel({ question = null, engine = 'postora', running = false } = {}) {
  const posted = [];
  const elements = new Map();
  const context = vm.createContext({
    Promise, DOMException,
    ui: { running, question, questionId: question ? 1 : 0, answering: null },
    settings: { voiceEngine: engine },
    sessionId: 'session-a',
    voiceTask: null,
    voiceViewToken: 0, voiceController: null, voiceApproval: null,
    syncHeaderContext() {}, placeApprovals() {},
    t: (key) => key,
    voiceTarget: async () => ({ id: 5, windowId: 1, url: 'https://example.test/', title: 'Example' }),
    runFastVoiceCommand: async () => {},
    send: (message) => { posted.push(message); return Promise.resolve(); },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    },
  });
  vm.runInContext(`${voiceMessage}\n${voiceCommand}\n${questionSource}\n${finishTaskSource}\n${chatSource}`, context);
  return { context, posted };
}

const entry = { setErr() {}, setOk() {}, addNote() {} };

test('a live question restores waiting activity after the voice screen closes; replay does not', () => {
  let status = '';
  let settled = 0;
  const app = vm.createContext({
    replaying: false,
    closeThread() {}, add() {},
    showChat: () => { status = 'Cancelled'; },
    setQuestion() {},
    settleVoiceCommand: () => { settled += 1; },
    voiceEntryFor: () => ({ setStatus: (text, state) => { status = `${text}:${state}`; } }),
    t: (key) => key,
  });
  const handler = source.slice(source.indexOf('function onEvent('), source.indexOf('\nfunction threadPart('));
  vm.runInContext(handler, app);
  app.onEvent({ type: 'ask', question: 'Which one?' });
  assert.equal(status, 'status.waiting:thinking');
  assert.equal(settled, 1);
  app.replaying = true;
  status = 'unchanged';
  app.onEvent({ type: 'ask', question: 'Historical question' });
  assert.equal(status, 'unchanged');
  assert.equal(settled, 1);
});

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

test('a voice answer completed after cancellation does not publish late success or change screens', async () => {
  const { context } = voicePanel({ question: 'Which one do you mean?', running: true });
  let delivered;
  context.send = () => new Promise((resolve) => { delivered = resolve; });
  const updates = [];
  context.showChat = () => updates.push('screen');
  const abort = new AbortController();
  const pending = context.runVoiceCommand('the first one', {
    signal: abort.signal,
    entry: { setErr: () => updates.push('error'), setOk: () => updates.push('success') },
  });
  abort.abort();
  delivered();
  await pending;
  assert.deepEqual(updates, [], 'a delivered answer does not resurrect a cancelled command');
});

test('a voice command answers a question that waits while the task is still running', async () => {
  const errors = [];
  const ok = [];
  const { context, posted } = voicePanel({ question: 'Which one do you mean?', running: true });
  await context.runVoiceCommand('the first one', {
    signal: new AbortController().signal,
    entry: { setErr: (text) => errors.push(text), setOk: (text) => ok.push(text), addNote() {} },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    type: 'answer',
    text: 'the first one',
    display: 'the first one',
    images: [],
  }], 'the answer goes to the question that waits');
  assert.deepEqual(errors, [], 'the answer is not refused as busy');
  assert.equal(context.voiceTask, null, 'no fresh task is started for an answer');
});

test('a voice answer hands the screen back to the chat, where the task and its report are', async () => {
  const { context } = voicePanel({ question: 'Which one do you mean?', running: true });
  await context.runVoiceCommand('the first one', { signal: new AbortController().signal, entry });

  assert.equal(context.$('voiceView').hidden, true, 'the voice screen is left');
  assert.equal(context.$('chatView').hidden, false, 'the chat is shown');
});

test('a voice command is refused while the task works and no question waits', async () => {
  const errors = [];
  const { context, posted } = voicePanel({ running: true });
  await context.runVoiceCommand('scroll down', {
    signal: new AbortController().signal,
    entry: { setErr: (text) => errors.push(text), setOk() {}, addNote() {} },
  });

  assert.deepEqual(errors, ['voice.busy'], 'the command is refused while the session is busy');
  assert.deepEqual(posted, [], 'nothing was sent');
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
    // The access control of the chat: a new connection knows nothing of it.
    accessUi: { reset() {}, reconnect() {} },
    // The approvals of the chat: they belong to the connection that is gone.
    resetApprovals() {},
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

test('a question is answered once: a second answer is refused and the draft is kept', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const app = panel({ postMessage: (message) => { sent.push(message); return gate; } });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;
  app.$('input').value = 'the first one';

  // The answer of the voice is on its way, and the user types the same answer.
  const spoken = app.sendVoiceMessage('the first one');
  const typed = await app.submitComposer('the first one');

  assert.equal(typed, false, 'the second answer to the same question is refused');
  assert.equal(sent.length, 1, 'only one answer went out');
  assert.equal(app.$('input').value, 'the first one', 'the draft of the user is left alone');

  release();
  assert.equal(await spoken, true);
});

test('a question whose answer could not be sent may be answered again', async () => {
  const sent = [];
  let fail = true;
  const app = panel({
    postMessage: (message) => {
      sent.push(message);
      if (fail) {
        fail = false;
        throw new Error('port disconnected');
      }
      return Promise.resolve();
    },
  });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  await assert.rejects(app.sendVoiceMessage('the first one'), /port disconnected/);
  assert.equal(app.ui.question, 'Which one do you mean?', 'the question still waits for an answer');

  const again = await app.sendVoiceMessage('the second try');
  assert.equal(again, true, 'the question may be answered again');
  assert.equal(sent.length, 2);
});

test('a newer question may be answered while the answer of the older one is on its way', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const app = panel({ postMessage: (message) => { sent.push(message); return gate; } });
  app.ui.question = 'Which one do you mean?';
  app.ui.questionId = 1;

  const older = app.sendVoiceMessage('the first one');
  // A newer question arrives while the answer is still on its way.
  app.ui.question = 'And now, which one?';
  app.ui.questionId = 2;
  const newer = app.sendVoiceMessage('the second one');

  assert.equal(sent.length, 2, 'the newer question has its own answer');
  release();
  await older;
  assert.equal(await newer, true);
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
  controller.abort();

  await app.context.runFastVoiceCommand('scroll down', { signal: controller.signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, [], 'the raw error is not written into the screen');
  assert.deepEqual(app.spoken, [], 'nothing is spoken after the cancellation');
});

test('a fast command that failed with an abort it did not ask for says so', async () => {
  const errors = [];
  const app = fastPanel({ fail: new DOMException('The operation was aborted.', 'AbortError') });

  await app.context.runFastVoiceCommand('scroll down', { signal: new AbortController().signal, entry: fastEntry(errors) });

  assert.deepEqual(errors, ['The operation was aborted.'], 'an abort that this command did not ask for is a failure');
  assert.deepEqual(app.spoken, [], 'nothing is spoken for a failed command');
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
