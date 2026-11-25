import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackSession, handoffMessage } from '../src/agent/fallback-session.js';

/** A session whose `next` answers come from a script; a script entry that is an Error is thrown. */
function fakeSession(script) {
  const s = { received: [], calls: 0 };
  s.addUserMessage = (text, images = []) => s.received.push({ kind: 'user', text, images });
  s.addToolResult = (callId, output, images = []) => s.received.push({ kind: 'tool', callId, output, images });
  s.next = async () => {
    const answer = script[s.calls++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return s;
}

const click = { text: '', toolCalls: [{ id: 'c1', name: 'click', args: { index: 3 } }] };
const report = { text: 'Done', toolCalls: [] };

test('a failing primary hands the task, its steps and the latest page to the backup', async () => {
  const primary = fakeSession([click, new Error('Model request failed (HTTP 429): limit')]);
  const backup = fakeSession([report]);
  const notices = [];
  const session = new FallbackSession({
    primary, createBackup: () => backup, labels: { primary: 'ChatGPT · gpt-6-sol', backup: 'OpenRouter · haiku' }, notify: (n) => notices.push(n),
  });

  session.addUserMessage('Search for "hello"');
  await session.next({});
  session.addToolResult('c1', 'Clicked [3] button "Go"\nPage state: Result: hello', ['data:image/jpeg;base64,AA']);
  const turn = await session.next({});

  assert.equal(turn, report);
  assert.equal(session.switched, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'error');
  assert.equal(notices[0].code, 'rate-limit'); // a 429 without daily or billing evidence
  const [handoff] = backup.received;
  assert.match(handoff.text, /Search for "hello"/);
  assert.match(handoff.text, /click .*index.*3.*Clicked \[3\] button "Go"/s);
  assert.match(handoff.text, /Result: hello/);
  assert.deepEqual(handoff.images, ['data:image/jpeg;base64,AA']);
});

test('later turns stay on the backup', async () => {
  const backup = fakeSession([click, report]);
  const session = new FallbackSession({ primary: fakeSession([new Error('HTTP 500')]), createBackup: () => backup, labels: {}, notify: () => {} });
  session.addUserMessage('task');
  await session.next({});
  session.addToolResult('c1', 'ok');
  assert.equal(await session.next({}), report);
  assert.equal(backup.received.at(-1).output, 'ok');
});

test('a user stop never switches providers', async () => {
  const stop = new DOMException('Stopped by user', 'AbortError');
  let built = false;
  const session = new FallbackSession({ primary: fakeSession([stop]), createBackup: () => { built = true; }, labels: {}, notify: () => {} });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), (err) => err === stop);
  assert.equal(built, false);
});

test('without a backup the original error comes through', async () => {
  const failure = new Error('HTTP 401: bad key');
  const session = new FallbackSession({ primary: fakeSession([failure]), labels: {}, notify: () => {} });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), (err) => err === failure);
});

test('when both providers fail the error and the notice name both reasons', async () => {
  const notices = [];
  const session = new FallbackSession({
    primary: fakeSession([new Error('HTTP 429: limit')]),
    createBackup: () => fakeSession([new Error('HTTP 401: bad key')]),
    labels: { primary: 'A', backup: 'B' },
    notify: (n) => notices.push(n),
  });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), /Primary failed: .*429.*Backup failed: .*401/s);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].level, 'error');
});

test('the handoff message tells the new model what not to repeat', () => {
  const text = handoffMessage({ task: 'Buy milk', notes: ['User answered: yes'], steps: [{ name: 'navigate', args: { url: 'shop.test' }, result: 'Loaded shop' }], last: { text: 'Cart: milk', images: [] } }, 'usage limit');
  assert.match(text, /usage limit/);
  assert.match(text, /Buy milk/);
  assert.match(text, /User answered: yes/);
  assert.match(text, /1\. navigate/);
  assert.match(text, /Cart: milk/);
  assert.match(text, /do not repeat/i);
});

test('a second task in the same session resets the handoff log to the current task and caps steps and argument size', async () => {
  const primary = fakeSession([click, report, click, new Error('Model request failed (HTTP 429): limit')]);
  const backup = fakeSession([report]);
  const session = new FallbackSession({
    primary,
    createBackup: () => backup,
    labels: { primary: 'A', backup: 'B' },
    notify: () => {},
  });

  // First task
  session.addUserMessage('First task: find shoes');
  await session.next({});
  session.addToolResult('c1', 'Clicked [3] shoes');
  await session.next({});

  // Second task in the same session
  session.addUserMessage('Second task: check headphones');
  assert.equal(session.log.currentTask, 'Second task: check headphones');
  assert.equal(session.log.task, 'Second task: check headphones');
  assert.equal(session.log.steps.length, 0, 'earlier task steps do not leak into the new task');
  assert.equal(session.log.notes.length, 0, 'earlier task notes do not leak into the new task');

  // Steer message during the second task stays a note, not a new task
  session.addUserMessage('Message from the user while you work (it may change or add to the task):\nPrefer wireless');
  assert.equal(session.log.currentTask, 'Second task: check headphones');
  assert.equal(session.log.notes.length, 1);

  await session.next({});
  session.addToolResult('c1', 'Clicked [3] headphones');
  await session.next({});

  const [handoff] = backup.received;
  assert.match(handoff.text, /Second task: check headphones/);
  assert.doesNotMatch(handoff.text, /First task: find shoes/);
  assert.doesNotMatch(handoff.text, /Clicked \[3\] shoes/);
  assert.match(handoff.text, /Prefer wireless/);

  // Long arguments and >40 steps are capped in handoffMessage
  const hugeArg = 'z'.repeat(2000);
  const manySteps = Array.from({ length: 50 }, (_, i) => ({
    name: 'type_text',
    args: { index: i, text: hugeArg },
    result: `step-${i}`,
  }));
  const cappedText = handoffMessage({ currentTask: 'Cap test', notes: [], steps: manySteps, last: null }, 'quota');
  assert.doesNotMatch(cappedText, /1\. type_text/, 'only the latest 40 steps are included');
  assert.match(cappedText, /11\. type_text/, 'starts at step 11 of 50');
  assert.doesNotMatch(cappedText, new RegExp(hugeArg), 'huge step arguments are truncated');
});
