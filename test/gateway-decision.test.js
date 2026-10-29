import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { askGatewayDecision } from '../src/fast/gateway-decision-client.js';
import { askChatJudge } from '../src/fast/chat-judge-client.js';
import { askWithBackup, fastClientFor } from '../src/fast/clients.js';
import { askJev } from '../src/fast/jev-client.js';
import { fastHttpError, isFastAccessFailure } from '../src/fast/errors.js';

const questions = {
  operation: { type: 'choice', instructions: 'Which operation?', criteria: { click: 'Click', scroll_down: 'Scroll' } },
  risky: { type: 'noul', instructions: 'The next step is sensitive.' },
  goal_done: { type: 'noul', instructions: 'The goal is done.' },
};

function stubDecision(body, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return status === 200 ? Response.json(body) : new Response('{"error":{"message":"denied"}}', { status });
  };
  return calls;
}

test('Jev on Vercel is asked through the decision-model API with Jev-shaped answers back', async () => {
  const calls = stubDecision({
    model: 'typesafe-ai/jev',
    answers: {
      operation: { type: 'choice', choice: 'click', probabilities: { click: 0.9, scroll_down: 0.1 } },
      risky: { type: 'boolean', probability: 0.04 },
      goal_done: { type: 'refusal' },
    },
    usage: { inputTokens: 120 },
  });

  const { answers, model } = await askGatewayDecision({
    baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'vk', model: 'typesafe-ai/jev', state: { GOAL: 'g' }, questions,
  });

  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v4/ai/decision-model');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer vk');
  assert.equal(calls[0].init.headers['ai-model-id'], 'typesafe-ai/jev');
  assert.equal(calls[0].init.headers['ai-decision-model-specification-version'], '4');
  assert.deepEqual(calls[0].body.state, { GOAL: 'g' });
  assert.equal(calls[0].body.questions.risky.type, 'boolean');
  assert.deepEqual(calls[0].body.questions.operation.criteria, questions.operation.criteria);
  assert.equal(model, 'typesafe-ai/jev');
  assert.equal(answers.operation.choice, 'click');
  assert.ok(Math.abs(answers.operation.confidence - 0.8) < 1e-9);
  assert.deepEqual(answers.risky, { type: 'noul', noul: 0.04 });
  assert.equal(answers.goal_done, undefined, 'a refusal must escalate, not count as an answer');
});

test('a decision answer outside 0..1 is dropped, never read as safe', async () => {
  stubDecision({ answers: { risky: { type: 'boolean', probability: -0.2 }, goal_done: { type: 'boolean', probability: 'high' } } });
  const { answers } = await askGatewayDecision({ baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'vk', model: 'typesafe-ai/jev', state: {}, questions });
  assert.equal(answers.risky, undefined);
  assert.equal(answers.goal_done, undefined);
});

test('decision API errors are reported with their status', async () => {
  stubDecision(null, 403);
  await assert.rejects(
    askGatewayDecision({ baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'vk', model: 'typesafe-ai/jev', state: {}, questions }),
    /HTTP 403/,
  );
});

test('the fast layer picks its client from the provider and the model kind', () => {
  assert.equal(fastClientFor({ provider: 'typesafe' }), askJev);
  assert.equal(fastClientFor({ provider: 'opencode-zen', model: 'jev-1.13', decision: true }), askJev, 'an explicitly selected Zen Jev uses System One');
  assert.equal(fastClientFor({ provider: 'vercel', decision: true }), askGatewayDecision);
  assert.equal(fastClientFor({ provider: 'openrouter', decision: true }), askJev, 'OpenRouter serves Jev on /api/v1/systemone');
  assert.equal(fastClientFor({ provider: 'vercel', decision: false }), askChatJudge);
});

