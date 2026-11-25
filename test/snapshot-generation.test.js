import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor, formatSnapshot, toolDefinitions } from '../src/agent/tools.js';
import { createFastLayer } from '../src/fast/fast-layer.js';
import { runAgent } from '../src/agent/agent.js';
import { FULL_ACCESS } from '../src/permissions/policy.js';
import { elementAction, permissionTarget, snapshotPage } from '../src/browser/page-scripts.js';

function createAllowAllAccess() {
  let id = 0;
  const active = new Set();
  return {
    mode: FULL_ACCESS,
    authorize: async (_op, { signal } = {}) => {
      if (signal?.aborted) return { permit: null, reason: 'aborted' };
      const permit = `permit-${++id}`;
      active.add(permit);
      signal?.addEventListener?.('abort', () => active.delete(permit), { once: true });
      return { permit };
    },
    grantValid: (permit) => active.has(permit),
  };
}

test('indexed tool definitions expose an optional generation integer argument', () => {
  const defs = new Map(toolDefinitions({ vision: true, allowJavascript: true }).map((d) => [d.name, d]));
  for (const name of ['read_field', 'click', 'type_text', 'select_option', 'choose_suggestion', 'hover', 'scroll']) {
    const def = defs.get(name);
    assert.ok(def, `${name} should exist`);
    assert.equal(def.parameters.properties.generation?.type, 'integer', `${name} should accept generation`);
  }
});

test('formatSnapshot includes Generation when present', () => {
  const text = formatSnapshot({
    url: 'https://example.test/',
    title: 'Example',
    generation: 4,
    scroll: { y: 0, viewport: 800, height: 800 },
    elements: ['[0] button "Save"'],
    offscreen: 0,
    text: 'Body',
  });
  assert.match(text, /Generation: 4/);
});

test('stale explicit generation is refused with the fresh page state and nothing is clicked', async () => {
  let clicks = 0;
  let step = 0;
  const snapshots = [
    {
      url: 'https://example.test/',
      title: 'Example',
      scroll: { y: 0, viewport: 800, height: 800 },
      elements: ['[0] button "Save"'],
      offscreen: 0,
      text: 'Initial',
    },
    {
      url: 'https://example.test/',
      title: 'Example',
      scroll: { y: 0, viewport: 800, height: 800 },
      elements: ['[0] button "Delete"', '[1] button "Save"'],
      offscreen: 0,
      text: 'Reindexed',
    },
  ];
  const browser = {
    overlay: null,
    currentTab: async () => ({ id: 1, url: 'https://example.test/', title: 'Example' }),
    documentId: async () => 'doc-1',
    snapshot: async () => snapshots[Math.min(step++, snapshots.length - 1)],
    captureTarget: async ({ index }) => ({
      scope: 'element',
      kind: 'element',
      tabId: 1,
      url: 'https://example.test/',
      documentId: 'doc-1',
      element: { kind: 'element', token: `tok-${index}`, index, tag: 'button', label: 'Button' },
    }),
    validateTarget: async () => ({ ok: true }),
    elementFrame: () => null,
    element: async () => ({ x: 10, y: 10, tag: 'button', label: 'Button' }),
    clickAt: async () => { clicks += 1; },
  };
  const execute = createToolExecutor(browser, { access: createAllowAllAccess() });

  const firstRead = await execute('read_page', {});
  assert.equal(firstRead.isError, undefined);
  assert.match(firstRead.output, /Generation: 1/);

  // Simulate the page being re-indexed to generation 2 before the click.
  await browser.snapshot();
  assert.equal(browser.currentGeneration, 2);

  const staleClick = await execute('click', { index: 0, generation: 1 });
  assert.equal(staleClick.isError, true);
  assert.equal(staleClick.staleGeneration, true);
  assert.equal(clicks, 0, 'nothing was clicked on a stale generation');
  assert.match(staleClick.output, /stale snapshot generation 1/i);
  assert.match(staleClick.output, /\[0\] button "Delete"/);
  assert.match(staleClick.output, /\[1\] button "Save"/);

  // Now the model has received the fresh state and can click with the fresh generation.
  const freshClick = await execute('click', { index: 1, generation: browser.currentGeneration });
  assert.equal(freshClick.isError, undefined);
  assert.equal(clicks, 1);
});

