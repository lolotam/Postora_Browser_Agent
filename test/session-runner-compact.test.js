import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: { onRemoved: { addListener() {} } },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
  },
};

const { SessionRunner } = await import('../src/background/session-runner.js');
const sessions = await import('../src/sessions/store.js');
const { mergeSettings } = await import('../src/lib/settings.js');

/** A runner with a task "running" and its events collected. */
async function busyRunner(title, steerMode = 'next-step') {
  const meta = await sessions.createStoredSession(title);
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const events = [];
  runner.emit = (e) => events.push(e);
  runner.abort = new AbortController();
  runner.settings = mergeSettings({ steerMode, autoCompact: { enabled: true, thresholdTokens: 8000 } });
  return { runner, events };
}

const compactingSession = (calls, { fail = false } = {}) => ({
  compact: async (options) => {
    calls.push(options);
    if (fail) throw new Error('HTTP 500');
    return { summary: 'THE SUMMARY', usage: { input: 3, output: 2 } };
  },
});

test('/compact while a task runs waits like a message and is never read by the model as one', async () => {
  const { runner, events } = await busyRunner('Compact steered');
  const steering = runner.steering();
  const signal = steering.turnSignal(runner.abort.signal);

  runner.receive({ type: 'steer', text: '/compact keep the ids', mode: 'queue' });
  runner.receive({ type: 'steer', text: '/compact', mode: 'next-step' });
  assert.deepEqual(events.filter((e) => e.type === 'pending-added').map((e) => [e.item.text, e.item.mode]), [['/compact keep the ids', 'queue'], ['/compact', 'next-step']]);
  assert.equal(steering.waiting(), false); // not a message for the model: the turn is not asked again for it
  assert.deepEqual(steering.take(), []);
  assert.equal(signal.aborted, false);

  const calls = [];
  const done = await runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 100, signal: runner.abort.signal });
  assert.equal(done, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].continueTask, true); // in the middle of a task
  assert.doesNotMatch(calls[0].prompt, /special attention/); // the queued one (with its focus) still waits
  assert.deepEqual(runner.inbox.map((m) => m.text), ['/compact keep the ids']);
  const compacted = events.find((e) => e.type === 'compacted');
  assert.equal(compacted.summary, 'THE SUMMARY');
  assert.equal(compacted.auto, false);
  assert.equal(compacted.tokensBefore, 100);
  assert.ok(events.some((e) => e.type === 'pending-removed'));
  assert.ok(events.some((e) => e.type === 'compacting'));
});

test('/compact in interrupt mode cuts the current turn short', async () => {
  const { runner } = await busyRunner('Compact interrupt', 'interrupt');
  const signal = runner.steering().turnSignal(runner.abort.signal);
  runner.receive({ type: 'steer', text: '/compact', mode: 'interrupt' });
  assert.equal(signal.aborted, true);
  const calls = [];
  assert.equal(await runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 0, signal: runner.abort.signal }), true);
  assert.equal(calls.length, 1);
});

test('automatic compaction follows the steering mode: now, or after the task with "queue"', async () => {
  const calls = [];
  const next = await busyRunner('Auto next-step', 'next-step');
  assert.equal(await next.runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 7999, signal: next.runner.abort.signal }), false);
  assert.equal(await next.runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 8000, signal: next.runner.abort.signal }), true);
  assert.equal(calls.length, 1);
  assert.equal(next.events.find((e) => e.type === 'compacted').auto, true);

  const queued = await busyRunner('Auto queue', 'queue');
  assert.equal(await queued.runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 11999, signal: queued.runner.abort.signal }), false);
  assert.equal(calls.length, 1); // postponed: settle() does it when the task has ended
  // ...unless the conversation has grown so far past the threshold that waiting would risk the model's limit.
  assert.equal(await queued.runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 12000, signal: queued.runner.abort.signal }), true);
  assert.equal(calls.length, 2);

  const off = await busyRunner('Auto off', 'next-step');
  off.runner.settings.autoCompact.enabled = false;
  assert.equal(await off.runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 90000, signal: off.runner.abort.signal }), false);
  assert.equal(calls.length, 2);
});

