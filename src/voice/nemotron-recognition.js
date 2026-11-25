import { openSpeechStream as defaultOpenSpeechStream } from '../native/speech-stream.js';

const DEFAULT_SILENCE_MS = 1200;
const MIN_SILENCE_MS = 600;
const MAX_SILENCE_MS = 2000;
const MAX_PHRASE_SAMPLES = 512000;
const MAX_QUEUED_SAMPLES = 32000;
const SPEECH_RMS = 0.012;

function clampSilence(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_SILENCE_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, n));
}

export function createNemotronRecognition({
  openSpeechStream = defaultOpenSpeechStream,
  createCaptureId = () => globalThis.crypto?.randomUUID?.() || `cap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContext: Context = globalThis.AudioContext || globalThis.webkitAudioContext,
  WorkletNode = globalThis.AudioWorkletNode,
  chrome: chromeApi = globalThis.chrome,
  getWorkletUrl = () => chromeApi?.runtime?.getURL?.('src/voice/pcm-worklet.js'),
  endSilenceMs = DEFAULT_SILENCE_MS,
  now = () => Date.now(),
  setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis),
  speechThreshold = SPEECH_RMS,
} = {}) {
  let epoch = 0;
  let activeEpoch = 0;
  let stream = null;
  let mediaStream = null;
  let audioContext = null;
  let workletNode = null;
  let sourceNode = null;
  let gainNode = null;
  let phraseIndex = 0;
  let currentPhraseId = 0;
  let results = [];
  let currentText = { committed: '', tentative: '' };
  let inFlight = null;
  let inFlightSamples = 0;
  let queued = [];
  let queuedSamples = 0;
  let phraseSamples = 0;
  let heardSpeech = false;
  let silenceTimer = null;
  let phraseLimitTimer = null;
  let finishing = false;
  let draining = false;
  let startPromise = null;
  let captureRetired = false;

  const silenceMs = clampSilence(endSilenceMs);

  const api = {
    continuous: false,
    interimResults: true,
    maxAlternatives: 1,
    lang: '',
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,
    onprocessing: null,
  };

  function active() { return activeEpoch === epoch && !captureRetired; }

  function clearSilenceTimer() {
    if (silenceTimer != null) { clearTimer(silenceTimer); silenceTimer = null; }
  }

  function clearPhraseLimitTimer() {
    if (phraseLimitTimer != null) { clearTimer(phraseLimitTimer); phraseLimitTimer = null; }
  }

  async function teardown(closeStream = true) {
    clearSilenceTimer();
    clearPhraseLimitTimer();
    captureRetired = true;
    const s = stream; stream = null;
    const ms = mediaStream; mediaStream = null;
    const ctx = audioContext; audioContext = null;
    const wn = workletNode; workletNode = null;
    try { wn?.port && (wn.port.onmessage = null); } catch {}
    try { wn?.disconnect?.(); } catch {}
    try { sourceNode?.disconnect?.(); } catch {}
    try { gainNode?.disconnect?.(); } catch {}
    sourceNode = null; gainNode = null;
    try { ms?.getTracks?.().forEach((t) => t.stop()); } catch {}
    if (ctx) { try { await ctx.close?.(); } catch {} }
    if (closeStream && s) { try { await s.cancel?.(); } catch {} }
  }

  function fail(code, message) {
    if (captureRetired) return;
    try { api.onerror?.({ error: code, message }); } catch {}
    retireEpoch();
    void teardown(true).then(() => { try { api.onend?.(); } catch {} });
  }

  function retireEpoch() {
    epoch += 1;
    captureRetired = true;
  }

  function emitResult(text, isFinal) {
    if (!active()) return;
    const transcript = String(text ?? '');
    const result = Object.assign([{ transcript }], { isFinal: !!isFinal });
    results[phraseIndex] = result;
    try { api.onresult?.({ resultIndex: phraseIndex, results: results.slice() }); } catch {}
    if (isFinal) phraseIndex += 1;
  }

  function combinedText() {
    const c = String(currentText.committed ?? '');
    const t = String(currentText.tentative ?? '');
    return `${c}${t}`;
  }

  async function processQueue() {
    if (captureRetired || !stream) return;
    // While the current phrase is being closed, the audio of the next phrase
    // waits: the model takes one phrase at a time.
    if (finishing && !draining) return;
    while (!captureRetired && stream && !inFlight && queued.length) {
      const item = queued.shift();
      queuedSamples -= item.samples.length;
      inFlightSamples = item.samples.length;
      inFlight = stream.feed(item.samples);
      try {
        await inFlight;
      } catch (e) {
        inFlight = null;
        inFlightSamples = 0;
        fail('audio-capture', e?.message || 'Nemotron feed failed.');
        return;
      }
      inFlight = null;
      inFlightSamples = 0;
      if (captureRetired) return;
    }
  }

  async function finishPhrase() {
    if (captureRetired || finishing) return;
    finishing = true;
    clearSilenceTimer();
    clearPhraseLimitTimer();
    try {
      // The audio that is already in belongs to this phrase: it is fed before
      // the phrase is closed.
      draining = true;
      while (inFlight) await inFlight.catch(() => {});
      await processQueue();
      while (inFlight) await inFlight.catch(() => {});
      draining = false;
      if (captureRetired) return;
      await stream.finalize();
    } catch (e) {
      draining = false;
      finishing = false;
      fail('audio-capture', e?.message || 'Nemotron finalize failed.');
      return;
    }
    if (captureRetired) return;
    // The final text arrives on its own; the capture stays closed until the
    // model is ready for the next phrase.
  }

  function scheduleSilenceFinalize() {
    clearSilenceTimer();
    if (!heardSpeech || captureRetired) return;
    silenceTimer = setTimer(() => {
      silenceTimer = null;
      if (!active() || !heardSpeech) return;
      void finishPhrase();
    }, silenceMs);
  }

  function schedulePhraseLimit() {
    clearPhraseLimitTimer();
    phraseLimitTimer = setTimer(() => {
      phraseLimitTimer = null;
      if (!active() || !heardSpeech) return;
      void finishPhrase();
    }, 30000);
  }

  function onStreamPartial(msg) {
    if (!active() || captureRetired) return;
    if (msg?.phraseId !== currentPhraseId) return;
    currentText = { committed: String(msg.committed ?? ''), tentative: String(msg.tentative ?? '') };
    const text = combinedText();
    if (!text && !heardSpeech) return;
    try { api.onprocessing?.(); } catch {}
    emitResult(text, false);
  }

  async function onStreamFinal(msg) {
    if (!active() || captureRetired) return;
    if (msg?.phraseId !== currentPhraseId) return;
    const text = String(msg.text ?? '').trim();
    // The phrase is closed: the text starts empty and the next one is
    // counted from its own first sample.
    currentText = { committed: '', tentative: '' };
    heardSpeech = false;
    phraseSamples = 0;
    inFlightSamples = 0;
    if (text) emitResult(text, true);
    if (!api.continuous) {
      retireEpoch();
      void teardown(true).then(() => { if (captureRetired) try { api.onend?.(); } catch {} });
      return;
    }
    try {
      // The model is reset before the next phrase is fed. The audio that
      // arrived in the meantime waits for the reset to be answered.
      await stream.reset();
      if (captureRetired) return;
      currentPhraseId = stream.phraseId ?? (currentPhraseId + 1);
      finishing = false;
      void processQueue();
    } catch (e) {
      finishing = false;
      fail('audio-capture', e?.message || 'Nemotron reset failed.');
    }
  }

  function onStreamError(error) {
    if (captureRetired) return;
    fail('audio-capture', error?.message || String(error || 'Nemotron speech stream failed.'));
  }

  function enqueueSamples(samples) {
    if (captureRetired) return;
    const len = samples?.length || 0;
    if (len <= 0) return;
    if (phraseSamples + len > MAX_PHRASE_SAMPLES) {
      // phrase limit reached - finalize spoken phrase
      if (heardSpeech) void finishPhrase();
      else fail('audio-capture', 'Nemotron phrase exceeded maximum duration.');
      return;
    }
    const buffered = inFlightSamples + queuedSamples;
    if (buffered + len > MAX_QUEUED_SAMPLES) {
      fail('audio-capture', 'Nemotron audio buffer overflow.');
      void stream?.cancel?.().catch(() => {});
      return;
    }
    phraseSamples += len;
    queuedSamples += len;
    queued.push({ samples });
    void processQueue();
  }

  function handleChunkMessage(data) {
    if (!active() || captureRetired) return;
    if (!data || data.type !== 'pcm') return;
    const samples = data.samples instanceof Float32Array ? data.samples : (data.samples ? Float32Array.from(data.samples) : new Float32Array(0));
    const rms = Number.isFinite(data.rms) ? data.rms : 0;
    if (rms >= speechThreshold) {
      heardSpeech = true;
      clearSilenceTimer();
      if (!phraseLimitTimer) schedulePhraseLimit();
    } else if (heardSpeech) {
      scheduleSilenceFinalize();
    }
    try { api.onprocessing?.(); } catch {}
    enqueueSamples(samples);
  }

  api.start = () => {
    if (startPromise || (!captureRetired && stream)) return;
    captureRetired = false;
    activeEpoch = epoch;
    const myEpoch = epoch;
    startPromise = (async () => {
      try {
        const captureId = createCaptureId();
        const s = await openSpeechStream({ captureId, onPartial: onStreamPartial, onFinal: (m) => { void onStreamFinal(m); }, onError: onStreamError });
        if (myEpoch !== epoch) { try { await s.cancel(); } catch {} return; }
        stream = s;
        await s.ready;
        if (myEpoch !== epoch) { await teardown(true); return; }
        currentPhraseId = s.phraseId ?? 0;

        if (!Context || !mediaDevices?.getUserMedia) throw new Error('Audio capture is unavailable.');
        const ms = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (myEpoch !== epoch) { try { ms.getTracks().forEach((t)=>t.stop()); } catch {} await teardown(true); return; }
        mediaStream = ms;

        const ctx = new Context();
        if (myEpoch !== epoch) { try { ms.getTracks().forEach((t)=>t.stop()); } catch {} try { await ctx.close(); } catch {} await teardown(true); return; }
        audioContext = ctx;
        const workletUrl = getWorkletUrl?.();
        if (workletUrl) await ctx.audioWorklet.addModule(workletUrl, { type: 'module' });
        if (myEpoch !== epoch) { await teardown(true); return; }

        const src = ctx.createMediaStreamSource(ms);
        const NodeCtor = WorkletNode || globalThis.AudioWorkletNode;
        if (!NodeCtor) throw new Error('AudioWorkletNode is unavailable.');
        const wn = new NodeCtor(ctx, 'pcm-capture', { processorOptions: { inputRate: ctx.sampleRate } });
        const gain = ctx.createGain();
        gain.gain.value = 0;
        wn.port.onmessage = (e) => handleChunkMessage(e.data);
        src.connect(wn);
        wn.connect(gain);
        gain.connect(ctx.destination);
        sourceNode = src; workletNode = wn; gainNode = gain;

        try { api.onstart?.(); } catch {}
      } catch (e) {
        if (myEpoch !== epoch) return;
        fail('audio-capture', e?.message || 'Nemotron speech capture failed.');
      } finally {
        startPromise = null;
      }
    })();
  };

  api.stop = () => {
    if (captureRetired) return;
    retireEpoch();
    void teardown(true).then(() => { try { api.onend?.(); } catch {} });
  };

  api.abort = () => {
    if (captureRetired) return;
    retireEpoch();
    void teardown(true).then(() => { try { api.onend?.(); } catch {} });
  };

  return api;
}