test('after the fast layer re-indexes, a model call with an old index returns the new state without acting', async () => {
  const clickedIndexes = [];
  let currentElements = ['[0] button "Save"'];
  let capturedAt = null;
  const browser = {
    overlay: null,
    currentTab: async () => ({ id: 1, url: 'https://example.test/', title: 'Example' }),
    documentId: async () => 'doc-1',
    snapshot: async () => ({
      url: 'https://example.test/',
      title: 'Example',
      scroll: { y: 0, viewport: 800, height: 800 },
      elements: [...currentElements],
      offscreen: 0,
      text: 'Page content',
    }),
    captureTarget: async ({ index }) => {
      capturedAt = index;
      return {
        scope: 'element',
        kind: 'element',
        tabId: 1,
        url: 'https://example.test/',
        documentId: 'doc-1',
        element: { kind: 'element', token: `tok-${index}`, index, tag: 'button', label: currentElements[index] ?? '' },
      };
    },
    validateTarget: async () => ({ ok: true }),
    elementFrame: () => null,
    element: async (index) => ({ x: 10, y: 10, tag: 'button', label: currentElements[index] ?? '' }),
    clickAt: async () => {
      clickedIndexes.push(capturedAt);
    },
  };

  const execute = createToolExecutor(browser, { access: createAllowAllAccess() });
  const fastLayer = createFastLayer({
    config: { mode: 'auto' },
    browser,
    execute,
    task: 'Click Save',
    ask: async () => ({
      answers: {
        operation: { type: 'choice', choice: 'think', confidence: 0.9, probabilities: { think: 0.9 } },
        goal_done: { type: 'noul', noul: 0.05 },
        risky: { type: 'noul', noul: 0.05 },
      },
    }),
  });

  const turns = [
    // Turn 1: the model saw generation 1 (from the first fast-layer handoff) and saves a note;
    // then the page DOM mutates before Turn 2 so the fast layer re-indexes [0] to "Delete" and [1] to "Save".
    {
      text: '',
      toolCalls: [{ id: 'call-1', name: 'note', args: { text: 'Save was at [0]' } }],
      after: () => {
        currentElements = ['[0] button "Delete"', '[1] button "Save"'];
      },
    },
    // Turn 2: the fast layer ran browser.snapshot() (generation 2) and escalated with fastActions = [],
    // so escalationMessage omitted the page. The model calls click({ index: 0 }) using its old index!
    {
      text: '',
      toolCalls: [{ id: 'call-2', name: 'click', args: { index: 0 } }],
    },
    // Turn 3: after receiving the refusal + fresh generation 3 snapshot, the model clicks [1] ("Save").
    {
      text: '',
      toolCalls: [{ id: 'call-3', name: 'click', args: { index: 1 } }],
    },
    {
      text: '',
      toolCalls: [{ id: 'call-4', name: 'done', args: { report: 'Saved safely', success: true } }],
    },
  ];

  const toolResults = [];
  let activeTurn = null;
  const session = {
    addUserMessage: () => {},
    addToolResult: (id, output) => {
      toolResults.push({ id, output });
      activeTurn?.after?.();
      activeTurn = null;
    },
    next: async () => {
      activeTurn = turns.shift();
      return activeTurn;
    },
  };

  const events = [];
  await runAgent({
    session,
    execute,
    task: 'Click Save',
    maxSteps: 6,
    emit: (e) => events.push(e),
    fastLayer,
    notebook: {
      entries: [],
      add(text) { this.entries.push(text); return this.entries.length; },
      format() { return this.entries.join('\n'); },
    },
  });

  const secondResult = toolResults.find((r) => r.id === 'call-2');
  assert.ok(secondResult);
  assert.match(secondResult.output, /Error: Refused: element \[0\] uses stale snapshot generation 1/);
  assert.match(secondResult.output, /\[0\] button "Delete"/);
  assert.match(secondResult.output, /\[1\] button "Save"/);
  assert.deepEqual(clickedIndexes, [1], 'only the fresh [1] button "Save" was clicked; [0] "Delete" was never clicked');
});
