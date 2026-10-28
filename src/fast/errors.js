import { providerMessage } from '../lib/failure.js';

/** A rejected credential/model is unavailable for this task, not a transient retry. */
export function fastHttpError(label, status, body) {
  const detail = providerMessage(body);
  const unavailable = isPermanentAccess(status, detail);
  return Object.assign(new Error(`${label} request failed (HTTP ${status}): ${detail}${unavailable ? ' Check model access or choose another Fast-layer provider in Settings.' : ''}`), {
    status, unavailable,
  });
}

/** Also accepts older clients' status-bearing errors at the wrapper seam. */
export function isFastAccessFailure(error) {
  const status = error?.status ?? Number(error?.message?.match(/HTTP (\d{3})\b/i)?.[1]);
  return isPermanentAccess(status, error?.message ?? '');
}

function isPermanentAccess(status, detail) {
  return status === 401 || status === 403
    || ([400, 404, 410, 422].includes(status) && /model access is disabled|model is unavailable/i.test(detail));
}
