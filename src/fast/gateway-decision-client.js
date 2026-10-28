// Decision models served by Vercel AI Gateway (typesafe-ai/jev and other models
// listed with type "evaluation"). Same request as TypeSafe's System One API except
// that yes/no questions are "boolean", answered as `probability`, and choices
// come back without a confidence, which the gate needs, so it is derived here.

import { isProbability } from './chat-judge-client.js';
import { fastHttpError } from './errors.js';
import { requestJson } from '../lib/json.js';

const REQUEST_TIMEOUT_MS = 8000;

export async function askGatewayDecision({ baseUrl, apiKey, model, state, questions, signal }) {
  if (!apiKey) throw new Error('Fast layer API key is missing.');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(new URL('/v4/ai/decision-model', baseUrl).href, {
    method: 'POST',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-decision-model-specification-version': '4',
      'ai-model-id': model,
    },
    body: requestJson({ state, questions: toGatewayQuestions(questions) }),
  });
  if (!res.ok) {
    throw fastHttpError('Fast layer', res.status, await res.text().catch(() => ''));
  }
  const body = await res.json();
  return { answers: toJevAnswers(body.answers ?? {}), usage: body.usage ?? null, model: body.model ?? model };
}

function toGatewayQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'noul' ? { ...q, type: 'boolean' } : q]));
}

/** Refusals, unknown answer types and probabilities outside 0..1 are left out, so the gate escalates those steps. */
function toJevAnswers(answers) {
  const out = {};
  for (const [name, a] of Object.entries(answers)) {
    if (a.type === 'boolean') {
      if (isProbability(a.probability)) out[name] = { type: 'noul', noul: a.probability };
    }
    else if (a.type === 'choice') out[name] = { ...a, confidence: peak(a.probabilities ?? { [a.choice]: 1 }) };
  }
  return out;
}

function peak(probabilities) {
  const [first = 0, second = 0] = Object.values(probabilities).sort((x, y) => y - x);
  return first - second;
}
