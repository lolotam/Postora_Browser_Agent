import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeechStream } from '../native/speech-stream.mjs';
import { openSpeechStream } from '../src/native/speech-stream.js';
import { createFrameParser, frame } from '../native/host.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function b64(samples) {
  const f = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function makeFakeBinding({ autoFeed = false } = {}) {
  const feedCalls = [];
  const feedDeferreds = [];
  let loadCount = 0;
  let disposeCount = 0;
  let resetCount = 0;
  let finalizeCount = 0;
  let text = { committed: '', tentative: '' };
  let snapshotText = '';
  let snapshotOverride = null;
  const stream = {
    feed(samples) {
      feedCalls.push(samples);
      if (autoFeed) return Promise.resolve();
      const d = deferred();
      feedDeferreds.push(d);
      return d.promise;
    },
    get text() { return { ...text }; },
    get snapshot() { return { text: snapshotOverride ?? snapshotText }; },
    async finalize() {
      finalizeCount += 1;
      snapshotText = `${text.committed}${text.tentative}`.trim() || 'final-text';
      text = { committed: snapshotText, tentative: '' };
    },
    reset() { resetCount += 1; text = { committed: '', tentative: '' }; snapshotText = ''; snapshotOverride = null; },
    [Symbol.dispose]() { disposeCount += 1; },
  };
  const model = {
    createSession() { return { stream() { return stream; } }; },
    dispose() { disposeCount += 1; },
  };
  const loadModel = async () => { loadCount += 1; return model; };
  return {
    loadModel,
    stream,
    model,
    feedCalls,
    feedDeferreds,
    get loadCount() { return loadCount; },
    get disposeCount() { return disposeCount; },
    get resetCount() { return resetCount; },
    get finalizeCount() { return finalizeCount; },
    setText(v) { text = { ...v }; },
    setSnapshotText(v) { snapshotOverride = v; },
  };
}

test('native stream serializes feeds, copies partial text, finalizes after last feed, and resets without reloading', async () => {
  const fake = makeFakeBinding();
  const sent = [];
  const s = createSpeechStream({ loadModel: fake.loadModel, send: (m) => sent.push(m) });

  await s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'cap1' });
  assert.equal(sent[0].type, 'speech-stream-opened');
  assert.equal(fake.loadCount, 1);

  fake.setText({ committed: 'Ù…Ø±Ø­Ø¨Ø§', tentative: ' ÙŠØ§' });
  const f1 = s.handle({ type: 'speech-stream-feed', captureId: 'cap1', phraseId: 0, seq: 0, samples: b64([0.1, 0.2]) });
  const f2 = s.handle({ type: 'speech-stream-feed', captureId: 'cap1', phraseId: 0, seq: 1, samples: b64([0.3]) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fake.feedCalls.length, 1, 'second feed must wait for first to resolve');
  fake.feedDeferreds[0].resolve();
  await f1;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fake.feedCalls.length, 2);
  assert.deepEqual(sent.at(-1), { type: 'speech-stream-partial', captureId: 'cap1', phraseId: 0, seq: 0, committed: 'Ù…Ø±Ø­Ø¨Ø§', tentative: ' ÙŠØ§' });
  sent.at(-1).committed = 'mutated';
  fake.setText({ committed: 'hello', tentative: '' });
  fake.feedDeferreds[1].resolve();
  await f2;
  assert.equal(sent.at(-1).committed, 'hello');

  fake.setSnapshotText('hello final');
  await s.handle({ type: 'speech-stream-finalize', captureId: 'cap1', phraseId: 0 });
  assert.equal(fake.finalizeCount, 1);
  assert.deepEqual(sent.at(-1), { type: 'speech-stream-final', captureId: 'cap1', phraseId: 0, text: 'hello final' });

  await s.handle({ type: 'speech-stream-reset', captureId: 'cap1', phraseId: 0 });
  assert.equal(fake.resetCount, 1);
  assert.equal(fake.loadCount, 1, 'reset must not reload model');
  assert.deepEqual(sent.at(-1), { type: 'speech-stream-reset-ack', captureId: 'cap1', phraseId: 1 });
});

