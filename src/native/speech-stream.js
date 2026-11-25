import { createPort } from './client.js';

function encodeSamples(samples) {
  const owned = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  const bytes = new Uint8Array(owned.buffer, owned.byteOffset, owned.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function openSpeechStream({ runtime = 'com.postora.private_terminal', captureId, onPartial, onFinal, onError, signal } = {}) {
  if (!captureId) throw new Error('captureId is required.');
  const port = await createPort(runtime);
  let opened = false;
  let openResolve;
  let openReject;
  let feedResolve;
  let feedReject;
  let finalizeResolve;
  let finalizeReject;
  let resetResolve;
  let resetReject;
  let currentSeq = -1;
  let currentPhraseId = 0;
  let closed = false;

  const ready = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  let handshakeTimer;

  const fail = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    try { port.disconnect(); } catch {}
    openReject?.(error); feedReject?.(error); finalizeReject?.(error); resetReject?.(error);
    onError?.(error);
  };

  handshakeTimer = setTimeout(() => {
    if (!opened) fail(new Error('Nemotron native host did not respond. Update or reinstall the private host.'));
  }, 10000);

  port.onDisconnect.addListener(() => {
    clearTimeout(handshakeTimer);
    const err = globalThis.chrome?.runtime?.lastError || new Error('Native speech stream disconnected.');
    if (!opened) openReject?.(err instanceof Error ? err : new Error(err.message || String(err)));
    fail(err instanceof Error ? err : new Error(err.message || String(err)));
  });

  port.onMessage.addListener((message) => {
    if (closed) return;
    if (message?.captureId && message.captureId !== captureId) return;
    if (message?.type === 'speech-stream-opened') {
      opened = true;
      currentPhraseId = message.phraseId ?? 0;
      clearTimeout(handshakeTimer);
      openResolve?.();
      return;
    }
    if (message?.type === 'speech-stream-partial') {
      if (message.phraseId !== currentPhraseId) return;
      if (message.seq === currentSeq) feedResolve?.();
      onPartial?.({ phraseId: message.phraseId, seq: message.seq, committed: String(message.committed ?? ''), tentative: String(message.tentative ?? '') });
      return;
    }
    if (message?.type === 'speech-stream-final') {
      if (message.phraseId !== currentPhraseId) return;
      onFinal?.({ phraseId: message.phraseId, text: String(message.text ?? '') });
      finalizeResolve?.(message);
      return;
    }
    if (message?.type === 'speech-stream-reset-ack') {
      currentPhraseId = message.phraseId;
      // The host starts the next phrase at sequence 0.
      currentSeq = -1;
      resetResolve?.(message);
      return;
    }
    if (message?.type === 'error') {
      fail(new Error(message.error || 'Nemotron speech stream failed.'));
    }
  });

  try {
    port.postMessage({ type: 'speech-stream-open', protocol: 1, modelId: 'local-nemotron', captureId });
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }

  signal?.addEventListener('abort', () => cancel().catch(() => {}), { once: true });

  async function feed(samples) {
    await ready;
    if (closed) throw new Error('Speech stream is closed.');
    const seq = currentSeq + 1;
    currentSeq = seq;
    const payload = { type: 'speech-stream-feed', captureId, phraseId: currentPhraseId, seq, samples: encodeSamples(samples) };
    await new Promise((resolve, reject) => {
      feedResolve = resolve; feedReject = reject;
      try { port.postMessage(payload); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  async function finalize() {
    await ready;
    if (closed) throw new Error('Speech stream is closed.');
    return new Promise((resolve, reject) => {
      finalizeResolve = resolve;
      finalizeReject = reject;
      try { port.postMessage({ type: 'speech-stream-finalize', captureId, phraseId: currentPhraseId }); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  async function reset() {
    await ready;
    if (closed) throw new Error('Speech stream is closed.');
    return new Promise((resolve, reject) => {
      resetResolve = resolve; resetReject = reject;
      try { port.postMessage({ type: 'speech-stream-reset', captureId, phraseId: currentPhraseId }); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  async function cancel() {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    const error = new Error('Speech stream cancelled.');
    try { openReject?.(error); } catch {}
    try { feedReject?.(error); } catch {}
    try { finalizeReject?.(error); } catch {}
    try { resetReject?.(error); } catch {}
    try { port.disconnect(); } catch {}
  }

  return { ready, feed, finalize, reset, cancel, get phraseId() { return currentPhraseId; } };
}
