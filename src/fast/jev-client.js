// Client for TypeSafe's System One API (model: Jev). Jev never generates text:
// it takes a `state` plus typed questions (choice / score / noul) and returns
// typed answers with calibrated probabilities, typically in well under a second.

import { fastHttpError } from './errors.js';
import { requestJson } from '../lib/json.js';

const REQUEST_TIMEOUT_MS = 8000;

export async function askJev({ baseUrl, apiKey, model, state, questions, signal }) {
  if (!apiKey) throw new Error('Jev API key is missing.');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: requestJson({ model, state, questions }),
  });
  if (!res.ok) {
    throw fastHttpError('Jev', res.status, await res.text().catch(() => ''));
  }
  const body = await res.json();
  return { answers: body.answers ?? {}, usage: body.usage ?? null, model: body.model ?? model };
}
