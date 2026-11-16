import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocal, LOCAL_MODELS, isLocalProvider } from '../src/voice/local-models.js';
import { validateTranscription } from '../src/voice/transcription.js';
import { mergeSettings } from '../src/lib/settings.js';

test('normalizeLocal migrates legacy local provider to Nemotron defaults', () => {
  assert.equal(normalizeLocal({ provider: 'local', model: 'base' }).provider, 'local-nemotron');
  assert.equal(normalizeLocal({ provider: 'local', model: 'base' }).model, 'nemotron-3.5-q8_0');
  assert.equal(normalizeLocal({ provider: 'local', model: 'base' }).endpoint, '');
});

test('normalizeLocal preserves explicit local-whisper selection', () => {
  const out = normalizeLocal({ provider: 'local-whisper', model: 'base' });
  assert.equal(out.provider, 'local-whisper');
  assert.equal(out.model, 'base');
});

test('normalizeLocal leaves cloud providers unchanged', () => {
  const cloud = { provider: 'groq', apiKey: 'fixture', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' };
  assert.deepEqual(normalizeLocal(cloud), cloud);
});

test('LOCAL_MODELS and isLocalProvider describe Nemotron and Whisper', () => {
  assert.deepEqual(Object.keys(LOCAL_MODELS).sort(), ['local-nemotron', 'local-whisper']);
  assert.equal(isLocalProvider('local-nemotron'), true);
  assert.equal(isLocalProvider('local-whisper'), true);
  assert.equal(isLocalProvider('local'), false);
  assert.equal(isLocalProvider('openai'), false);
});

test('local validation returns endpoint null and does not require network', () => {
  const nemotron = validateTranscription({ provider: 'local-nemotron', mode: 'auto' });
  assert.equal(nemotron.provider, 'local-nemotron');
  assert.equal(nemotron.endpoint, null);
  const whisper = validateTranscription({ provider: 'local-whisper', mode: 'auto' });
  assert.equal(whisper.provider, 'local-whisper');
  assert.equal(whisper.endpoint, null);
});

test('a local model is never asked over the network', async () => {
  const { transcribeAudio } = await import('../src/voice/transcription.js');
  let fetched = false;
  const fetcher = async () => { fetched = true; throw new Error('the network must not be used'); };

  await assert.rejects(transcribeAudio(new Blob(['x']), { provider: 'local-nemotron', mode: 'auto' }, { fetcher }), /Nemotron requires live microphone capture/);
  await assert.rejects(transcribeAudio(new Blob(['x']), { provider: 'local-whisper', mode: 'auto' }, { fetcher }));
  assert.equal(fetched, false, 'a local model runs on this computer');
});

test('mergeSettings migrates legacy local transcription and retains browser/custom context', () => {
  const legacy = mergeSettings({ transcription: { provider: 'local', model: 'base', endpoint: '', apiKey: '', services: {} } });
  assert.equal(legacy.transcription.provider, 'local-nemotron');
  assert.equal(legacy.transcription.model, 'nemotron-3.5-q8_0');
  assert.equal(legacy.transcription.mode, 'auto');

  const browser = mergeSettings({ transcription: { mode: 'browser', provider: 'openai' } });
  assert.equal(browser.transcription.mode, 'browser');

  const custom = mergeSettings({ transcription: { provider: 'custom', endpoint: 'http://localhost:8080/v1/audio/transcriptions', model: 'whisper-1', apiKey: 'k', services: { a: 1 } } });
  assert.equal(custom.transcription.provider, 'custom');
  assert.equal(custom.transcription.apiKey, 'k');
  assert.deepEqual(custom.transcription.services, { a: 1 });
});
