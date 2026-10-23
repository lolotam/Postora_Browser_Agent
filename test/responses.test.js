import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesSession } from '../src/providers/responses.js';

function sseResponse(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** A session on a plain Responses backend, with no per-backend quirks. */
function makeSession(overrides = {}) {
  return new ResponsesSession({
    baseUrl: 'https://api.example/v1',
    model: 'm',
    effort: '',
    systemPrompt: 'SYS',
    tools: [],
    authHeaders: async () => ({ Authorization: 'Bearer token' }),
    ...overrides,
  });
}

let calls;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
}

test('a turn counts only after the response completed', async () => {
  stubFetch(() => sseResponse([
    { type: 'response.output_text.delta', delta: 'Half' },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Half' }] } },
  ]));
  const session = makeSession();
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /ended before the answer was complete/);

  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'text-reset'], 'the half answer is withdrawn');
  assert.equal(session.input.length, 1, 'the failed turn is not kept');
});

test('a failed response throws and leaves the history alone', async () => {
  stubFetch(() => sseResponse([
    { type: 'response.output_text.delta', delta: 'Half' },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Half' }] } },
    { type: 'response.failed', response: { error: { message: 'The model failed.' } } },
  ]));
  const session = makeSession();
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /The model failed\./);

  assert.ok(events.some((e) => e.type === 'text-reset'));
  assert.equal(session.input.length, 1);
});

test('an error event throws and leaves the history alone', async () => {
  stubFetch(() => sseResponse([{ type: 'error', message: 'The model returned an error.' }]));
  const session = makeSession();
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /The model returned an error\./);
  assert.equal(session.input.length, 1);
});

test('a call with broken arguments is not run', async () => {
  stubFetch(() => sseResponse([
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'navigate', arguments: '{"url":' } },
    { type: 'response.completed', response: { usage: { total_tokens: 4 } } },
  ]));
  const session = makeSession();
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /broken arguments/);
  assert.equal(session.input.length, 1, 'the failed turn is not kept');
});

test('a completed turn keeps the answer and the calls', async () => {
  stubFetch(() => sseResponse([
    { type: 'response.output_text.delta', delta: 'Opening' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'Opening' }] } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'navigate', arguments: '{"url":"x.com"}' } },
    { type: 'response.completed', response: { usage: { total_tokens: 9 } } },
  ]));
  const session = makeSession();
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.equal(turn.text, 'Opening');
  assert.deepEqual(turn.toolCalls, [{ id: 'c1', name: 'navigate', args: { url: 'x.com' } }]);
  assert.equal(turn.usage.total_tokens, 9);
  assert.equal(session.input.length, 3, 'the answer and the call are kept for the next turn');
});

/** A stream that sends these SSE lines, then fails as a dropped connection does. */
function droppedStream(sent) {
  const lines = [...sent];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    // The lines are read first; the connection drops on the read after them
    // (an error raised at once would discard what was queued).
    pull(controller) {
      if (lines.length) controller.enqueue(encoder.encode(lines.shift()));
      else controller.error(new TypeError('network error'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('a connection that drops after some text withdraws the text', async () => {
  stubFetch(() => droppedStream([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Half' })}\n\n`]));
  const session = makeSession();
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /network error/);

  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'text-reset'], 'withdrawn once');
  assert.equal(session.input.length, 1, 'the failed turn is not kept');
});

test('a malformed event after some text withdraws the text', async () => {
  stubFetch(() => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Half' })}\n\ndata: {not json\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const session = makeSession();
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), SyntaxError);

  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'text-reset']);
  assert.equal(session.input.length, 1);
});
