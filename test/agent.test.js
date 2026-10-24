import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';
import { formatSnapshot, normalizeUrl, toolDefinitions } from '../src/agent/tools.js';
import { renderMarkdown, reportFileName } from '../src/sidepanel/markdown.js';

/** Scripted provider session: returns the queued turns in order and records results. */
function scriptedSession(turns) {
  const session = {
    users: [],
    results: [],
    choices: [],
    addUserMessage: (text) => session.users.push(text),
    addToolResult: (id, output) => session.results.push({ id, output }),
    next: async ({ toolChoice = 'auto' } = {}) => {
      session.choices.push(toolChoice);
      return turns.shift() ?? { text: 'summary', toolCalls: [] };
    },
  };
  return session;
}

const call = (id, name, args = {}) => ({ id, name, args });

test('runAgent executes tools and finishes on done', async () => {
  const session = scriptedSession([
    { text: '', toolCalls: [call('1', 'navigate', { url: 'x.com' })] },
    { text: '', toolCalls: [call('2', 'done', { report: 'All good', success: true })] },
  ]);
  const executed = [];
  const events = [];
  await runAgent({
    session,
    task: 'go',
    maxSteps: 5,
    emit: (e) => events.push(e),
    execute: async (name, args) => {
      executed.push([name, args]);
      return { output: 'ok' };
    },
  });
  assert.deepEqual(executed, [['navigate', { url: 'x.com' }]]);
  assert.deepEqual(session.results.map((r) => r.id), ['1', '2']);
  assert.deepEqual(events.at(-1), { type: 'final', report: 'All good', success: true });
});

