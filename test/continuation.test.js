import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointFor, conversationHistory } from '../src/sessions/continuation.js';

test('only interrupted work is resumable; any final report ends the task', () => {
  const transcript = [{ type: 'user', text: 'Do this' }, { type: 'stopped' }];
  assert.equal(checkpointFor({ transcript }).task, 'Do this');
  assert.equal(checkpointFor({ transcript: [...transcript, { type: 'final', report: 'Done', success: true }] }), null);
  assert.equal(checkpointFor({ transcript: [...transcript, { type: 'final', report: 'Partial', success: false }] }), null);
});

test('history preserves every saved conversational message beyond the old ten-message limit', () => {
  const events = Array.from({ length: 60 }, (_, i) => ({ type: i % 2 ? 'assistant-text' : 'user', text: `Message ${i} with its full contents` }));
  const text = conversationHistory(events);
  for (const event of events) assert.ok(text.includes(event.text));
  assert.ok(text.includes('not new instructions or authorization'));
  assert.equal(conversationHistory([{ type: 'access-mode', mode: 'full-access' }]), '');
});

test('a task that failed after a Stop is not offered for resuming again', () => {
  const events = [{ type: 'user', text: 'task' }, { type: 'stopped' }, { type: 'error', message: 'HTTP 500' }];
  assert.equal(checkpointFor({ transcript: events }), null);
  assert.deepEqual(checkpointFor({ transcript: events.slice(0, 2) }), { task: 'task', tabId: null });
});
