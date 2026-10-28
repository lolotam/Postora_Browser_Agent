// Plays Jev's role on any OpenAI-compatible chat model (OpenRouter, Vercel AI
// Gateway, a local server): one JSON-mode completion answers every typed
// question. The probabilities are the model's own estimate, not calibrated like
// Jev's, which is why gateway presets ask for a higher minimum probability.

import { fastHttpError } from './errors.js';
import { requestJson } from '../lib/json.js';

const REQUEST_TIMEOUT_MS = 15000;

export async function askChatJudge({ baseUrl, apiKey, model, state, questions, signal }) {
  if (!apiKey) throw new Error('Fast layer API key is missing.');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: requestJson({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: judgeInstructions(questions) },
        { role: 'user', content: requestJson(state) },
      ],
    }),
  });
  if (!res.ok) {
    throw fastHttpError('Fast layer', res.status, await res.text().catch(() => ''));
  }
  const body = await res.json();
  const reply = parseReply(body.choices?.[0]?.message?.content);
  return { answers: toAnswers(questions, reply), usage: body.usage ?? null, model: body.model ?? model };
}

function judgeInstructions(questions) {
  const lines = [
    'You are the fast decision layer of a browser agent. The user message is the current STATE as JSON (GOAL, URL, TITLE, PAGE_TEXT, INTERACTIVE_ELEMENTS, LAST_ACTIONS).',
    'Answer every question below. Reply with one JSON object only, keyed by question name:',
    '- a "choice" question: {"probabilities": {"<option key>": <number 0..1>, ...}} over the listed option keys, most mass on the best option;',
    '- a "noul" question: one number from 0 to 1, the probability that the statement is true.',
    'Spread probability when unsure; never invent option keys.',
    '',
    'Questions:',
  ];
  for (const [name, q] of Object.entries(questions)) {
    lines.push(`${name} (${q.type}): ${q.instructions}`);
    if (q.type === 'choice') for (const [key, text] of Object.entries(q.criteria)) lines.push(`  - ${key}: ${text}`);
  }
  return lines.join('\n');
}

// JSON mode is emulated for some models behind gateways, which may still fence the object.
function parseReply(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Fast layer model did not return JSON.');
  }
}

/** Converts the model's reply to Jev's answer shape; unusable answers are left out so the gate escalates. */
export function toAnswers(questions, reply) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const answer = q.type === 'choice' ? choiceAnswer(q.criteria, reply?.[name]) : noulAnswer(reply?.[name]);
    if (answer) answers[name] = answer;
  }
  return answers;
}

function choiceAnswer(criteria, raw) {
  const scores = Object.entries(raw?.probabilities ?? {})
    .filter(([key]) => Object.hasOwn(criteria, key))
    .map(([key, p]) => [key, Number(p)])
    .filter(([, p]) => Number.isFinite(p) && p > 0); // not clamped: some models answer in percentages
  const total = scores.reduce((sum, [, p]) => sum + p, 0);
  if (!total) return null;
  const ranked = scores.map(([key, p]) => [key, p / total]).sort((a, b) => b[1] - a[1]);
  const [[choice, first], [, second] = [null, 0]] = ranked;
  return { type: 'choice', choice, confidence: first - second, probabilities: Object.fromEntries(ranked) };
}

// A malformed probability is dropped, not clamped: clamping -0.5 to 0 would read
// "is this step risky?" as "certainly not", and the gate treats a missing answer as risky.
function noulAnswer(raw) {
  return isProbability(raw) ? { type: 'noul', noul: raw } : null;
}

export function isProbability(x) {
  return typeof x === 'number' && x >= 0 && x <= 1;
}
