import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNemotronRecognition } from '../src/voice/nemotron-recognition.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function wait(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
async function flush(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }

function makeClock(start = 0) {
  let t = start;
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimeout(fn, ms) { const i = ++id; timers.set(i, { at: t + ms, fn, type: 'timeout' }); return i; },
    clearTimeout(i) { timers.delete(i); },
    setInterval(fn, ms) { const i = ++id; timers.set(i, { at: t + ms, fn, type: 'interval', ms }); return i; },
    clearInterval(i) { timers.delete(i); },
    async tick(ms) {
      t += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a,b)=>a[1].at-b[1].at || a[0]-b[0]);
        for (const [i, v] of due) {
          if (!timers.has(i)) continue;
          if (v.type === 'timeout') timers.delete(i); else v.at = t + v.ms;
          v.fn();
          progressed = true;
          await flush(2);
        }
      }
    },
  };
}

function makeEnvironment({ openStreamImpl, clock = makeClock(), endSilenceMs = 1200 } = {}) {
  const events = { result: [], error: [], end: 0, start: 0, processing: 0 };
  const tracks = [];
  const contexts = [];
  const worklets = [];
  const ports = [];
  const streamCalls = { open: 0, feeds: [], finalizes: 0, resets: 0, cancels: 0 };
  let partialHandler = null;
  let finalHandler = null;
  let errorHandler = null;

  const stream = {
    phraseId: 0,
    ready: Promise.resolve(),
    feed: async (samples) => { streamCalls.feeds.push(samples); if (stream.feedGate) await stream.feedGate.promise; },
    finalize: async () => { streamCalls.finalizes += 1; return {}; },
    reset: async () => { streamCalls.resets += 1; if (stream.resetGate) await stream.resetGate.promise; stream.phraseId += 1; return {}; },
    cancel: async () => { streamCalls.cancels += 1; },
  };

  const openSpeechStream = openStreamImpl || (async (opts) => {
    streamCalls.open += 1;
    partialHandler = opts.onPartial;
    finalHandler = opts.onFinal;
    errorHandler = opts.onError;
    return stream;
  });

  const mediaDevices = {
    getUserMedia: async () => {
      const track = { stopCount: 0, stop() { this.stopCount += 1; } };
      tracks.push(track);
      return { getTracks: () => [track] };
    },
  };

  class FakeWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage() {},
        start() {},
        close() {},
      };
      this.connectedTo = null;
      ports.push(this);
    }
    connect(dest) { this.connectedTo = dest; }
    disconnect() { this.connectedTo = null; }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.audioWorklet = {
        addModule: async (url) => { worklets.push(url); },
      };
      this.destination = { kind: 'destination' };
      contexts.push(this);
    }
    createMediaStreamSource() { return { connect(node) { this.node = node; }, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect(dest) { this.dest = dest; }, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }

  class FakeWorkletNodeCtor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage() {},
        start() {},
        close() {},
      };
      this.connectedTo = null;
      ports.push(this);
    }
    connect(dest) { this.connectedTo = dest; }
    disconnect() { this.connectedTo = null; }
  }

  const chromeObj = { runtime: { getURL: (p) => `chrome-extension://id/${p}` } };

  const api = createNemotronRecognition({
    openSpeechStream,
    mediaDevices,
    AudioContext: FakeAudioContext,
    WorkletNode: FakeWorkletNodeCtor,
    chrome: chromeObj,
    endSilenceMs,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });

  api.onresult = (e) => events.result.push(e);
  api.onerror = (e) => events.error.push(e);
  api.onend = () => { events.end += 1; };
  api.onstart = () => { events.start += 1; };
  api.onprocessing = () => { events.processing += 1; };

  function worklet() { return ports[ports.length - 1]; }
  function emitChunk(samples, rms = 0.1) {
    const node = worklet();
    node.port.onmessage?.({ data: { type: 'pcm', samples, rms } });
  }
  async function emitSpeech(samples = new Float32Array(512).fill(0.2), rms = 0.2) {
    emitChunk(samples, rms);
    await flush(6);
  }
  async function emitSilence(samples = new Float32Array(512), rms = 0) {
    emitChunk(samples, rms);
    await flush(6);
  }

  return { api, events, tracks, contexts, worklets, ports, stream, streamCalls, clock, partialHandler: () => partialHandler, finalHandler: () => finalHandler, errorHandler: () => errorHandler, emitChunk, emitSpeech, emitSilence, worklet };
}