test('native stream cancellation during feed suppresses partial/final and disposes after settlement', async () => {
  const fake = makeFakeBinding();
  const sent = [];
  const s = createSpeechStream({ loadModel: fake.loadModel, send: (m) => sent.push(m) });
  await s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'cap2' });
  sent.length = 0;
  const feed = s.handle({ type: 'speech-stream-feed', captureId: 'cap2', phraseId: 0, seq: 0, samples: b64([0.1]) });
  await s.cancel();
  assert.equal(sent.length, 0, 'no partial after cancel');
  fake.feedDeferreds[0].resolve();
  await feed.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.disposeCount >= 1, 'model/stream disposed after settlement');
  assert.equal(sent.length, 0, 'no final/partial after settlement');
});

test('native stream thrown load/feed/finalize/reset errors propagate', async () => {
  const sent = [];
  const failingLoad = createSpeechStream({ loadModel: async () => { throw new Error('load boom'); }, send: (m) => sent.push(m) });
  await assert.rejects(failingLoad.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c' }), /load boom/);

  const fake = makeFakeBinding();
  const s = createSpeechStream({ loadModel: fake.loadModel, send: (m) => sent.push(m) });
  await s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c1' });
  fake.stream.feed = async () => { throw new Error('feed boom'); };
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c1', phraseId: 0, seq: 0, samples: b64([0.1]) }), /feed boom/);

  const fake2 = makeFakeBinding();
  const s2 = createSpeechStream({ loadModel: fake2.loadModel, send: (m) => sent.push(m) });
  await s2.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c2' });
  fake2.stream.finalize = async () => { throw new Error('final boom'); };
  await assert.rejects(s2.handle({ type: 'speech-stream-finalize', captureId: 'c2', phraseId: 0 }), /final boom/);

  const fake3 = makeFakeBinding();
  const s3 = createSpeechStream({ loadModel: fake3.loadModel, send: (m) => sent.push(m) });
  await s3.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c3' });
  await s3.handle({ type: 'speech-stream-finalize', captureId: 'c3', phraseId: 0 });
  fake3.stream.reset = () => { throw new Error('reset boom'); };
  await assert.rejects(s3.handle({ type: 'speech-stream-reset', captureId: 'c3', phraseId: 0 }), /reset boom/);
});

test('native stream validates protocol, owner/phrase/sequence, sizes, payloads and state', async () => {
  const fake = makeFakeBinding();
  const s = createSpeechStream({ loadModel: fake.loadModel, send: () => {} });
  await assert.rejects(s.handle({ type: 'speech-stream-open', protocol: 0, modelId: 'local-nemotron', captureId: 'c' }), /Invalid/);
  await s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c' });
  await assert.rejects(s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c' }), /already open/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'other', phraseId: 0, seq: 0, samples: b64([0]) }), /capture mismatch/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 1, seq: 0, samples: b64([0]) }), /phrase mismatch/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: 1, samples: b64([0]) }), /sequence mismatch/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: 0, samples: b64(new Float32Array(4097)) }), /exceeds maximum/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: 0, samples: b64([NaN]) }), /non-finite/);
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: 0, samples: '!!!' }), /Invalid PCM/);
  await assert.rejects(s.handle({ type: 'speech-stream-reset', captureId: 'c', phraseId: 0 }), /not allowed/);
});

test('native stream rejects phrase exceeding max duration and repeated finalize/invalid transitions', async () => {
  const fake = makeFakeBinding({ autoFeed: true });
  const s = createSpeechStream({ loadModel: fake.loadModel, send: () => {} });
  await s.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c' });
  // 512000 samples total allowed; pushing 125 chunks of 4096 would be 512000 - push in large steps by feeding sequentially
  for (let i = 0; i < 125; i++) {
    await s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: i, samples: b64(new Float32Array(4096).fill(0.01)) });
  }
  await assert.rejects(s.handle({ type: 'speech-stream-feed', captureId: 'c', phraseId: 0, seq: 125, samples: b64([0.1]) }), /maximum duration/);

  const fake2 = makeFakeBinding({ autoFeed: true });
  const s2 = createSpeechStream({ loadModel: fake2.loadModel, send: () => {} });
  await s2.handle({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId: 'c2' });
  await s2.handle({ type: 'speech-stream-finalize', captureId: 'c2', phraseId: 0 });
  await assert.rejects(s2.handle({ type: 'speech-stream-finalize', captureId: 'c2', phraseId: 0 }), /cannot finalize/);
});

