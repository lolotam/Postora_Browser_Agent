import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';
import { FallbackSession } from '../src/agent/fallback-session.js';
import { autoCompactDue, compactPrompt, compactedMessage, lastCompaction, lastInputTokens, parseCompactCommand } from '../src/sessions/compaction.js';
import { conversationHistory } from '../src/sessions/continuation.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/lib/settings.js';

function fakeSession(script) {
  const s = { received: [], calls: 0, options: [] };
  s.addUserMessage = (text, images = []) => s.received.push({ kind: 'user', text, images });
  s.addToolResult = (callId, output, images = []) => s.received.push({ kind: 'tool', callId, output, images });
  s.next = async (options) => {
    s.options.push(options);
    const answer = script[s.calls++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return s;
}

test('/compact is recognised with or without a focus, and nothing else is', () => {
  assert.deepEqual(parseCompactCommand('/compact'), { focus: '' });
  assert.deepEqual(parseCompactCommand('  /COMPACT  keep the login steps '), { focus: 'keep the login steps' });
  assert.deepEqual(parseCompactCommand('/compact\nkeep ids'), { focus: 'keep ids' });
  assert.equal(parseCompactCommand('/compactor'), null);
  assert.equal(parseCompactCommand('please /compact'), null);
  assert.equal(parseCompactCommand(''), null);
  assert.equal(parseCompactCommand(undefined), null);
  assert.equal(parseCompactCommand(`/compact ${'x'.repeat(900)}`).focus.length, 500);
});

test('automatic compaction is due only when on and the turn read at least the threshold', () => {
  const on = { enabled: true, thresholdTokens: 80000 };
  assert.equal(autoCompactDue(on, 79999), false);
  assert.equal(autoCompactDue(on, 80000), true);
  assert.equal(autoCompactDue({ ...on, enabled: false }, 500000), false);
  assert.equal(autoCompactDue(on, 0), false);
  assert.equal(autoCompactDue(on, undefined), false);
  assert.equal(autoCompactDue(undefined, 500000), false);
});

test('the prompt carries the focus, and the compacted message says whether to continue', () => {
  assert.doesNotMatch(compactPrompt(), /special attention/);
  assert.match(compactPrompt('the login steps'), /special attention on: the login steps/);
  assert.match(compactedMessage('S', { continueTask: true, lastObservation: 'page' }), /Latest page observation:\npage[\s\S]*Continue the task/);
  const carried = compactedMessage('S', { continueTask: true, task: 'THE TASK', notes: 'Notes saved:\n- a' });
  assert.match(carried, /word for word:\nTHE TASK[\s\S]*Notes saved:/);
  assert.doesNotMatch(compactedMessage('S', { continueTask: false, task: 'THE TASK' }), /THE TASK/);
  assert.match(compactedMessage('S'), /Wait for the next message/);
});

test('the transcript knows its last compaction and how big the conversation was after it', () => {
  const events = [
    { type: 'user', text: 'one' },
    { type: 'turn-end', usage: { input: 50000, output: 10 } },
    { type: 'compacted', summary: 'S1' },
    { type: 'user', text: 'two' },
    { type: 'turn-end', usage: { input: 9000, output: 10 } },
    { type: 'compacted', summary: 'S2' },
  ];
  assert.deepEqual(lastCompaction(events), { index: 5, summary: 'S2' });
  assert.equal(lastInputTokens(events), 0); // read before the compaction: gone
  assert.equal(lastInputTokens(events.slice(0, 5)), 9000);
  assert.equal(lastInputTokens([{ type: 'user', text: 'x' }]), 0);
  assert.equal(lastCompaction([{ type: 'compacted', summary: '' }]), null);
});

test('a reopened session reads the summary and what came after it, not the whole conversation', () => {
  const events = [
    { type: 'user', text: 'old question' },
    { type: 'final', report: 'old answer' },
    { type: 'compacted', summary: 'the user wants flights to Cairo' },
    { type: 'user', text: 'new question' },
  ];
  const history = conversationHistory(events);
  assert.match(history, /the user wants flights to Cairo/);
  assert.match(history, /new question/);
  assert.doesNotMatch(history, /old question|old answer/);
  assert.match(conversationHistory(events.slice(0, 3)), /^Summary of the earlier conversation/);
  assert.doesNotMatch(conversationHistory(events.slice(0, 3)), /Previous conversation/);
  assert.match(conversationHistory(events.slice(0, 2)), /old answer/); // no compaction: unchanged
});

test('compacting swaps in a fresh session that starts from the summary, and the backup gets it too', async () => {
  const primary = fakeSession([{ text: 'SUMMARY: goal flights, did X, next Y', toolCalls: [], usage: { input: 10, output: 5 } }]);
  const fresh = fakeSession([]);
  const backup = fakeSession([]);
  const session = new FallbackSession({ primary, createPrimary: () => fresh, createBackup: () => backup, labels: {}, history: 'OLD HISTORY' });
  session.notebook = { format: () => 'Notes saved so far:\n- the code is 42' };
  session.addUserMessage('task');
  session.addToolResult('c1', 'Clicked\nPage state: results', ['img']);

  const { summary, usage } = await session.compact({ prompt: 'PROMPT', continueTask: true, carry: { task: 'FULL TASK TEXT', images: ['task-img'] } });

  assert.equal(summary, 'SUMMARY: goal flights, did X, next Y');
  assert.deepEqual(usage, { input: 10, output: 5 });
  assert.equal(primary.received.at(-1).text, 'PROMPT');
  assert.equal(primary.options[0].toolChoice, 'none'); // no tool call while summarizing
  assert.equal(session.active, fresh);
  assert.equal(fresh.received.length, 1);
  assert.match(fresh.received[0].text, /SUMMARY: goal flights/);
  assert.match(fresh.received[0].text, /Latest page observation:\nClicked/); // not lost with the old conversation
  assert.match(fresh.received[0].text, /Continue the task/);
  assert.deepEqual(fresh.received[0].images, ['task-img', 'img']); // the task's own images come along
  assert.match(fresh.received[0].text, /word for word:\nFULL TASK TEXT/);
  assert.match(fresh.received[0].text, /the code is 42/);
  assert.equal(session.history, ''); // the summary replaces it
  assert.equal(session.log.steps.length, 0);
  assert.match(session.log.task, /SUMMARY: goal flights/);
});

test('compacting while idle does not tell the model to continue a task', async () => {
  const fresh = fakeSession([]);
  const session = new FallbackSession({ primary: fakeSession([{ text: 'S', toolCalls: [] }]), createPrimary: () => fresh });
  session.addUserMessage('task');
  await session.compact({ prompt: 'P', continueTask: false });
  assert.match(fresh.received[0].text, /Wait for the next message/);
  assert.deepEqual(fresh.received[0].images, []);
});

test('a failed or empty summary leaves the session as it was', async () => {
  for (const answer of [new Error('HTTP 500'), { text: '   ', toolCalls: [] }]) {
    const primary = fakeSession([answer]);
    const session = new FallbackSession({ primary, createPrimary: () => assert.fail('no fresh session') });
    session.addUserMessage('task');
    await assert.rejects(session.compact({ prompt: 'P' }));
    assert.equal(session.active, primary);
    assert.equal(session.log.task, 'task');
    // The summary request is cancelled, or the next turn would answer it as the task's report.
    assert.equal(primary.received.at(-2).text, 'P');
    assert.match(primary.received.at(-1).text, /cancelled\. Do not answer it/);
  }
  await assert.rejects(new FallbackSession({ primary: fakeSession([]) }).compact({ prompt: 'P' }), /cannot be compacted/);
});

test('the agent loop compacts between turns, only when the hook says so, and restarts the size count', async () => {
  const sizes = [];
  const turns = [
    { text: '', toolCalls: [{ id: '1', name: 'click', args: {} }], usage: { prompt_tokens: 90000, completion_tokens: 1 } },
    { text: '', toolCalls: [{ id: '2', name: 'click', args: {} }], usage: { input_tokens: 1000, output_tokens: 1 } },
    { text: '', toolCalls: [{ id: '3', name: 'done', args: { report: 'ok', success: true } }], usage: { input_tokens: 1200, output_tokens: 1 } },
  ];
  const order = [];
  const session = { addUserMessage: (t) => order.push(`user:${t}`), addToolResult() {}, next: async () => turns.shift() };
  const compaction = { beforeTurn: async ({ inputTokens, start }) => { sizes.push(inputTokens); order.push(`hook:${start ? 'start' : 'turn'}`); return !start && inputTokens >= 80000; } };
  const events = [];
  await runAgent({ session, task: 'go', maxSteps: 5, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }), compaction });
  // The size is what the previous turn read; after a compaction that turn is the new, small one.
  // The first call is the check before the task is added; the rest come before each model turn.
  assert.deepEqual(sizes, [0, 0, 90000, 1000]);
  assert.deepEqual(order.slice(0, 3), ['hook:start', 'user:go', 'hook:turn']); // the task is never part of what is summarized
  assert.equal(events.find((e) => e.type === 'final').report, 'ok');
});

test('settings: automatic compaction is on by default and the threshold stays inside its limits', () => {
  assert.deepEqual(mergeSettings({}).autoCompact, DEFAULT_SETTINGS.autoCompact);
  assert.equal(mergeSettings({}).autoCompact.enabled, true);
  assert.deepEqual(mergeSettings({ autoCompact: { enabled: false, thresholdTokens: 120000 } }).autoCompact, { enabled: false, thresholdTokens: 120000 });
  assert.equal(mergeSettings({ autoCompact: { enabled: true, thresholdTokens: 5 } }).autoCompact.thresholdTokens, 8000);
  assert.equal(mergeSettings({ autoCompact: { enabled: true, thresholdTokens: 1e12 } }).autoCompact.thresholdTokens, 1000000);
  assert.equal(mergeSettings({ autoCompact: { enabled: true, thresholdTokens: 'abc' } }).autoCompact.thresholdTokens, 80000);
  assert.equal(mergeSettings({ autoCompact: { enabled: 'yes' } }).autoCompact.enabled, true);
});
