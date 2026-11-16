import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranscriptionForm } from '../src/sidepanel/transcription-form.js';

function fakeElement(id) {
  const listeners = new Map();
  return {
    id,
    value: '',
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    readOnly: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type) { listeners.get(type)?.({ target: this }); },
    closest() { return { hidden: false }; },
  };
}

function fakeDom() {
  const ids = ['transcriptionEndpoint', 'transcriptionModel', 'transcriptionKey', 'transcriptionMode', 'transcriptionPause', 'transcriptionService', 'transcriptionCloud', 'transcriptionLocal', 'downloadLocalModel', 'cancelLocalModel', 'localModelProgress', 'localModelStatus', 'localModelHelp'];
  const elements = new Map(ids.map((id) => [id, fakeElement(id)]));
  elements.get('transcriptionMode').value = 'auto';
  elements.get('transcriptionPause').value = '1200';
  return { root: { getElementById: (id) => elements.get(id) }, elements };
}

// A native host that answers only when the test says so.
function fakeHost() {
  const requests = [];
  const original = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      connectNative: () => {
        const listeners = { message: [], disconnect: [] };
        const port = {
          posted: [],
          postMessage(message) { this.posted.push(message); requests.push({ port: this, message }); },
          onMessage: { addListener(fn) { listeners.message.push(fn); } },
          onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
          send(value) { for (const fn of listeners.message) fn(value); },
        };
        return port;
      },
    },
  };
  return {
    requests,
    restore() { globalThis.chrome = original; },
    ofType(type) { return requests.filter((request) => request.message.type === type); },
  };
}

const flush = async (times = 6) => { for (let i = 0; i < times; i++) await Promise.resolve(); };

test('every local model keeps its own download, and cancelling one leaves the other alone', async () => {
  const { root, elements } = fakeDom();
  const host = fakeHost();
  try {
    const form = createTranscriptionForm(root);
    form.fill({ mode: 'auto', provider: 'local-nemotron', endpoint: '', model: '', apiKey: '', endSilenceMs: 1200 });
    await flush();
    const status = host.ofType('speech-status');
    assert.equal(status.length, 1);
    assert.equal(status[0].message.modelId, 'local-nemotron', 'the status asks about the selected model');
    status[0].port.send({ exitCode: 0, result: { installed: false } });
    await flush();

    // The Nemotron download starts.
    elements.get('downloadLocalModel').dispatch('click');
    await flush();
    const installs = host.ofType('speech-install');
    assert.equal(installs.length, 1);
    assert.equal(installs[0].message.modelId, 'local-nemotron');
    installs[0].port.send({ type: 'progress', phase: 'download', percent: 42 });
    await flush();
    assert.equal(elements.get('localModelStatus').textContent, '42%', 'the progress of the visible model is shown');

    // The user chooses Whisper and starts its download while Nemotron runs.
    elements.get('transcriptionService').value = 'local-whisper';
    elements.get('transcriptionService').dispatch('change');
    await flush();
    elements.get('downloadLocalModel').dispatch('click');
    await flush();
    const whisperInstall = host.ofType('speech-install').at(-1);
    assert.equal(whisperInstall.message.modelId, 'local-whisper');

    // Cancelling the visible model aborts only its own download.
    elements.get('cancelLocalModel').dispatch('click');
    await flush();
    assert.match(elements.get('localModelStatus').textContent, /stopped|cancel/i, 'the cancelled download reports why');
    assert.notEqual(elements.get('localModelStatus').textContent, '42%', 'the Nemotron progress is not shown as the Whisper status');

    // The Nemotron download answers after the Whisper one: its result belongs
    // to the Nemotron record alone.
    installs[0].port.send({ exitCode: 0, result: { installed: true } });
    await flush();
    assert.equal(elements.get('localModelStatus').textContent !== 'Local model ready', true, 'the other model does not land on the visible status');

    elements.get('transcriptionService').value = 'local-nemotron';
    elements.get('transcriptionService').dispatch('change');
    await flush();
    assert.equal(elements.get('localModelStatus').textContent, 'Local model ready', 'the Nemotron record kept its own result');
  } finally {
    host.restore();
  }
});

test('a status that cannot be answered keeps the selection and says what is wrong', async () => {
  const { root, elements } = fakeDom();
  const host = fakeHost();
  try {
    const form = createTranscriptionForm(root);
    form.fill({ mode: 'auto', provider: 'local-nemotron', endpoint: '', model: '', apiKey: '', endSilenceMs: 1200 });
    await flush();
    const status = host.ofType('speech-status')[0];
    status.port.send({ error: 'Nemotron Streaming 3.5 requires Windows x64 and Node.js 22 or newer.' });
    await flush();

    assert.equal(elements.get('transcriptionService').value, 'local-nemotron', 'the selection is kept');
    assert.match(elements.get('localModelStatus').textContent, /Windows x64/);
    assert.equal(elements.get('downloadLocalModel').hidden, false, 'the download is offered anyway');
  } finally {
    host.restore();
  }
});
