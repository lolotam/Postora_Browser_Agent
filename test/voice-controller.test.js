import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/voice/voice-controller.js';

// A recognizer that behaves like Chrome's: it ends when it is told to, and it
// hands the words it heard to the controller.
class FakeRecognition {
  constructor() {
    this.started = false;
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onstart = null;
  }

  start() {
    if (this.started) throw new Error('already started');
    this.started = true;
    this.onstart?.();
  }

  abort() {
    this.started = false;
    this.onend?.();
  }

  stop() {
    this.started = false;
    this.onend?.();
  }

  /** What the microphone heard. */
  hear(text, isFinal = true) {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }

  /** What the microphone heard in one go: several finished phrases. */
  batch(texts) {
    const results = texts.map((text) => Object.assign([{ transcript: text }], { isFinal: true }));
    this.onresult?.({ resultIndex: 0, results });
  }
}

function setup({ handsFree = true, speakReplies = false, panel = true, prefs, failMic = false } = {}) {
  const created = [];
  const commands = [];
  const states = [];
  const transcripts = [];
  const failures = [];
  const windows = [];
  const pauses = [];
  const resumes = [];
  const logs = [];
  const saved = { handsFree, speakReplies };
  let clock = 1000;
  let spoken = null;
  let blocked = false;
  let release = null;

  const controller = createVoiceController({
    createRecognition: () => {
      const rec = new FakeRecognition();
      created.push(rec);
      return rec;
    },
    canListenInPanel: () => panel,
    openMicWindow: async (options) => {
      if (failMic) throw new Error('the window did not open');
      windows.push(options);
    },
    closeMicWindow: () => { windows.push('closed'); },
    pauseCapture: () => { pauses.push(true); },
    resumeCapture: () => { resumes.push(true); },
    say: (text, { onEnd }) => { spoken = { text, onEnd }; },
    stopSpeech: () => { spoken = null; },
    speaking: () => Boolean(spoken),
    onState: (state) => states.push(state),
    onTranscript: (text, options) => transcripts.push({ text, ...options }),
    onCommand: async (text, { signal }) => {
      commands.push({ text, signal });
      await new Promise((resolve) => { release = resolve; });
    },
    onLog: (command) => {
      const record = { command, status: null };
      logs.push(record);
      return {
        command,
        setStatus(text, state) { record.status = { text, state }; },
        setOk(text) { record.status = { text, state: 'ok' }; },
        setErr(text) { record.status = { text, state: 'err' }; },
      };
    },
    loadPrefs: async () => (prefs ?? { ...saved }),
    savePrefs: async (next) => { Object.assign(saved, next); },
    onFailure: (code) => failures.push(code),
    onMicBlocked: () => { blocked = true; },
    cancelledText: () => 'Cancelled',
    now: () => clock,
  });

  return {
    controller,
    created,
    commands,
    states,
    transcripts,
    failures,
    windows,
    pauses,
    resumes,
    logs,
    saved,
    blocked: () => blocked,
    speak: () => spoken,
    endSpeech: () => { const s = spoken; spoken = null; s?.onEnd?.(); },
    tick: (ms) => { clock += ms; },
    release: () => release?.(),
  };
}

test('hands-free off: one utterance runs one command and the microphone stops', async () => {
  const app = setup({ handsFree: false });
  await app.controller.open();
  assert.equal(app.created.length, 0, 'the microphone stays off until it is asked for');

  app.controller.startListening();
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].continuous, false, 'a single utterance, not a continuous session');

  app.created[0].hear('open youtube');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);
  assert.equal(app.controller.listening, false, 'the microphone is off after the one utterance');
});

test('one batch with several finished phrases is one command when the microphone is single-shot', async () => {
  const app = setup({ handsFree: false });
  await app.controller.open();
  app.controller.startListening();
  app.created[0].batch(['open youtube', 'and scroll down']);
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);
});

test('hands-free on: the recognizer keeps listening and is started again when it ends', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].continuous, true);

  app.created[0].hear('scroll down');
  assert.deepEqual(app.commands.map((c) => c.text), ['scroll down']);
  assert.equal(app.controller.listening, true, 'it keeps listening');

  // Chrome ends the recognizer after a pause: it is started again.
  app.created[0].onend();
  assert.equal(app.created.length, 2);
  assert.equal(app.created[1].started, true);
});

test('a recognizer that keeps ending is given up on', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  for (let i = 0; i < 8; i += 1) app.created[app.created.length - 1].onend();
  assert.deepEqual(app.failures, ['restart-limit']);
  assert.equal(app.controller.listening, false);
});

test('a result that arrives after the microphone was stopped is not a command', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  const rec = app.created[0];
  app.controller.stopListening();
  rec.hear('open youtube');
  assert.deepEqual(app.commands, [], 'the stopped recognizer is retired');
});

test('a result of a recognizer that was replaced is not a command', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  const first = app.created[0];
  first.onend(); // Chrome ended it: a new recognizer takes over
  assert.equal(app.created.length, 2);
  first.hear('open youtube');
  assert.deepEqual(app.commands, [], 'the retired recognizer is ignored');
});

