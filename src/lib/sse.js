// Server-Sent Events parsing shared by every streaming provider.

/**
 * Splits a growing SSE text buffer into complete events.
 * Returns the parsed events and whatever trailing text is not yet a full event.
 */
export function parseSseChunk(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

// A model call that sends nothing for this long is treated as failed, so a hung
// provider ends the step (or hands it to the backup) instead of stalling the task.
// Generous on purpose: reasoning models can think for minutes before a token.
export const MODEL_IDLE_MS = 180000;

export class StalledError extends Error {
  constructor(ms, phase = null) {
    super(`The model sent nothing for ${Math.round(ms / 1000)} s${phase === 'headers' ? ' while waiting for response headers' : phase === 'stream' ? ' while waiting for stream data' : ''}, so the request was stopped. Try again, pick a faster model or a lower reasoning effort, or turn on a backup provider.`);
    this.name = 'StalledError';
    this.phase = phase;
  }
}

/**
 * fetch for a model request that gives up when the response headers take longer
 * than `idleMs`. The caller's signal still stops it as before (AbortError).
 */
export async function fetchModel(url, init, idleMs = MODEL_IDLE_MS) {
  const controller = new AbortController();
  const outer = init.signal;
  if (outer?.aborted) controller.abort(outer.reason);
  outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  const timer = setTimeout(() => controller.abort(new StalledError(idleMs, 'headers')), idleMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Yields `{event, data}` objects from a fetch Response body; stops after `idleMs`
 * without an event. Keep-alive comments (": ping") are not events, so a provider
 * that only pings while the model is stuck still runs into the limit.
 */
export async function* readSse(response, signal, { idleMs = MODEL_IDLE_MS } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let deadline = Date.now() + idleMs;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { value, done } = await readWithin(reader, Math.max(0, deadline - Date.now()), idleMs, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      if (events.length) deadline = Date.now() + idleMs;
      yield* events;
    }
    buffer += decoder.decode();
    const { events } = parseSseChunk(buffer + '\n\n');
    yield* events;
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One read, given up after `ms`; `idleMs` is the limit named in the error. */
function readWithin(reader, ms, idleMs, signal) {
  let timer;
  let onAbort;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new StalledError(idleMs, 'stream')); // first: cancelling settles the pending read as done
      reader.cancel().catch(() => {});
    }, ms);
  });
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      reader.cancel().catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([reader.read(), stalled, aborted]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}