test('frame parser handles fragmented headers/bodies and multiple frames per chunk', async () => {
  const seen = [];
  const parser = createFrameParser((m) => { seen.push(m); });
  const a = frame({ type: 'a' });
  const b = frame({ type: 'b' });
  parser(Buffer.concat([a.subarray(0, 2), b.subarray(0, 0)]));
  parser(Buffer.concat([a.subarray(2), b]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.map((m) => m.type), ['a', 'b']);
});

test('client stream adapter awaits open/partial per feed, ignores retired replies, and resolves finalize/reset/cancel', async () => {
  const listeners = { message: [], disconnect: [] };
  const posted = [];
  let disconnected = 0;
  const port = {
    postMessage(m) { posted.push(m); },
    disconnect() { disconnected += 1; },
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
  };
  globalThis.chrome = { runtime: { connectNative: () => port, lastError: null } };

  const partials = [];
  const finals = [];
  try {
    const stream = await openSpeechStream({ runtime: 'com.postora.private_terminal', captureId: 'cap', onPartial: (p) => partials.push(p), onFinal: (f) => finals.push(f) });
    assert.equal(posted[0]?.type, 'speech-stream-open');
    listeners.message[0]({ type: 'speech-stream-opened', captureId: 'cap', phraseId: 0 });
    await stream.ready;

    const feedP = stream.feed(new Float32Array([0.5]));
    for (let i = 0; i < 10 && !posted[1]; i++) await Promise.resolve();
    assert.equal(posted[1]?.type, 'speech-stream-feed');
    assert.equal(posted[1].seq, 0);
    listeners.message[0]({ type: 'speech-stream-partial', captureId: 'other', phraseId: 0, seq: 0, committed: 'x', tentative: '' });
    listeners.message[0]({ type: 'speech-stream-partial', captureId: 'cap', phraseId: 0, seq: 0, committed: 'hi', tentative: '' });
    await feedP;
    assert.deepEqual(partials, [{ phraseId: 0, seq: 0, committed: 'hi', tentative: '' }]);

    const finP = stream.finalize();
    await Promise.resolve();
    await Promise.resolve();
    listeners.message[0]({ type: 'speech-stream-final', captureId: 'cap', phraseId: 0, text: 'hello' });
    await finP;
    assert.deepEqual(finals, [{ phraseId: 0, text: 'hello' }]);

    const resetP = stream.reset();
    await Promise.resolve();
    await Promise.resolve();
    listeners.message[0]({ type: 'speech-stream-reset-ack', captureId: 'cap', phraseId: 1 });
    await resetP;
    assert.equal(stream.phraseId, 1);

    await stream.cancel();
    assert.equal(disconnected, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('client stream rejects malformed current replies and disconnect before open', async () => {
  const listeners = { message: [], disconnect: [] };
  const port = {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
  };
  globalThis.chrome = { runtime: { connectNative: () => port } };
  const errors = [];
  const stream = await openSpeechStream({ captureId: 'cap', onError: (e) => errors.push(e) });
  listeners.message[0]({ type: 'speech-stream-opened', captureId: 'cap', phraseId: 0 });
  await stream.ready;
  const finP = stream.finalize();
  await Promise.resolve();
  await Promise.resolve();
  listeners.message[0]({ type: 'error', captureId: 'cap', error: 'boom' });
  await assert.rejects(finP, /boom/);
  await stream.cancel();
  delete globalThis.chrome;

  const listeners3 = { message: [], disconnect: [] };
  const port3 = { postMessage() {}, disconnect() {}, onMessage: { addListener(fn) { listeners3.message.push(fn); } }, onDisconnect: { addListener(fn) { listeners3.disconnect.push(fn); } } };
  globalThis.chrome = { runtime: { connectNative: () => port3, lastError: { message: 'gone' } } };
  const s3 = await openSpeechStream({ captureId: 'cap3', onError: () => {} });
  listeners3.disconnect[0]();
  await assert.rejects(s3.ready, /gone|disconnect/i);
  await s3.cancel().catch(() => {});
  delete globalThis.chrome;
});