test('a final of a stopped microphone window is not a command', async () => {
  const app = setup({ handsFree: true, panel: false });
  await app.controller.open();
  app.controller.handleFinal('open youtube');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);

  app.controller.stopListening();
  app.controller.handleFinal('scroll down');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube'], 'the stopped window is retired');
});

test('the microphone window that ran out ends the capture', async () => {
  const app = setup({ handsFree: true, panel: false });
  await app.controller.open();
  app.controller.handleCaptureEnded();
  assert.equal(app.controller.listening, false);
  app.controller.handleFinal('scroll down');
  assert.deepEqual(app.commands, []);
});

test('closing and opening the screen again does not leave two recognizers', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  const first = app.created[0];
  app.controller.close();
  await app.controller.open();
  assert.equal(app.created.length, 2, 'a new recognizer is made for the new screen');
  assert.equal(first.started, false, 'the old one is stopped');
  first.hear('open youtube');
  assert.deepEqual(app.commands, [], 'the retired recognizer stays retired');
});

test('the screen that is closed while the preferences load does not start listening', async () => {
  let resolvePrefs;
  const prefs = new Promise((resolve) => { resolvePrefs = resolve; });
  const app = setup({ handsFree: true, prefs: null });
  const controller = createVoiceController({
    createRecognition: () => new FakeRecognition(),
    canListenInPanel: () => true,
    openMicWindow: async () => {},
    closeMicWindow: () => {},
    say() {}, stopSpeech() {}, speaking: () => false,
    onState() {}, onTranscript() {}, onCommand: async () => {}, onLog: () => ({}),
    loadPrefs: () => prefs,
    savePrefs: async () => {},
  });
  const opening = controller.open();
  controller.close();
  resolvePrefs({ handsFree: true });
  await opening;
  assert.equal(controller.listening, false, 'the capture did not come back to life');
  assert.equal(app.created.length, 0);
});

test('the voice output never becomes a command, not even a late one', async () => {
  const app = setup({ handsFree: true, speakReplies: true });
  await app.controller.open();

  app.controller.speak('the task is finished');
  assert.ok(app.speak(), 'the reply is spoken');
  assert.equal(app.created[0].started, false, 'the microphone stops while the reply plays');

  // The words the reply produced reach the recognizer.
  app.created[0].hear('the task is finished');
  assert.deepEqual(app.commands, [], 'the reply is not a command');

  app.endSpeech();
  app.tick(900); // the short deafness after the reply
  app.created[1].hear('open youtube');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);
});

test('a result that arrives after the reply ended is still dropped', async () => {
  const app = setup({ handsFree: true, speakReplies: true });
  await app.controller.open();
  app.controller.speak('done');
  app.endSpeech();
  app.created[1].hear('done');
  assert.deepEqual(app.commands, []);
  app.tick(900);
  app.created[1].hear('open youtube');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);
});

test('the voice output holds the microphone window as well', async () => {
  const app = setup({ handsFree: true, speakReplies: true, panel: false });
  await app.controller.open();
  app.controller.speak('done');
  assert.deepEqual(app.pauses, [true], 'the window is paused');
  app.controller.handleFinal('done');
  assert.deepEqual(app.commands, [], 'what the paused window hears is ignored');
  app.endSpeech();
  assert.deepEqual(app.resumes, [true], 'the window is given back');
});

test('an older reply does not bring the microphone back under a newer one', async () => {
  const app = setup({ handsFree: true, speakReplies: true });
  await app.controller.open();
  app.controller.speak('one');
  const first = app.speak();
  app.controller.speak('and again');
  const second = app.speak();
  assert.ok(first && second);
  assert.notEqual(first.onEnd, second.onEnd);
  first.onEnd(); // the older reply finishes late
  assert.equal(app.created.length, 1, 'the microphone did not come back for the older reply');
  second.onEnd();
  assert.equal(app.created.length, 2, 'the newer reply brings it back');
});

test('overlapping replies resume the external microphone exactly once', async () => {
  const app = setup({ handsFree: true, speakReplies: true, panel: false });
  await app.controller.open();
  app.controller.speak('first reply');
  const first = app.speak();
  app.controller.speak('replacement reply');
  const second = app.speak();
  first.onEnd();
  assert.deepEqual(app.resumes, [], 'retired reply cannot resume the window');
  app.endSpeech();
  assert.deepEqual(app.resumes, [true], 'latest reply returns the paused window');
  second.onEnd();
  assert.deepEqual(app.resumes, [true], 'duplicate completion does not resume twice');
  app.controller.close();
});

test('the microphone toggle can stop capture while a reply has paused it', async () => {
  const app = setup({ handsFree: true, speakReplies: true, panel: false });
  await app.controller.open();
  app.controller.speak('reply');
  app.controller.toggleListening();
  app.endSpeech();
  assert.deepEqual(app.resumes, [], 'stopped capture is not restarted after speech');
  assert.equal(app.controller.listening, false);
  app.controller.close();
});