describe('fast-layer backup', () => {
  const request = { state: { GOAL: 'g' }, questions, signal: undefined };
  const answer = (model) => ({ answers: {}, model });
  const setup = (primaryBehaviour) => {
    const seen = [];
    const notices = [];
    const clients = {
      vercel: async (req) => { seen.push(['vercel', req.apiKey, req.state]); return primaryBehaviour(); },
      typesafe: async (req) => { seen.push(['typesafe', req.apiKey, req.state]); return answer('jev-latest'); },
    };
    const ask = askWithBackup({
      primary: { provider: 'vercel', apiKey: 'vk', model: 'typesafe-ai/jev' },
      backup: { provider: 'typesafe', apiKey: 'tk', model: 'jev-latest' },
      notify: (n) => notices.push(n),
      clientFor: (fast) => clients[fast.provider],
    });
    return { ask, seen, notices };
  };

  test('a healthy primary answers alone', async () => {
    const { ask, seen, notices } = setup(() => answer('typesafe-ai/jev'));
    assert.equal((await ask(request)).model, 'typesafe-ai/jev');
    assert.deepEqual(seen.map((s) => s[0]), ['vercel']);
    assert.equal(notices.length, 0);
  });

  test('a failing primary is answered by the backup for the same step, with one warning per task', async () => {
    const { ask, seen, notices } = setup(() => { throw new Error('Fast layer request failed (HTTP 403): denied'); });
    assert.equal((await ask(request)).model, 'jev-latest');
    await ask(request);
    assert.deepEqual(seen[1], ['typesafe', 'tk', { GOAL: 'g' }]);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, 'warning');
    assert.equal(notices[0].code, 'auth');
    assert.equal(seen.filter((s) => s[0] === 'vercel').length, 1, 'a forbidden primary is not retried on each step');
  });

  test('after three primary failures the primary is skipped for the rest of the task', async () => {
    const { ask, seen } = setup(() => { throw new Error('HTTP 500'); });
    for (let i = 0; i < 5; i += 1) await ask(request);
    assert.equal(seen.filter((s) => s[0] === 'vercel').length, 3);
    assert.equal(seen.filter((s) => s[0] === 'typesafe').length, 5);
  });

  test('without a backup the primary error comes through', async () => {
    const ask = askWithBackup({ primary: { provider: 'vercel' }, backup: null, notify: () => {}, clientFor: () => async () => { throw new Error('HTTP 401'); } });
    await assert.rejects(ask(request), /HTTP 401/);
  });

  test('disabled model access without a backup is bounded and notified once', async () => {
    let calls = 0;
    const notices = [];
    const ask = askWithBackup({ primary: { provider: 'opencode-zen', model: 'jev-1.13' }, backup: null, notify: (notice) => notices.push(notice),
      clientFor: () => async () => { calls += 1; throw Object.assign(new Error('Jev request failed (HTTP 403): Model access is disabled'), { status: 403 }); } });
    for (let n = 0; n < 3; n++) await assert.rejects(ask(request), /Model access is disabled/);
    assert.equal(calls, 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'fast-unavailable');
  });

  test('cancellation never invokes a fast backup or emits an unavailable notice', async () => {
    const controller = new AbortController();
    const { ask, seen, notices } = setup(() => { controller.abort(); throw new DOMException('stop', 'AbortError'); });
    await assert.rejects(ask({ ...request, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(seen.length, 1);
    assert.equal(notices.length, 0);
  });

  test('a transient failure does not consume the later access-failure warning', async () => {
    let calls = 0;
    const notices = [];
    const ask = askWithBackup({ primary: { provider: 'typesafe', model: 'jev' }, notify: (notice) => notices.push(notice),
      clientFor: () => async () => { calls++; throw fastHttpError('Jev', calls === 1 ? 503 : 403, 'Model is unavailable'); } });
    await assert.rejects(ask(request), /503/);
    assert.deepEqual(notices, []);
    await assert.rejects(ask(request), /403/);
    await assert.rejects(ask(request), /403/);
    assert.equal(calls, 2);
    assert.equal(notices.length, 1);
  });
});

test('HTTP status keeps unavailable-worded rate limits and server errors transient', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const error = fastHttpError('Jev', status, 'Model access is disabled; model is unavailable');
    assert.equal(error.unavailable, false);
    assert.equal(isFastAccessFailure(error), false);
    assert.equal(isFastAccessFailure(new Error(error.message)), false);
  }
  assert.equal(isFastAccessFailure(fastHttpError('Jev', 403, 'denied')), true);
  assert.equal(isFastAccessFailure(fastHttpError('Jev', 400, 'Model access is disabled')), true);
});
