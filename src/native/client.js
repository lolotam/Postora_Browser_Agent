// One native process per command. Disconnecting on Stop closes its stdin and
// the host terminates the command tree. No localhost listener is exposed.
export const HOST_NAME = 'com.postora.private_terminal';

export function runNativeCommand(args, { signal = null, runtime = globalThis.chrome?.runtime } = {}) {
  return nativeRequest({ type: 'run', ...args }, { signal, runtime });
}

export function nativeRequest(message, { signal = null, runtime = globalThis.chrome?.runtime, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('The task was stopped.'));
    let port;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', cancel);
      try { port?.disconnect(); } catch { /* Already disconnected. */ }
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new Error('The task was stopped; the native command was cancelled.'));
    try {
      port = runtime.connectNative(HOST_NAME);
      port.onMessage.addListener((message) => {
        if (message?.type === 'progress') { onProgress?.(message); return; }
        if (message?.error) finish(new Error(message.error));
        else if (typeof message?.exitCode === 'number') finish(null, message);
        else finish(new Error('Invalid response from the Postora native host.'));
      });
      port.onDisconnect.addListener(() => finish(new Error(`${runtime.lastError?.message || 'Postora native host disconnected.'} Check the private host installation with node native/install.mjs, then reload the extension.`)));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) return cancel();
      port.postMessage(message);
    } catch (error) {
      finish(error);
    }
  });
}