test('a recognizer start failure leaves capture stopped and reports the failure', async () => {
  const app = setup({ handsFree: false });
  await app.controller.open();
  const original = FakeRecognition.prototype.start;
  FakeRecognition.prototype.start = () => { throw new Error('device unavailable'); };
  try {
    app.controller.startListening();
    assert.equal(app.controller.listening, false);
    assert.deepEqual(app.failures, ['start-failed']);
  } finally {
    FakeRecognition.prototype.start = original;
    app.controller.close();
  }
});

test('a reply that finishes after the screen was closed does not bring the microphone back', async () => {
  const app = setup({ handsFree: true, speakReplies: true });
  await app.controller.open();
  app.controller.speak('done');
  const spoken = app.speak();
  app.controller.close();
  spoken.onEnd();
  assert.equal(app.created.length, 1, 'nothing was started again');
});

test('the commands run one after another', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].hear('first');
  app.created[0].hear('second');
  assert.deepEqual(app.commands.map((c) => c.text), ['first'], 'the second waits');
  assert.equal(app.controller.busy, true);

  app.release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(app.commands.map((c) => c.text), ['first', 'second']);
});

test('a command that is cancelled stops the one that is running', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].hear('first');
  app.controller.cancelCommand();
  assert.equal(app.commands[0].signal.aborted, true);
});

test('closing the screen stops the microphone and the command', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].hear('first');
  app.controller.close();
  assert.equal(app.created[0].started, false, 'the recognizer is stopped');
  assert.equal(app.commands[0].signal.aborted, true, 'the running command is cancelled');
  assert.equal(app.controller.listening, false);
});

test('the preferences are loaded when the screen opens and saved when they change', async () => {
  const app = setup({ handsFree: false, speakReplies: false });
  await app.controller.open();
  assert.deepEqual(app.controller.prefs, { handsFree: false, speakReplies: false });

  await app.controller.setHandsFree(true);
  assert.equal(app.saved.handsFree, true);
  await app.controller.setSpeakReplies(true);
  assert.equal(app.saved.speakReplies, true);
  assert.equal(app.controller.prefs.speakReplies, true);
});

test('without the microphone in the panel, the real window is used', async () => {
  const app = setup({ handsFree: true, panel: false });
  await app.controller.open();
  assert.deepEqual(app.windows, [{ continuous: true }]);
  assert.equal(app.created.length, 0, 'the panel does not listen itself');

  // What the window heard reaches the controller as a command.
  app.controller.handlePartial('open you');
  app.controller.handleFinal('open youtube');
  assert.deepEqual(app.commands.map((c) => c.text), ['open youtube']);

  app.controller.close();
  assert.ok(app.windows.includes('closed'), 'the window is closed with the screen');
});

test('a blocked microphone in the panel falls back to the window, and the capture goes on', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].onerror({ error: 'not-allowed' });
  assert.equal(app.blocked(), true);
  assert.deepEqual(app.windows.at(-1), { continuous: true });
  assert.deepEqual(app.failures, ['not-allowed']);
  assert.equal(app.controller.listening, true, 'the user still wants to listen');
  app.controller.toggleListening();
  assert.equal(app.controller.listening, false, 'the next press stops it');
});

test('a microphone that is not there stops the listening instead of claiming it', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].onerror({ error: 'audio-capture' });
  assert.deepEqual(app.failures, ['audio-capture']);
  assert.equal(app.controller.listening, false);
});

test('a speech service that cannot be reached stops the listening too', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].onerror({ error: 'network' });
  assert.deepEqual(app.failures, ['network']);
  assert.equal(app.controller.listening, false);
});

test('the typed command runs like a spoken one', async () => {
  const app = setup({ handsFree: false });
  await app.controller.open();
  app.controller.submit('  scroll down  ');
  assert.deepEqual(app.commands.map((c) => c.text), ['scroll down']);
  assert.deepEqual(app.transcripts.at(-1), { text: 'scroll down', final: true });
});

test('the commands that were waiting are cancelled, and the one that ran is marked too', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].hear('first');
  app.created[0].hear('second');
  assert.equal(app.logs.length, 2, 'both commands are in the log');

  app.controller.close();

  assert.equal(app.logs[0].status?.text, 'Cancelled', 'the command that ran is marked as cancelled');
  assert.equal(app.logs[0].status?.state, 'err');
  assert.equal(app.logs[1].status?.text, 'Cancelled', 'the command that never ran says it was cancelled');
  assert.equal(app.logs[1].status?.state, 'err');
});

test('a cancelled command stops the one that is running', async () => {
  const app = setup({ handsFree: true });
  await app.controller.open();
  app.created[0].hear('first');
  app.controller.cancelCommand();
  assert.equal(app.commands[0].signal.aborted, true);
});

test('nothing is spoken after the screen was closed', async () => {
  const app = setup({ handsFree: true, speakReplies: true });
  await app.controller.open();
  app.controller.close();
  app.controller.speak('the task is finished');
  assert.equal(app.speak(), null, 'the reply never starts');
});

test('a microphone window that does not open does not leave the panel claiming it listens', async () => {
  const app = setup({ handsFree: true, panel: false, failMic: true });
  await app.controller.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.controller.listening, false, 'the panel is not listening');
  assert.deepEqual(app.failures, ['mic-failed']);
});
