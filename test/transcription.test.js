import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio, speechLocale } from '../src/voice/transcription.js';
import { createAudioRecognition } from '../src/voice/audio-recognition.js';

test('Deepgram uploads raw audio with Arabic/English hints, never its English default', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  const result = await transcribeAudio(blob, { provider: 'deepgram', endpoint: 'https://api.deepgram.com/v1/listen', model: 'nova-3', apiKey: 'fixture-key' }, { fetcher: async (url, request) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.searchParams.get('language'), 'multi');
    assert.deepEqual(endpoint.searchParams.getAll('language_hint'), ['ar', 'en']);
    assert.equal(request.headers.Authorization, 'Token fixture-key');
    assert.equal(request.body, blob);
    return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'افتح project' }] }] } }) };
  } });
  assert.equal(result, 'افتح project');
});

test('Groq uses the multilingual transcription endpoint and bearer credentials', async () => {
  const result = await transcribeAudio(new Blob(['audio']), { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', apiKey: 'fixture-key' }, { fetcher: async (url, request) => {
    assert.equal(new URL(url).pathname, '/openai/v1/audio/transcriptions');
    assert.equal(request.headers.Authorization, 'Bearer fixture-key');
    assert.equal(request.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(request.body.has('language'), false);
    return { ok: true, json: async () => ({ text: 'افتح المشروع' }) };
  } });
  assert.equal(result, 'افتح المشروع');
});

test('multilingual transcription preserves Arabic and sends no forced language', async () => {
  const text = await transcribeAudio(new Blob(['test'], { type: 'audio/webm' }), { apiKey: 'synthetic' }, {
    fetcher: async (url, init) => {
      assert.ok(url.endsWith('/audio/transcriptions'));
      assert.equal(init.body.get('model'), 'gpt-transcribe');
      assert.equal(init.body.has('language'), false);
      assert.equal(init.body.has('languages'), false);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      return { ok: true, json: async () => ({ text: 'افتح project files' }) };
    },
  });
  assert.equal(text, 'افتح project files');
  assert.equal(speechLocale(text), 'ar-EG');
  assert.equal(speechLocale('Open the project'), 'en-US');
});

test('remote audio needs a key; localhost is supported; invalid responses fail', async () => {
  const blob = new Blob(['test']);
  await assert.rejects(transcribeAudio(blob, {}), /API key/);
  await assert.rejects(transcribeAudio(blob, { endpoint: 'http://example.com/audio' }), /HTTPS/);
  await assert.rejects(transcribeAudio(blob, { endpoint: 'http://localhost:9090/audio' }, { fetcher: async () => ({ ok: true, json: async () => ({}) }) }), /no text/);
});

function microphone(transcribe) {
  let recorder, tracksStopped = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { recorder = this; this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); void this.onstop(); }
  }
  const rec = createAudioRecognition({ transcribe, Recorder, Context: null,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { tracksStopped++; } }] }) },
  });
  return { rec, recorder: () => recorder, stopped: () => tracksStopped };
}

test('late transcription after cancellation never becomes a command', async () => {
  let resolve;
  const mic = microphone(() => new Promise((r) => { resolve = r; }));
  const seen = [];
  mic.rec.onresult = (event) => seen.push(event.results[0][0].transcript);
  mic.rec.start();
  await new Promise((r) => setImmediate(r));
  mic.rec.stop();
  mic.rec.abort();
  resolve('لا تنفذ هذا الأمر المتأخر');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, []);
  assert.ok(mic.stopped());
});

test('a completed recording returns its original Arabic transcript once', async () => {
  const mic = microphone(async () => 'افتح المشروع');
  const seen = [];
  mic.rec.onresult = (event) => seen.push(event.results[0][0].transcript);
  mic.rec.start();
  await new Promise((r) => setImmediate(r));
  mic.rec.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['افتح المشروع']);
  mic.rec.abort();
});

test('a late microphone rejection cannot close a replacement capture', async () => {
  const pending = [];
  let stopped = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop(); }
  }
  const rec = createAudioRecognition({ Recorder, Context: null, transcribe: async () => '',
    mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } });
  rec.start(); rec.abort(); rec.start();
  pending[1].resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await new Promise((r) => setImmediate(r));
  pending[0].reject(new Error('Late permission error'));
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 0);
  rec.abort();
  assert.equal(stopped, 1);
});
