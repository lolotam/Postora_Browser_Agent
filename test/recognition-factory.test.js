import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConfiguredRecognition } from '../src/voice/recognition-factory.js';

test('the browser recognizer is chosen first, and needs nothing else', () => {
  const browser = { kind: 'browser' };
  let audioBuilt = 0;
  let nemotronBuilt = 0;
  const rec = createConfiguredRecognition({ transcription: { mode: 'browser', provider: 'local-nemotron' } }, {
    createBrowserRecognition: () => browser,
    createAudio: () => { audioBuilt += 1; return { kind: 'audio' }; },
    createNemotron: () => { nemotronBuilt += 1; return { kind: 'nemotron' }; },
  });
  assert.equal(rec, browser);
  assert.equal(audioBuilt, 0);
  assert.equal(nemotronBuilt, 0);
});

test('the live local model is chosen for Nemotron, and the network is not used', () => {
  let transcribeCalls = 0;
  let validateCalls = 0;
  const adapter = { kind: 'nemotron' };
  const rec = createConfiguredRecognition({ transcription: { mode: 'auto', provider: 'local-nemotron' } }, {
    createNemotron: () => adapter,
    createAudio: () => ({ kind: 'audio' }),
    validate: () => { validateCalls += 1; return {}; },
    transcribe: async () => { transcribeCalls += 1; return 'fixture'; },
  });
  assert.equal(rec, adapter);
  assert.equal(transcribeCalls, 0, 'a local model never asks a service');
  assert.equal(validateCalls, 0);
});

test('Whisper and the cloud services transcribe one phrase with the service they name', () => {
  for (const provider of ['local-whisper', 'openai', 'custom']) {
    const built = [];
    const rec = createConfiguredRecognition({ transcription: { mode: 'auto', provider, endSilenceMs: 900, endpoint: 'https://example.invalid/v1', model: 'm', apiKey: 'k' } }, {
      createAudio: (options) => { built.push(options); return { kind: 'audio' }; },
      createNemotron: () => ({ kind: 'nemotron' }),
      validate: (config) => ({ validated: config.provider }),
      transcribe: async () => 'fixture',
    });
    assert.equal(rec.kind, 'audio');
    assert.equal(built.length, 1);
    assert.equal(built[0].endSilenceMs, 900);
    assert.equal(built[0].checkConfiguration().validated, provider);
  }
});

test('a local model that cannot be built fails with its reason and is not replaced', () => {
  let audioBuilt = 0;
  assert.throws(() => createConfiguredRecognition({ transcription: { mode: 'auto', provider: 'local-nemotron' } }, {
    createNemotron: () => { throw new Error('the private native host is missing'); },
    createAudio: () => { audioBuilt += 1; return { kind: 'audio' }; },
  }), /private native host is missing/);
  assert.equal(audioBuilt, 0, 'the audio is not sent somewhere else instead');
});
