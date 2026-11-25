import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';
import { createToolExecutor, formatSnapshot, normalizeUrl, toolDefinitions } from '../src/agent/tools.js';
import { BrowserController } from '../src/browser/controller.js';
import { AccessAuthority, FULL_ACCESS } from '../src/permissions/policy.js';
import { renderMarkdown, renderMarkdownToDom, reportFileName } from '../src/sidepanel/markdown.js';

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

test('the next model turn receives a worker mode change after pending tool results', async () => {
  let state = { mode: 'ask-first', revision: 1 };
  const session = scriptedSession([
    { toolCalls: [call('1', 'click', { index: 1 })] },
    { toolCalls: [call('2', 'done', { report: 'ok' })] },
  ]);
  const original = session.addUserMessage;
  session.addUserMessage = (text) => {
    if (text.includes('[Worker access update:')) assert.equal(session.results[0].id, '1');
    original(text);
  };
  await runAgent({ session, task: 'click', maxSteps: 2, emit() {}, getAccessState: () => state,
    execute: async () => { state = { mode: 'full-access', revision: 2 }; return { output: 'Clicked' }; },
  });
  assert.match(session.users[1], /Worker access update.*full-access/);
});

test('an attached picture is sent with the task', async () => {
  const seen = [];
  const session = {
    addUserMessage: (text, images) => seen.push({ text, images }),
    addToolResult() {},
    next: async () => ({ text: '', toolCalls: [call('1', 'done', { report: 'ok', success: true })] }),
  };
  await runAgent({ session, task: 'look', images: ['data:image/jpeg;base64,aa'], maxSteps: 2, emit: () => {}, execute: async () => ({ output: 'ok' }) });
  assert.equal(seen[0].text, 'look');
  assert.deepEqual(seen[0].images, ['data:image/jpeg;base64,aa']);
});

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

test('navigate and open_tab allow only http and https URLs', async () => {
  for (const forbidden of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///C:/Windows/win.ini', 'chrome://settings', 'about:blank', 'ftp://files.example.com']) {
    assert.throws(() => normalizeUrl(forbidden), /only http and https/i, `normalizeUrl must reject ${forbidden}`);
  }

  const access = new AccessAuthority({ sessionId: 'b6-nav' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  const fakeBrowser = {
    overlay: {},
    currentTab: async () => ({ id: 1, url: 'https://example.com' }),
    captureTarget: async () => ({ scope: 'tab', kind: 'tab', tabId: 1, url: 'https://example.com' }),
    validateTarget: async () => ({ ok: true }),
    navigate: async () => { throw new Error('browser.navigate should not be called'); },
    openTab: async () => { throw new Error('browser.openTab should not be called'); },
  };
  const execute = createToolExecutor(fakeBrowser, { access });
  for (const tool of ['navigate', 'open_tab']) {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://extensions']) {
      const res = await execute(tool, { url });
      assert.equal(res.isError, true, `${tool} should fail for ${url}`);
      assert.match(res.output, /only http and https/i);
    }
  }

  const controller = Object.create(BrowserController.prototype);
  await assert.rejects(() => controller.navigate('javascript:alert(1)'), /only http and https/i);
  await assert.rejects(() => controller.openTab('file:///C:/test.txt'), /only http and https/i);
});

test('renderMarkdown escapes HTML and only links http(s) URLs without re-matching inside href', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [data](data:text/html,hi) [ok](https://a.b)');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.match(html, /<a href="https:\/\/a\.b"/);

  // A Markdown link whose URL or label contains a URL or parentheses must not be re-matched by the autolinker.
  const nestedUrl = renderMarkdown('[Visit https://inner.example/path](https://outer.example/go?next=https://inner.example/path)');
  assert.equal(nestedUrl.split('<a ').length - 1, 1, 'single <a> tag without nested autolink corruption');
  assert.equal(
    nestedUrl,
    '<p><a href="https://outer.example/go?next=https://inner.example/path" target="_blank" rel="noopener noreferrer">Visit https://inner.example/path</a></p>',
  );

  // DOM builder builds element nodes directly without innerHTML and only links http(s).
  class MiniNode {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.textContent = '';
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    appendChild(child) { this.children.push(child); return child; }
  }
  const fakeDoc = {
    createElement: (tag) => new MiniNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };
  const root = new MiniNode('div');
  renderMarkdownToDom('[safe](https://example.com/a?u=https://example.org) [evil](javascript:alert(1)) https://auto.example/x', {
    document: fakeDoc,
    container: root,
  });
  const p = root.children[0];
  const links = p.children.filter((c) => c.tagName === 'A');
  assert.equal(links.length, 2);
  assert.equal(links[0].attributes.href, 'https://example.com/a?u=https://example.org');
  assert.equal(links[0].textContent, 'safe');
  assert.equal(links[1].attributes.href, 'https://auto.example/x');
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
