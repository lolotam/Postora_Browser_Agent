// The panel's request to the service worker. A failure carries the stable code
// the worker sent, so the panel can show its own wording for it.

import { t } from './i18n.js';

export function isAuthProtocolMismatch(type, payload, message) {
  return (type === 'openrouter-login' && /^Unknown request openrouter-login\.?$/.test(message))
    || (['kimi', 'minimax', 'zai'].includes(payload?.provider)
      && message.replace(/\.$/, '') === `Unknown account provider ${payload.provider}`);
}

/** Sends a request to the worker and returns its result. */
export async function request(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) {
    if (isAuthProtocolMismatch(type, payload, res?.error ?? '')) {
      const error = new Error(t('connection.workerOutdated'));
      error.code = 'worker-outdated';
      globalThis.dispatchEvent?.(new CustomEvent('postora-worker-mismatch'));
      throw error;
    }
    const error = new Error(res?.error ?? t('err.request'));
    // The code names the problem; the panel translates it.
    error.code = typeof res?.code === 'string' ? res.code : '';
    throw error;
  }
  return res.result;
}
