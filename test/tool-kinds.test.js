// The kinds of the two new tools: what their result is, so batching and
// trimming treat them right.
//
// These kinds say nothing about what a session may do: that is the access
// authority's business. A kind only says what a result is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, TOOL_KINDS } from '../src/agent/tool-kinds.js';
import { toolDefinitions } from '../src/agent/tools.js';
import { runAgent } from '../src/agent/agent.js';

test('a read of one selected value is a reader: it is not a page state', () => {
  assert.equal(kindOf('read_field'), 'reader');
  assert.equal(kindOf('insert_text'), 'observe');
});

test('the kinds of the old tools are unchanged', () => {
  assert.equal(kindOf('read_page'), 'observe');
  assert.equal(kindOf('get_text'), 'reader');
  assert.equal(kindOf('screenshot'), 'reader');
  assert.equal(kindOf('list_tabs'), 'reader');
  assert.equal(kindOf('note'), 'bookkeeping');
  assert.equal(kindOf('read_notes'), 'notes');
  assert.equal(kindOf('ask_user'), 'boundary');
  assert.equal(kindOf('choose_suggestion'), 'boundary');
  assert.equal(kindOf('done'), 'done');
});

test('every tool the model is offered has a kind', () => {
  for (const { name } of toolDefinitions({ vision: true, allowJavascript: true })) {
    assert.ok(TOOL_KINDS[name], `${name} has no kind`);
  }
});

test('an unknown tool counts as a page observation, the safe default', () => {
  assert.equal(kindOf('a_tool_that_does_not_exist'), 'observe');
});

test('a read of a value does not take the page state away from the action before it', async () => {
  const session = {
    results: [],
    turns: [
      { text: '', toolCalls: [{ id: '1', name: 'click', args: { index: 2 } }, { id: '2', name: 'read_field', args: { index: 0 } }] },
      { text: '', toolCalls: [{ id: '3', name: 'done', args: { report: 'ok', success: true } }] },
    ],
    addUserMessage() {},
    addToolResult(id, output) { this.results.push({ id, output }); },
    async next() { return this.turns.shift(); },
  };
  const seen = [];
  await runAgent({
    session,
    task: 't',
    maxSteps: 5,
    emit: () => {},
    execute: async (name, _args, opts) => { seen.push([name, opts.observe]); return { output: 'ok' }; },
  });
  // The click still reports the page state: the read of a value is not a page
  // state that would replace it.
  assert.deepEqual(seen, [['click', true], ['read_field', true]]);
});
