// The panel's request to the service worker. A failure carries the stable code
// the worker sent, so the panel can show its own wording for it.

import { t } from './i18n.js';

/** Sends a request to the worker and returns its result. */
export async function request(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) {
    const error = new Error(res?.error ?? t('err.request'));
    // The code names the problem; the panel translates it.
    error.code = typeof res?.code === 'string' ? res.code : '';
    throw error;
  }
  return res.result;
}
