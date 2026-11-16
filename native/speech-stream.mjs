const MAX_SAMPLES = 4096;
const MAX_PHRASE_SAMPLES = 512000;
const MAX_TEXT = 32000;

function clampText(value) {
  const text = String(value ?? '');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function validateCaptureId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128;
}

function decodeSamples(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid PCM payload.');
  // The size is refused before the payload is decoded: a chunk that is too
  // large must not be turned into memory first.
  if (encoded.length > Math.ceil((MAX_SAMPLES * 4) / 3) * 4 + 4) throw new Error('PCM chunk exceeds maximum size.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error('Invalid PCM payload length.');
  const count = bytes.length / 4;
  if (count > MAX_SAMPLES) throw new Error('PCM chunk exceeds maximum size.');
  const samples = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) throw new Error('PCM chunk contains non-finite samples.');
    samples[i] = value;
  }
  return samples;
}

export function createSpeechStream({ loadModel, send, modelOptions = {}, streamOptions = {} } = {}) {
  let closed = false;
  let captureId = null;
  let phraseId = 0;
  let seq = 0;
  let phraseSamples = 0;
  let state = 'opening';
  let model = null;
  let stream = null;
  let chain = Promise.resolve();

  const safeSend = (message) => { if (!closed) send(message); };
  const close = async () => {
    if (closed) return;
    closed = true;
    state = 'closed';
    try { stream?.reset?.(); } catch {}
    try { stream?.[Symbol.dispose]?.(); } catch {}
    try { model?.dispose?.(); } catch {}
    stream = null;
    model = null;
  };

  const ensureOpen = async (message) => {
    if (message.protocol !== 1 || message.modelId !== 'local-nemotron' || !validateCaptureId(message.captureId)) {
      throw new Error('Invalid speech stream open request.');
    }
    if (typeof loadModel !== 'function') throw new Error('Nemotron runtime is unavailable.');
    model = await loadModel(modelOptions);
    // The stream slot of the model is part of how it is served: the family
    // extension and the language come from the loader, not from the caller.
    stream = await model.createSession().stream(streamOptions);
    captureId = message.captureId;
    phraseId = 0;
    seq = 0;
    phraseSamples = 0;
    state = 'idle';
    safeSend({ type: 'speech-stream-opened', protocol: 1, captureId, phraseId });
  };

  const expect = (message, types) => {
    if (!types.includes(message.type)) throw new Error(`Unexpected speech stream message: ${message.type}`);
    if (message.captureId !== captureId) throw new Error('Speech stream capture mismatch.');
  };

  const readPartial = () => {
    const text = stream?.text || {};
    return { committed: clampText(text.committed ?? ''), tentative: clampText(text.tentative ?? '') };
  };

  const run = (operation) => {
    const job = chain.then(operation, operation);
    chain = job.catch(() => {});
    return job;
  };

  async function handle(message) {
    if (closed) return;
    if (message?.type === 'speech-stream-open') {
      if (captureId) throw new Error('Speech stream already open.');
      await run(() => ensureOpen(message));
      return;
    }
    if (!captureId) throw new Error('Speech stream is not open.');
    if (message?.type === 'speech-stream-feed') {
      expect(message, ['speech-stream-feed']);
      if (message.phraseId !== phraseId) throw new Error('Speech stream phrase mismatch.');
      if (message.seq !== seq) throw new Error('Speech stream sequence mismatch.');
      if (state !== 'idle' && state !== 'feeding') throw new Error('Speech stream is not accepting audio.');
      const samples = decodeSamples(message.samples);
      phraseSamples += samples.length;
      if (phraseSamples > MAX_PHRASE_SAMPLES) throw new Error('Phrase exceeds maximum duration.');
      // The sequence moves on when the frame is accepted: the frames that
      // follow it are the ones this capture sends.
      seq += 1;
      await run(async () => {
        state = 'feeding';
        try {
          await stream.feed(samples);
          if (!closed) safeSend({ type: 'speech-stream-partial', captureId, phraseId, seq: message.seq, ...readPartial() });
        } finally {
          if (!closed && state === 'feeding') state = 'idle';
        }
      });
      return;
    }
    if (message?.type === 'speech-stream-finalize') {
      expect(message, ['speech-stream-finalize']);
      if (message.phraseId !== phraseId) throw new Error('Speech stream phrase mismatch.');
      if (state !== 'idle' && state !== 'feeding') throw new Error('Speech stream cannot finalize now.');
      await run(async () => {
        state = 'finalizing';
        await stream.finalize();
        if (closed) return;
        const snapshot = stream.snapshot || {};
        const text = clampText(snapshot.text ?? stream.text?.full ?? stream.text?.committed ?? '');
        safeSend({ type: 'speech-stream-final', captureId, phraseId, text });
        state = 'awaiting-reset';
      });
      return;
    }
    if (message?.type === 'speech-stream-reset') {
      expect(message, ['speech-stream-reset']);
      if (message.phraseId !== phraseId) throw new Error('Speech stream phrase mismatch.');
      if (state !== 'awaiting-reset') throw new Error('Speech stream reset is not allowed now.');
      await run(async () => {
        stream.reset();
        if (closed) return;
        phraseId += 1;
        seq = 0;
        phraseSamples = 0;
        state = 'idle';
        safeSend({ type: 'speech-stream-reset-ack', captureId, phraseId });
      });
      return;
    }
    throw new Error(`Unknown speech stream message: ${message?.type}`);
  }

  async function cancel() {
    if (closed) return;
    closed = true;
    state = 'closed';
    // Do not send partial/final after cancellation; best-effort dispose after in-flight operations settle.
    chain.catch(() => {}).finally(async () => {
      try { stream?.reset?.(); } catch {}
      try { stream?.[Symbol.dispose]?.(); } catch {}
      try { model?.dispose?.(); } catch {}
    });
  }

  return { handle, cancel, get closed() { return closed; } };
}
