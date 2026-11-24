// A reply that was cut off is not a turn: the half-written call must never be
// run, and the model is asked again. This is the defect of the review
// hardening plan, row A4 (docs/superpowers/plans/2026-11-24-review-hardening.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { FallbackSession } from '../src/agent/fallback-session.js';
import { runAgent } from '../src/agent/agent.js';

const sse = (chunk) => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const session = (opts = {}) => new CompatibleSession({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [], ...opts });
const call = (id, name, args = {}) => ({ id, name, args });
/** A tool call as the provider streams it: the arguments arrive in pieces. */
const toolChunk = (name, args, id = 'c1') => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] });

test('a cut-off reply, and a call with broken arguments, are not turns that can be run', async () => {
  const original = globalThis.fetch;
  const cases = [
    ['the output limit ran out', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://exa' } }] }, finish_reason: 'length' }] }],
    ['the arguments are not JSON', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'insert_text', arguments: '{"index":1,"text":"hel' } }] }, finish_reason: 'tool_calls' }] }],
  ];
  try {
    for (const [why, chunk] of cases) {
      const bodies = [];
      globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return sse(chunk);
      };
      const s = session();
      s.addUserMessage('go');
      const turn = await s.next({});
      assert.equal(turn.truncated, true, why);
      assert.deepEqual(turn.toolCalls, [], why);
      assert.equal(turn.text, '', why);
      // The next request must be a valid conversation: the cut-off assistant
      // turn is not in it, and no tool result waits for a call that never ran.
      await s.next({});
      const messages = bodies[1].messages;
      assert.equal(messages.filter((m) => m.role === 'assistant').length, 0, why);
      assert.equal(messages.filter((m) => m.role === 'tool').length, 0, why);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a truncated turn withdraws the text it had shown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse({ choices: [{ delta: { content: 'Half an ans' }, finish_reason: 'length' }] });
  try {
    const events = [];
    const s = session();
    s.addUserMessage('x');
    await s.next({ onEvent: (e) => events.push(e.type) });
    assert.deepEqual(events, ['text-delta', 'text-reset']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a text-only request keeps a long answer that ran out of output room', async () => {
  // The step-limit report, a compaction summary and the connection test ask
  // with toolChoice 'none': there is no call to cut in half and nobody asks again.
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse({ choices: [{ delta: { content: 'A long report' }, finish_reason: 'length' }] });
  try {
    const s = session();
    s.addUserMessage('summarize');
    const turn = await s.next({ toolChoice: 'none' });
    assert.equal(turn.truncated, undefined);
    assert.equal(turn.text, 'A long report');
  } finally {
    globalThis.fetch = original;
  }
});

test('a text-only request neither returns nor keeps a call the endpoint sent anyway', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return sse({ choices: [{ delta: { content: 'Report', tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://exa' } }] }, finish_reason: 'length' }] });
  };
  try {
    const s = session();
    s.addUserMessage('summarize');
    const turn = await s.next({ toolChoice: 'none' });
    assert.equal(turn.text, 'Report');
    assert.deepEqual(turn.toolCalls, []);
    await s.next({ toolChoice: 'none' });
    const assistant = bodies[1].messages.filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].tool_calls, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('a text-only request answered with only a call is an empty answer, not an error', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  };
  try {
    const s = session();
    s.addUserMessage('summarize');
    const turn = await s.next({ toolChoice: 'none' });
    assert.equal(turn.text, '');
    assert.deepEqual(turn.toolCalls, []);
    await s.next({ toolChoice: 'none' });
    assert.equal(bodies[1].messages.filter((m) => m.role === 'assistant').length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a turn that is not cut off keeps its calls and its history', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return sse(toolChunk('navigate', '{"url":"https://x.y"}'));
  };
  try {
    const s = session();
    s.addUserMessage('go');
    const turn = await s.next({});
    assert.equal(turn.truncated, undefined);
    assert.equal(turn.toolCalls.length, 1);
    assert.deepEqual(turn.toolCalls[0].args, { url: 'https://x.y' });
    s.addToolResult(turn.toolCalls[0].id, 'Navigated.');
    await s.next({});
    const messages = bodies[1].messages;
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('the fallback session passes a truncated turn through and records no open call', async () => {
  const primary = {
    addUserMessage() {},
    addToolResult() {},
    next: async () => ({ truncated: true, text: '', toolCalls: [] }),
  };
  const fallback = new FallbackSession({ primary, labels: { primary: 'p', backup: 'b' } });
  const turn = await fallback.next({});
  assert.equal(turn.truncated, true);
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(fallback.openCalls.size, 0);
});

/** A session that answers with the queued turns and records what it was told. */
function scriptedSession(turns) {
  const state = { users: [], results: [], turns: 0 };
  state.session = {
    addUserMessage: (text) => state.users.push(text),
    addToolResult: (id, output) => state.results.push({ id, output }),
    next: async () => {
      state.turns += 1;
      return turns.shift() ?? { text: '', toolCalls: [] };
    },
  };
  return state;
}

test('a cut-off reply is asked again, and the retry runs the tool', async () => {
  const state = scriptedSession([
    { truncated: true, text: '', toolCalls: [] },
    { text: '', toolCalls: [call('1', 'navigate', { url: 'https://x.y' })] },
    { text: '', toolCalls: [call('2', 'done', { report: 'done', success: true })] },
  ]);
  const executed = [];
  const events = [];
  await runAgent({
    session: state.session,
    task: 'go',
    maxSteps: 5,
    emit: (e) => events.push(e),
    execute: async (name) => {
      executed.push(name);
      return { output: 'ok' };
    },
  });
  assert.match(state.users[1], /cut off/i);
  assert.deepEqual(executed, ['navigate']);
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.success, true);
  assert.equal(final.report, 'done');
});

test('a cut-off reply runs no tool and reports no success', async () => {
  const state = scriptedSession([
    // A provider that hands back a cut-off turn with calls in it must not have
    // them run either.
    { truncated: true, text: '', toolCalls: [call('1', 'done', { report: 'cut off', success: true })] },
    { truncated: true, text: '', toolCalls: [call('2', 'done', { report: 'cut off', success: true })] },
    { truncated: true, text: '', toolCalls: [] },
  ]);
  const executed = [];
  const events = [];
  await runAgent({
    session: state.session,
    task: 'go',
    maxSteps: 5,
    emit: (e) => events.push(e),
    execute: async (name) => {
      executed.push(name);
      return { output: 'ok' };
    },
  });
  assert.deepEqual(executed, []);
  assert.equal(state.results.length, 0);
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].success, false);
  assert.notEqual(finals[0].report, 'cut off'); // the cut-off report never reaches the user
});

test('a reply that keeps being cut off ends the task as failed, after two retries', async () => {
  const state = scriptedSession([
    { truncated: true, text: '', toolCalls: [] },
    { truncated: true, text: '', toolCalls: [] },
    { truncated: true, text: '', toolCalls: [] },
  ]);
  const executed = [];
  const events = [];
  await runAgent({
    session: state.session,
    task: 'go',
    maxSteps: 5,
    emit: (e) => events.push(e),
    execute: async (name) => {
      executed.push(name);
      return { output: 'ok' };
    },
  });
  assert.equal(state.turns, 3); // the reply and its two retries
  assert.equal(state.users.length, 3); // the task and the two retries
  assert.deepEqual(executed, []);
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].success, false);
  assert.match(finals[0].report, /cut off/i);
});

test('the retry after a cut-off is part of the same step', async () => {
  const state = scriptedSession([
    { truncated: true, text: '', toolCalls: [] },
    { text: '', toolCalls: [call('1', 'done', { report: 'ok', success: true })] },
  ]);
  const events = [];
  await runAgent({ session: state.session, task: 'go', maxSteps: 1, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });
  assert.deepEqual(events.filter((e) => e.type === 'thinking').map((e) => e.step), [1, 1]);
  assert.equal(events.find((e) => e.type === 'final').success, true);
});