test('mid-task the task goes into the new conversation word for word; before a task there is nothing to continue', async () => {
  const { runner } = await busyRunner('Compact carry');
  const calls = [];
  const images = ['data:image/png;base64,AA'];
  await runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 9000, signal: runner.abort.signal, task: 'THE WHOLE TASK', images });
  assert.deepEqual([calls[0].continueTask, calls[0].carry], [true, { task: 'THE WHOLE TASK', images }]);
  runner.transcript.push({ type: 'turn-end', usage: { input: 9000, output: 1 } });
  await runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 0, signal: runner.abort.signal, task: 'THE WHOLE TASK', images, start: true });
  assert.deepEqual([calls[1].continueTask, calls[1].carry], [false, null]);
});

test('the first turn of a task counts the size the last task ended with', async () => {
  const { runner } = await busyRunner('Carried size');
  runner.transcript.push({ type: 'turn-end', usage: { input: 50000, output: 1 } });
  const calls = [];
  assert.equal(await runner.compaction().beforeTurn({ session: compactingSession(calls), inputTokens: 0, signal: runner.abort.signal }), true);
  assert.equal(calls.length, 1);
});

test('a failed automatic compaction is shown, the task goes on, and it is not tried again in that task', async () => {
  const { runner, events } = await busyRunner('Auto fails');
  const calls = [];
  const hook = runner.compaction();
  assert.equal(await hook.beforeTurn({ session: compactingSession(calls, { fail: true }), inputTokens: 90000, signal: runner.abort.signal }), false);
  assert.deepEqual(events.filter((e) => e.type === 'compact-failed').map((e) => [e.auto, e.message]), [[true, 'HTTP 500']]);
  assert.equal(await hook.beforeTurn({ session: compactingSession(calls), inputTokens: 90000, signal: runner.abort.signal }), false);
  assert.equal(calls.length, 1);
  // A /compact the user asked for is tried whatever happened before.
  runner.receive({ type: 'steer', text: '/compact', mode: 'next-step' });
  assert.equal(await hook.beforeTurn({ session: compactingSession(calls), inputTokens: 0, signal: runner.abort.signal }), true);
});

test('Stop during a compaction is passed on, not shown as a failure', async () => {
  const { runner, events } = await busyRunner('Compact stopped');
  runner.abort.abort();
  const session = { compact: async () => { throw new DOMException('aborted', 'AbortError'); } };
  await assert.rejects(runner.runCompaction(session, { signal: runner.abort.signal }), { name: 'AbortError' });
  assert.equal(events.some((e) => e.type === 'compact-failed'), false);
});

test('when the task has ended: waiting /compact requests first, then the messages that waited', async () => {
  const { runner } = await busyRunner('Settle');
  runner.abort = null; // the task is over
  const order = [];
  runner.compactIdle = async (options) => { order.push(['compact', options.focus, options.auto]); };
  runner.drainInbox = () => order.push(['drain']);
  runner.inbox.push({ id: 'a', text: '/compact keep ids', model: '', mode: 'queue', now: false, compact: { focus: 'keep ids' } });
  runner.inbox.push({ id: 'b', text: 'then email me', model: 'then email me', mode: 'queue', now: false });
  await runner.settle();
  assert.deepEqual(order, [['compact', 'keep ids', false], ['drain']]);
  assert.deepEqual(runner.inbox.map((m) => m.id), ['b']); // the message is not swallowed by the compaction
});

test('a Stop during the compaction after a task leaves the waiting messages for the user', async () => {
  const { runner } = await busyRunner('Settle stopped');
  runner.abort = null;
  runner.compactIdle = async () => 'stopped';
  let drained = false;
  runner.drainInbox = () => { drained = true; };
  runner.inbox.push({ id: 'a', text: '/compact', model: '', mode: 'queue', now: false, compact: { focus: '' } });
  await runner.settle();
  assert.equal(drained, false);
});