test('runAgent answers every tool call even when stopped mid-turn', async () => {
  const controller = new AbortController();
  const session = scriptedSession([
    { text: '', toolCalls: [call('a', 'click', { index: 1 }), call('b', 'click', { index: 2 })] },
  ]);
  await assert.rejects(
    runAgent({
      session,
      task: 't',
      maxSteps: 5,
      signal: controller.signal,
      emit: () => {},
      execute: async () => {
        controller.abort();
        return { output: 'clicked' };
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(session.results.map((r) => r.id), ['a', 'b']);
  assert.match(session.results[1].output, /Not executed/);
});

test('runAgent asks for a tool-free summary at the step limit', async () => {
  const session = scriptedSession([
    { text: '', toolCalls: [call('1', 'scroll', { direction: 'down' })] },
    { text: '', toolCalls: [call('2', 'scroll', { direction: 'down' })] },
  ]);
  const events = [];
  await runAgent({ session, task: 't', maxSteps: 2, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });
  assert.equal(session.choices.at(-1), 'none');
  assert.deepEqual(events.at(-1), { type: 'final', report: 'summary', success: false });
});

test('toolDefinitions hides screenshot and javascript tools when disabled', () => {
  const names = (opts) => toolDefinitions(opts).map((t) => t.name);
  assert.ok(!names({ vision: false, allowJavascript: false }).includes('screenshot'));
  assert.ok(!names({ vision: false, allowJavascript: false }).includes('run_javascript'));
  assert.ok(names({ vision: true, allowJavascript: true }).includes('run_javascript'));
});

test('formatSnapshot and normalizeUrl produce model-readable output', () => {
  const text = formatSnapshot({
    url: 'https://a.b', title: 'T', scroll: { y: 0, viewport: 800, height: 1600 },
    elements: ['[0] button "Go"'], offscreen: 3, text: 'hello',
  });
  assert.match(text, /\[0\] button "Go"/);
  assert.match(text, /3 more further down/);
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('http://x.y'), 'http://x.y');
});

test('renderMarkdown escapes HTML and only links http(s) URLs', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](https://a.b)');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /<a href="https:\/\/a\.b"/);
});

test('a report downloads as a markdown file named after the session', () => {
  assert.equal(reportFileName('Cheapest laptops', '2026-10-24'), 'Cheapest-laptops-2026-10-24.md');
  assert.equal(reportFileName('New session', '2026-10-24', 'New session'), 'report-2026-10-24.md');
  assert.equal(reportFileName('أرخص لابتوب', '2026-10-24'), 'أرخص-لابتوب-2026-10-24.md');
  assert.equal(reportFileName('a/b:c', '2026-10-24'), 'a-b-c-2026-10-24.md');
});

test('renderMarkdown renders tables, lists and headings', () => {
  const html = renderMarkdown('## Title\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<h4>Title<\/h4>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test('a turn with several actions runs them in order and only the last observes the page', async () => {
  const session = scriptedSession([
    { text: '', toolCalls: [call('1', 'type_text', { index: 0, text: 'a' }), call('2', 'type_text', { index: 1, text: 'b' }), call('3', 'click', { index: 2 })] },
    { text: '', toolCalls: [call('4', 'done', { report: 'ok', success: true })] },
  ]);
  const executed = [];
  await runAgent({
    session,
    task: 't',
    maxSteps: 5,
    emit: () => {},
    execute: async (name, args, opts) => {
      executed.push([name, opts.observe]);
      return { output: 'ok' };
    },
  });
  assert.deepEqual(executed, [['type_text', false], ['type_text', false], ['click', true]]);
  assert.deepEqual(session.results.map((r) => r.id), ['1', '2', '3', '4']);
});

test('asking the user, or a failed action, defers the rest of the turn, done included', async () => {
  for (const [first, reason] of [[['ask_user', { question: 'Buy it?' }], /asked the user/], [['click', { index: 0 }], /failed/]]) {
    const session = scriptedSession([
      { text: '', toolCalls: [call('1', ...first), call('2', 'click', { index: 9 }), call('3', 'done', { report: 'bought', success: true })] },
      { text: '', toolCalls: [call('4', 'done', { report: 'ok', success: true })] },
    ]);
    const executed = [];
    const events = [];
    await runAgent({
      session, task: 't', maxSteps: 5, emit: (e) => events.push(e),
      execute: async (name) => {
        executed.push(name);
        return name === 'ask_user' ? { output: 'User answered: no' } : { output: 'Error: x', isError: true };
      },
    });
    assert.deepEqual(executed, [first[0]]);
    assert.match(session.results[1].output, reason);
    assert.match(session.results[2].output, reason);
    assert.equal(events.at(-1).report, 'ok');
  }
  // A failed action followed only by done must not report success either.
  const session = scriptedSession([
    { text: '', toolCalls: [call('1', 'click', { index: 0 }), call('2', 'done', { report: 'done!', success: true })] },
    { text: '', toolCalls: [call('3', 'done', { report: 'could not submit', success: false })] },
  ]);
  const events = [];
  await runAgent({ session, task: 't', maxSteps: 5, emit: (e) => events.push(e), execute: async () => ({ output: 'Error: gone', isError: true }) });
  assert.equal(events.at(-1).report, 'could not submit');
});

test('a batch stops when an action changes the page or fails, and every call still gets a result', async () => {
  for (const [first, reason] of [[{ output: 'moved', pageChanged: true }, /page changed/], [{ output: 'Error: x', isError: true }, /failed/]]) {
    const session = scriptedSession([
      { text: '', toolCalls: [call('1', 'click', { index: 0 }), call('2', 'type_text', { index: 1, text: 'b' }), call('3', 'done', { report: 'r' })] },
      { text: '', toolCalls: [call('4', 'done', { report: 'ok', success: true })] },
    ]);
    const executed = [];
    await runAgent({
      session,
      task: 't',
      maxSteps: 5,
      emit: () => {},
      execute: async (name) => {
        executed.push(name);
        return first;
      },
    });
    assert.deepEqual(executed, ['click']);
    assert.deepEqual(session.results.map((r) => r.id), ['1', '2', '3', '4']);
    assert.match(session.results[1].output, reason);
    assert.match(session.results[2].output, reason);
  }
});
