// One native process per command. On cancellation or timeout, the client sends
// `{ type: 'cancel' }` and waits briefly for the host's confirmed-stop reply
// before disconnecting. Until the host confirms that the operation stopped
// before committing any side effect, a dispatched command's outcome is unknown.
export const HOST_NAME = 'com.postora.private_terminal';
const CANCEL_CONFIRM_WAIT_MS = 350;

export async function createPort(runtimeName = HOST_NAME, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.connectNative) throw new Error('Native messaging is unavailable.');
  return runtime.connectNative(runtimeName);
}

function unknownTargetHint(type) {
  if (type === 'project-write') {
    return 'Read the file with project_read and compare its hash before repeating the write.';
  }
  return 'Check the command\'s effect or the file state before repeating the action; do not repeat it automatically.';
}

function makeNativeAbortError({ outcome, reason, type }) {
  const why = reason === 'timeout' ? 'The command timed out' : 'The task was stopped';
  if (outcome === 'cancelled') {
    const err = new Error(`${why} before the native command was sent (outcome: cancelled).`);
    err.outcome = 'cancelled';
    return err;
  }
  if (outcome === 'stopped') {
    const err = new Error(`${why}; the native host confirmed the operation was stopped before committing (outcome: stopped).`);
    err.outcome = 'stopped';
    return err;
  }
  const err = new Error(`${why} after the native command was sent; its outcome is unknown because the native host did not confirm a clean stop before commit (outcome: unknown). ${unknownTargetHint(type)}`);
  err.outcome = 'unknown';
  return err;
}

export function runNativeCommand(args, { signal = null, runtime = globalThis.chrome?.runtime, confirmWaitMs = CANCEL_CONFIRM_WAIT_MS } = {}) {
  return nativeRequest({ type: 'run', ...args }, { signal, runtime, confirmWaitMs });
}

export function nativeRequest(message, { signal = null, runtime = globalThis.chrome?.runtime, onProgress = null, confirmWaitMs = CANCEL_CONFIRM_WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const abortReason = () => (signal?.reason === 'timeout' || signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'stopped');
    if (signal?.aborted) {
      return reject(makeNativeAbortError({ outcome: 'cancelled', reason: abortReason(), type: message?.type }));
    }
    let port;
    let done = false;
    let dispatched = false;
    let cancelling = false;
    let cancelTimer = null;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(cancelTimer);
      signal?.removeEventListener('abort', cancel);
      try { port?.disconnect(); } catch { /* Already disconnected. */ }
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => {
      if (done || cancelling) return;
      if (!dispatched) {
        finish(makeNativeAbortError({ outcome: 'cancelled', reason: abortReason(), type: message?.type }));
        return;
      }
      cancelling = true;
      let postedCancel = false;
      try {
        port?.postMessage({ type: 'cancel' });
        postedCancel = true;
      } catch {
        postedCancel = false;
      }
      if (!postedCancel || !(confirmWaitMs > 0)) {
        finish(makeNativeAbortError({ outcome: 'unknown', reason: abortReason(), type: message?.type }));
        return;
      }
      cancelTimer = setTimeout(() => {
        finish(makeNativeAbortError({ outcome: 'unknown', reason: abortReason(), type: message?.type }));
      }, confirmWaitMs);
    };
    try {
      port = runtime.connectNative(HOST_NAME);
      port.onMessage.addListener((reply) => {
        if (reply?.type === 'progress') {
          if (!cancelling) onProgress?.(reply);
          return;
        }
        if (reply?.cancelled) {
          const outcome = reply.outcome === 'stopped' ? 'stopped' : 'unknown';
          finish(makeNativeAbortError({ outcome, reason: abortReason(), type: message?.type }));
          return;
        }
        if (cancelling) {
          finish(makeNativeAbortError({ outcome: 'unknown', reason: abortReason(), type: message?.type }));
          return;
        }
        if (reply?.error) finish(new Error(reply.error));
        else if (typeof reply?.exitCode === 'number') finish(null, reply);
        else finish(new Error('Invalid response from the Postora native host.'));
      });
      port.onDisconnect.addListener(() => {
        if (cancelling) {
          finish(makeNativeAbortError({ outcome: 'unknown', reason: abortReason(), type: message?.type }));
          return;
        }
        finish(new Error(`${runtime.lastError?.message || 'Postora native host disconnected.'} Check the private host installation with node native/install.mjs, then reload the extension.`));
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) return cancel();
      port.postMessage(message);
      dispatched = true;
    } catch (error) {
      finish(error);
    }
  });
}
