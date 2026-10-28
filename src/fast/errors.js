import { providerMessage } from '../lib/failure.js';

/** A rejected credential/model is unavailable for this task, not a transient retry. */
export function fastHttpError(label, status, body) {
  const detail = providerMessage(body);
  const unavailable = status === 401 || status === 403 || /model access is disabled|model is unavailable/i.test(detail);
  return Object.assign(new Error(`${label} request failed (HTTP ${status}): ${detail}${unavailable ? ' Check model access or choose another Fast-layer provider in Settings.' : ''}`), {
    status, unavailable,
  });
}

/** Also accepts older clients' status-bearing errors at the wrapper seam. */
export function isFastAccessFailure(error) {
  return Boolean(error?.unavailable) || [401, 403].includes(error?.status)
    || /HTTP (401|403)\b|model access is disabled|model is unavailable/i.test(error?.message ?? '');
}