test('Nemotron delivers Arabic and English partials before finalize, then two finals with resultIndex 0 and 1', async () => {
  const env = makeEnvironment({ endSilenceMs: 600 });
  env.api.continuous = true;
  env.api.start();
  await flush(12);
  assert.equal(env.events.start, 1);
  assert.equal(env.streamCalls.open, 1, 'hands-free/model stream opens once');
  assert.equal(env.worklets.length, 1);

  await env.emitSpeech();
  env.partialHandler()({ phraseId: 0, seq: 0, committed: 'مرحبا', tentative: ' يا' });
  await flush(4);
  assert.ok(env.events.result.length >= 1);
  assert.equal(env.events.result.at(-1).resultIndex, 0);
  assert.equal(env.events.result.at(-1).results[0].isFinal, false);
  assert.equal(env.events.result.at(-1).results[0][0].transcript, 'مرحبا يا');

  await env.emitSilence();
  await env.clock.tick(700);
  await flush(8);
  env.finalHandler()({ phraseId: 0, text: 'مرحبا يا عالم' });
  await flush(8);
  const firstFinal = env.events.result.findLast((e) => e.results[0]?.isFinal);
  assert.ok(firstFinal, 'expected first final');
  assert.equal(firstFinal.resultIndex, 0);
  assert.equal(firstFinal.results[0][0].transcript, 'مرحبا يا عالم');

  // second phrase
  await env.emitSpeech();
  env.partialHandler()({ phraseId: 1, seq: 0, committed: 'hello', tentative: ' there' });
  await flush(4);
  const partial2 = env.events.result.at(-1);
  assert.equal(partial2.resultIndex, 1);
  assert.equal(partial2.results.length, 2, 'cumulative results kept');
  assert.equal(partial2.results[0].isFinal, true);
  assert.equal(partial2.results[1].isFinal, false);

  await env.emitSilence();
  await env.clock.tick(700);
  await flush(8);
  env.finalHandler()({ phraseId: 1, text: 'hello there' });
  await flush(8);
  const final2 = env.events.result.at(-1);
  assert.equal(final2.resultIndex, 1);
  assert.equal(final2.results[1].isFinal, true);
  assert.equal(final2.results[1][0].transcript, 'hello there');
  assert.equal(env.streamCalls.open, 1, 'model not reloaded for second phrase');
});

test('silence finalizes once and empty silence does not command', async () => {
  const env = makeEnvironment({ endSilenceMs: 600 });
  env.api.continuous = true;
  env.api.start();
  await flush(12);

  await env.emitSilence();
  await env.clock.tick(2000);
  await flush(8);
  assert.equal(env.streamCalls.finalizes, 0);
  assert.equal(env.events.result.filter((e) => e.results[e.resultIndex]?.isFinal).length, 0);

  await env.emitSpeech();
  await env.emitSilence();
  await env.clock.tick(700);
  await flush(8);
  env.finalHandler()({ phraseId: 0, text: 'ok' });
  await flush(8);
  await env.emitSilence();
  await env.clock.tick(2000);
  await flush(8);
  const finals = env.events.result.filter((e) => e.results[e.resultIndex]?.isFinal);
  assert.equal(finals.length, 1, 'silence must finalize once');
});