test('a /compact typed after a Stop leaves what the Stop left waiting, and reads what came during it', async () => {
  const { runner } = await busyRunner('Compact after stop');
  runner.abort = null;
  runner.inbox.push({ id: 'left', text: 'left over', model: 'left over', mode: 'queue', now: false });
  const started = [];
  runner.start = (text) => started.push(text);
  runner.compactIdle = async () => {
    runner.inbox.push({ id: 'during', text: 'sent meanwhile', model: 'sent meanwhile', mode: 'next-step', now: false });
    return 'done';
  };
  runner.requestCompact('', 'next-step');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ['sent meanwhile']);
  assert.deepEqual(runner.inbox.map((m) => m.id), ['left']);

  // A compaction that is stopped reads nothing at all.
  runner.compactIdle = async () => 'stopped';
  runner.inbox.push({ id: 'again', text: 'x', model: 'x', mode: 'next-step', now: false });
  runner.requestCompact('', 'next-step');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ['sent meanwhile']);
});

test('when the task has ended with the conversation over the threshold, it is compacted before the next task', async () => {
  const { runner } = await busyRunner('Settle auto', 'queue');
  runner.abort = null;
  runner.transcript.push({ type: 'turn-end', usage: { input: 9000, output: 1 } });
  const order = [];
  runner.compactIdle = async (options) => { order.push(['compact', options.auto]); };
  runner.drainInbox = () => order.push(['drain']);
  await runner.settle();
  assert.deepEqual(order, [['compact', true], ['drain']]);

  runner.transcript.push({ type: 'compacted', summary: 'S' });
  order.length = 0;
  await runner.settle();
  assert.deepEqual(order, [['drain']]); // nothing left to compact
});

test('/compact with nothing in the chat says so instead of asking a model', async () => {
  const meta = await sessions.createStoredSession('Empty compact');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const events = [];
  runner.emit = (e) => events.push(e);
  assert.equal(await runner.compactIdle({}), 'failed');
  assert.deepEqual(events.map((e) => [e.type, e.code]), [['compact-failed', 'nothing']]);
  assert.equal(runner.running, false);
});

test('the access mode in force now goes to the new conversation, not the one the session started with', async () => {
  const { runner } = await busyRunner('Compact access');
  const seen = [];
  const session = { compact: async (options) => { seen.push(options.accessState); return { summary: 'S', usage: null }; } };
  await runner.runCompaction(session, { signal: runner.abort.signal });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0], 'function', 'the mode is read when the new conversation is built');
  assert.deepEqual(seen[0](), runner.access.state());
});

test('a mode that moved while the summary was written reaches the new conversation', async () => {
  const { runner } = await busyRunner('Compact access moved');
  let mode = { mode: 'ask-first', revision: 1 };
  runner.access.state = () => mode;
  let seen = null;
  const session = {
    compact: async (options) => {
      // The summary takes a while, and the user changes the mode in the mean time.
      mode = { mode: 'full-access', revision: 2 };
      seen = options.accessState();
      return { summary: 'S', usage: null };
    },
  };
  await runner.runCompaction(session, { signal: runner.abort.signal });
  assert.equal(seen.mode, 'full-access', 'the new conversation describes the mode that is in force now');
});

