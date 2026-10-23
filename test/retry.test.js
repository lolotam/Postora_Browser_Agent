import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError, ProviderHttpError, classify, retryAfterMs, withRetry } from '../src/lib/retry.js';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { FallbackSession } from '../src/agent/fallback-session.js';

const http = (status, detail = '', retryAfter = null) => new ProviderHttpError({ status, detail, retryAfterMs: retryAfter });
const noWait = () => Promise.resolve();

test('classification: rate limits and overloads are transient; daily, billing and plan limits are exhausted', () => {
  // Real bodies from the showcase runs.
  const geminiDaily = '{"error":{"code":429,"message":"You exceeded your current quota","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}';
  const geminiMinute = '{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}';
  assert.equal(classify(http(429, geminiDaily)), 'exhausted');
  assert.equal(classify(http(429, geminiMinute)), 'transient');
  assert.equal(classify(http(429, 'Provider returned error')), 'transient'); // OpenRouter free model
  assert.equal(classify(http(503, 'Service temporarily overloaded')), 'transient'); // NVIDIA
  assert.equal(classify(http(529, 'Overloaded')), 'transient'); // Anthropic's overloaded model
  assert.equal(classify(http(402, 'Insufficient account funds')), 'exhausted');
  assert.equal(classify(http(429, 'insufficient_quota: check your billing')), 'exhausted');
  assert.equal(classify(http(429, 'usage limit reached'), { provider: 'chatgpt' }), 'exhausted');
  assert.equal(classify(http(429, 'rate limit reached', 2000), { provider: 'chatgpt' }), 'transient');
  assert.equal(classify(http(400, 'bad request')), 'fatal');
  assert.equal(classify(http(401, 'invalid key')), 'fatal');
  assert.equal(classify(Object.assign(new TypeError('Failed to fetch'), { network: true })), 'transient');
  assert.equal(classify(new TypeError('x is not a function')), 'fatal'); // a bug, not the network
});

test('Retry-After: seconds or an HTTP date', () => {
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:50 GMT')), 10000);
  assert.equal(retryAfterMs('soon'), null);
});

test('a transient failure is retried with backoff; the first success wins', async () => {
  const waits = [];
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw http(503);
    return 'ok';
  }, { wait: (ms) => { waits.push(ms); return Promise.resolve(); }, random: () => 0.5 });
  assert.equal(out, 'ok');
  assert.deepEqual(waits, [2000, 6000]);
});

test('exhausted and fatal errors are thrown at once, keeping status and detail', async () => {
  for (const err of [http(429, 'quota exceeded per day'), http(400, 'bad')]) {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls += 1; throw err; }, { wait: noWait }), (e) => e === err);
    assert.equal(calls, 1);
  }
});

test('a Retry-After longer than the wait budget hands over at once instead of retrying early', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw http(429, '', 45000); }, { wait: noWait }), { status: 429 });
  assert.equal(calls, 1);
});

test('the deadline is shared by attempts and waits; running out is not a user Stop', async () => {
  await assert.rejects(withRetry(async () => 'never', { deadline: Date.now() - 1, wait: noWait }), (e) => e instanceof DeadlineError && e.name !== 'AbortError');
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw http(503); }, { deadline: Date.now() + 1500, wait: noWait }), { status: 503 });
  assert.equal(calls, 1); // a 2 s wait does not fit in 1.5 s
});

test('Stop during a wait rejects at once with AbortError', async () => {
  const stop = new AbortController();
  const pending = withRetry(async () => { throw http(503); }, { signal: stop.signal, random: () => 0.5 });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('one notice, only for a wait the user would notice', async () => {
  const notices = [];
  let calls = 0;
  await withRetry(async () => { calls += 1; if (calls < 3) throw http(429, 'slow down'); return 'ok'; }, { wait: noWait, random: () => 0.5, notify: (n) => { if (!n.dismiss) notices.push(n); return 'id'; } });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'retrying');
  assert.equal(notices[0].code, 'rate-limit');
});

test('the "trying again" notice is withdrawn when the retries end, either way', async () => {
  for (const succeed of [true, false]) {
    const events = [];
    const notify = (n) => { events.push(n); return n.dismiss ? undefined : 'notice-1'; };
    let calls = 0;
    const run = withRetry(async () => { calls += 1; if (!succeed || calls < 2) throw http(503, 'busy'); return 'ok'; }, { wait: noWait, random: () => 1, notify }); // first pause 2.4 s: noticed
    if (succeed) assert.equal(await run, 'ok');
    else await assert.rejects(run);
    assert.deepEqual(events.map((e) => e.kind ?? `dismiss ${e.dismiss}`), ['retrying', 'dismiss notice-1']);
  }
});

test('a provider request: the error body is read once, retries happen, the stream is never replayed', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: { 'Retry-After': '0' } });
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const s = new CompatibleSession({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [] });
    s.addUserMessage('hi');
    const turn = await s.next({});
    assert.equal(turn.text, 'OK');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('exhausted quota on the main model: exactly one switch to the backup', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 });
  try {
    const primary = new CompatibleSession({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [] });
    let backupCalls = 0;
    const backup = { addUserMessage() {}, addToolResult() {}, next: async () => { backupCalls += 1; return { text: 'done by backup', toolCalls: [] }; } };
    const notices = [];
    const session = new FallbackSession({ primary, createBackup: () => backup, labels: { primary: 'A', backup: 'B' }, notify: (n) => notices.push(n) });
    session.addUserMessage('task');
    const turn = await session.next({});
    assert.equal(turn.text, 'done by backup');
    assert.equal(backupCalls, 1);
    assert.deepEqual(notices.map((n) => n.kind), ['switched']);
  } finally {
    globalThis.fetch = original;
  }
});

test('an error body that stalls or runs long is read only up to 4 KB and within the time left', async () => {
  const { readError } = await import('../src/lib/retry.js');
  // Headers arrive, then the body sends one chunk and never finishes.
  const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":"slow')); } }), { status: 503 });
  const started = Date.now();
  const err = await readError(stalled, 200);
  assert.ok(Date.now() - started < 2000);
  assert.equal(err.status, 503);
  assert.equal(err.detail, '{"error":"slow');
  const huge = new Response('x'.repeat(100000), { status: 500 });
  assert.equal((await readError(huge)).detail.length, 4096);
});

test('all pauses of one request share the 30 s wait budget', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ProviderHttpError({ status: 429, detail: 'slow down', retryAfterMs: 25000 });
  }, { wait: async (ms) => { waits.push(ms); }, random: () => 0.5 }), { status: 429 });
  assert.deepEqual(waits, [25000]); // a second 25 s pause would pass 30 s in all: hand over instead
  assert.equal(calls, 2);
});

test('a pause after a lost connection is announced as a connection problem', async () => {
  const notices = [];
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls < 2) throw Object.assign(new TypeError('fetch failed'), { network: true });
    return 'ok';
  }, { wait: async () => {}, random: () => 1, notify: (n) => { notices.push(n); return 'id'; } });
  assert.equal(notices[0].code, 'network');
});