test('the audio of the next phrase waits until the reset is answered', async () => {
  const env = makeEnvironment({ endSilenceMs: 600 });
  env.api.continuous = true;
  env.api.start();
  await flush(12);

  await env.emitSpeech();
  await env.emitSilence();
  await env.clock.tick(700);
  await flush(8);
  assert.equal(env.streamCalls.finalizes, 1, 'the silence closed the phrase');

  // The model is reset before the next phrase is fed.
  env.stream.resetGate = deferred();
  env.finalHandler()({ phraseId: 0, text: 'first phrase' });
  await flush(8);
  assert.equal(env.streamCalls.resets, 1);

  // Audio that arrives while the reset is pending waits: the model takes one
  // phrase at a time.
  const feedsBefore = env.streamCalls.feeds.length;
  await env.emitSpeech();
  await flush(6);
  assert.equal(env.streamCalls.feeds.length, feedsBefore, 'the next phrase waits for the reset');

  env.stream.resetGate.resolve();
  await flush(10);
  assert.ok(env.streamCalls.feeds.length > feedsBefore, 'the waiting audio is fed after the reset');
  assert.equal(env.streamCalls.open, 1, 'the model is not loaded again');
});

test('overflow fails and 30-second phrase limit finalizes', async () => {
  const env = makeEnvironment({ endSilenceMs: 5000 });
  env.api.start();
  await flush(12);
  env.stream.feedGate = deferred();
  // push enough chunks to exceed queued/in-flight budget (<=32000 queued samples)
  for (let i = 0; i < 20; i++) { env.emitChunk(new Float32Array(4096).fill(0.1), 0.1); await flush(1); }
  await flush(8);
  assert.ok(env.events.error.some((e) => e?.error === 'audio-capture' || /overflow|buffer/i.test(String(e?.message || e?.error || ''))), 'expected overflow error');
  assert.ok(env.streamCalls.cancels >= 1 || env.events.end >= 1);

  const env2 = makeEnvironment({ endSilenceMs: 5000 });
  env2.api.continuous = true;
  env2.api.start();
  await flush(12);
  await env2.emitSpeech();
  // simulate 30s phrase duration by feeding duration samples (512000 max)
  for (let i = 0; i < 130; i++) { // 130 * 4096 > 512000
    env2.stream.feed = async () => {};
    env2.emitChunk(new Float32Array(4096).fill(0.05), 0.05);
    await flush(1);
  }
  await flush(12);
  assert.ok(env2.streamCalls.finalizes >= 1 || env2.events.error.length >= 0, '30s phrase limit must finalize or fail safely');
  assert.ok(env2.streamCalls.finalizes >= 1, '30s phrase limit must finalize spoken phrase');
});

test('close/pause/session retirement suppresses late events and closes tracks/context once', async () => {
  const env = makeEnvironment({ endSilenceMs: 600 });
  env.api.continuous = true;
  env.api.start();
  await flush(12);
  await env.emitSpeech();
  env.partialHandler()({ phraseId: 0, seq: 0, committed: 'hi', tentative: '' });
  await flush(4);
  const resultsBefore = env.events.result.length;
  env.api.abort();
  await flush(8);
  env.partialHandler()({ phraseId: 0, seq: 1, committed: 'late', tentative: '' });
  env.finalHandler()({ phraseId: 0, text: 'late final' });
  env.errorHandler()?.(new Error('late'));
  await flush(6);
  assert.equal(env.events.result.length, resultsBefore, 'late events suppressed after retirement');
  assert.equal(env.tracks[0].stopCount, 1);
  assert.equal(env.contexts[0].state, 'closed');
  assert.ok(env.streamCalls.cancels >= 1);
});

test('noncontinuous emits final then onend', async () => {
  const env = makeEnvironment({ endSilenceMs: 600 });
  env.api.continuous = false;
  env.api.start();
  await flush(12);
  await env.emitSpeech();
  env.partialHandler()({ phraseId: 0, seq: 0, committed: 'one', tentative: '' });
  await flush(4);
  await env.emitSilence();
  await env.clock.tick(700);
  await flush(8);
  env.finalHandler()({ phraseId: 0, text: 'one' });
  await flush(10);
  assert.ok(env.events.result.some((e) => e.results[0]?.isFinal));
  assert.ok(env.events.end >= 1);
});