test('a task that is itself over the threshold is compacted once, not again at every turn', async () => {
  const { runner } = await busyRunner('Compact no shrink');
  const calls = [];
  const hook = runner.compaction();
  const turn = (inputTokens) => hook.beforeTurn({ session: compactingSession(calls), inputTokens, signal: runner.abort.signal });
  assert.equal(await turn(9000), true); // over the 8,000 threshold: compacted
  assert.equal(await turn(0), false); // nothing read since: nothing to judge
  assert.equal(await turn(9500), false); // read after it, still over: it did not help
  assert.equal(await turn(9600), false); // so it is not tried again in this task
  assert.equal(calls.length, 1);

  const { runner: helped } = await busyRunner('Compact shrinks');
  const again = [];
  const second = helped.compaction();
  const next = (inputTokens) => second.beforeTurn({ session: compactingSession(again), inputTokens, signal: helped.abort.signal });
  assert.equal(await next(9000), true);
  assert.equal(await next(2000), false); // it helped
  assert.equal(await next(9000), true); // and a long task may need it again
  assert.equal(again.length, 2);
});

test('a compaction that did not shrink the conversation waits for it to grow again', async () => {
  const { runner } = await busyRunner('Compact waits for growth');
  const calls = [];
  const hook = runner.compaction();
  const turn = (inputTokens) => hook.beforeTurn({ session: compactingSession(calls), inputTokens, signal: runner.abort.signal });
  assert.equal(await turn(9000), true); // compacted
  assert.equal(await turn(9500), false); // it did not shrink: another summary is not paid for yet
  assert.equal(await turn(10000), false); // still waiting
  assert.equal(calls.length, 1);
  assert.equal(await turn(11500), true, // the conversation grew past the size it had: it is compacted again
    true);
  assert.equal(calls.length, 2);
});

test('a conversation past the urgent limit is compacted even when it is waiting for growth', async () => {
  const { runner } = await busyRunner('Compact urgent');
  const calls = [];
  const hook = runner.compaction();
  const turn = (inputTokens) => hook.beforeTurn({ session: compactingSession(calls), inputTokens, signal: runner.abort.signal });
  assert.equal(await turn(9000), true); // compacted
  assert.equal(await turn(9500), false); // it did not shrink
  assert.equal(await turn(12000), true, 'past 1.5 times the threshold the model\'s own limit is closer');
  assert.equal(calls.length, 2);
});

test('a task that ended while the conversation is waiting for growth is not compacted again', async () => {
  const { runner } = await busyRunner('Compact settle');
  const calls = [];
  const hook = runner.compaction();
  const turn = (inputTokens) => hook.beforeTurn({ session: compactingSession(calls), inputTokens, signal: runner.abort.signal });
  assert.equal(await turn(9000), true); // compacted
  assert.equal(await turn(9500), false); // it did not shrink
  runner.abort = null;
  runner.transcript.push({ type: 'user', text: 'task' });
  await runner.settle({});
  assert.equal(calls.length, 1, 'the end of the task does not pay for another summary');
});

test('an idle compaction keeps the session that holds the conversation, even the backup\'s', async () => {
  const { runner, events } = await busyRunner('Compact keeps session');
  runner.abort = null;
  runner.transcript.push({ type: 'user', text: 'task' });
  const calls = [];
  runner.session = { switched: true, ...compactingSession(calls) };
  runner.prepareModelSession = () => assert.fail('the session must not be rebuilt on the provider that failed');
  assert.equal(await runner.compactIdle({}), 'done');
  assert.equal(calls.length, 1);
  assert.ok(events.some((e) => e.type === 'compacted'));
});

test('a /compact that arrives while one runs is done after it', async () => {
  const { runner } = await busyRunner('Compact during compact');
  runner.abort = null;
  const focuses = [];
  runner.compactIdle = async ({ focus }) => {
    focuses.push(focus);
    if (focuses.length === 1) runner.inbox.push({ id: 'late', text: '/compact more', model: '', mode: 'next-step', now: false, compact: { focus: 'more' } });
    return 'done';
  };
  runner.drainInbox = () => focuses.push('drained');
  runner.inbox.push({ id: 'first', text: '/compact', model: '', mode: 'queue', now: false, compact: { focus: '' } });
  await runner.settle();
  assert.deepEqual(focuses, ['', 'more', 'drained']);
  assert.deepEqual(runner.inbox, []);
});
