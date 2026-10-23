import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { COMPATIBLE_PRESETS, slotModels } from '../src/lib/settings.js';
import { createProviderForm } from '../src/sidepanel/provider-form.js';

/** A MiniMax session on the OpenAI-compatible endpoint. */
function makeSession(overrides = {}) {
  return new CompatibleSession({
    baseUrl: 'https://api.minimax.io/v1',
    apiKey: 'k',
    model: 'MiniMax-M3.1-Flash',
    effort: 'high',
    thinkingStyle: 'minimax',
    systemPrompt: 's',
    tools: [],
    ...overrides,
  });
}

/** A Chat Completions stream, one chunk per line. */
function sseResponse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let calls;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
}

test('the thinking comes from reasoning_details and stays in the conversation', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { reasoning_details: [{ text: 'Plan the step' }] } }] },
    { choices: [{ delta: { content: 'Opening' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');
  const events = [];

  const turn = await session.next({ onEvent: (e) => events.push(e) });

  assert.equal(turn.text, 'Opening');
  assert.deepEqual(events.filter((e) => e.type === 'reasoning-delta').map((e) => e.delta), ['Plan the step']);
  const stored = session.messages.at(-1);
  assert.deepEqual(stored.reasoning_details, [{ text: 'Plan the step' }]);
  assert.equal(stored.reasoning_content, undefined, 'the reasoning stays in the field it arrived in');
});

test('the thinking comes from reasoning_content when the provider sends it there', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { reasoning_content: 'Plan the step' } }] },
    { choices: [{ delta: { content: 'Opening' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');

  await session.next({});

  const stored = session.messages.at(-1);
  assert.equal(stored.reasoning_content, 'Plan the step');
  assert.equal(stored.reasoning_details, undefined);
});

test('a tool call keeps the thinking for the next turn', async () => {
  stubFetch((_url, _init, n) => (n === 1
    ? sseResponse([
      { choices: [{ delta: { reasoning_details: [{ text: 'Plan' }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{"url":"x.com"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    : sseResponse([
      { choices: [{ delta: { content: 'Done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])));
  const session = makeSession({ tools: [{ name: 'navigate', description: 'd', parameters: {} }] });
  session.addUserMessage('task');

  const turn = await session.next({});
  assert.deepEqual(turn.toolCalls, [{ id: 'c1', name: 'navigate', args: { url: 'x.com' } }]);
  session.addToolResult('c1', 'The page');
  await session.next({});

  const body = JSON.parse(calls[1].init.body);
  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.reasoning_details, [{ text: 'Plan' }]);
});

test('a thinking block inside the answer is not shown, also when it is split over chunks', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { content: '<thi' } }] },
    { choices: [{ delta: { content: 'nk>secret' } }] },
    { choices: [{ delta: { content: '</think>' } }] },
    { choices: [{ delta: { content: 'The answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');
  const shown = [];

  const turn = await session.next({ onEvent: (e) => { if (e.type === 'text-delta') shown.push(e.delta); } });

  assert.equal(turn.text, 'The answer');
  assert.deepEqual(shown, ['The answer']);
  // What travels back to the provider is the text as it was written.
  assert.equal(session.messages.at(-1).content, '<think>secret</think>The answer');
});

test('the thinking that arrives in chunks is one entry', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { reasoning_details: [{ text: 'Plan ' }] } }] },
    { choices: [{ delta: { reasoning_details: [{ text: 'the step' }] } }] },
    { choices: [{ delta: { content: 'Opening' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');

  await session.next({});

  assert.deepEqual(session.messages.at(-1).reasoning_details, [{ text: 'Plan the step' }]);
});

test('a thinking block whose closing tag is split over chunks is still dropped', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { content: '<think>secret</th' } }] },
    { choices: [{ delta: { content: 'ink>' } }] },
    { choices: [{ delta: { content: '\n\nThe answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');
  const shown = [];

  const turn = await session.next({ onEvent: (e) => { if (e.type === 'text-delta') shown.push(e.delta); } });

  assert.equal(turn.text, 'The answer', 'the blank lines the block left are not answer text');
  assert.deepEqual(shown, ['The answer']);
});

test('an answer that ends inside a thinking block is an error', async () => {
  stubFetch(() => sseResponse([
    { choices: [{ delta: { content: '<think>secret' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const session = makeSession();
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /ended inside a thinking block/);
});

test('a preset that serves no model list falls back to the models it names', () => {
  assert.deepEqual(slotModels('minimax', []), [{ id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', efforts: [], decision: false }]);
  assert.deepEqual(slotModels('minimax-coding-plan', []), [{ id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', efforts: [], decision: false }]);
  // A provider with a list of its own keeps it.
  assert.deepEqual(slotModels('openrouter', [{ id: 'a', name: 'a' }]), [{ id: 'a', name: 'a' }]);
  assert.deepEqual(slotModels('openrouter', []), []);
});

// A form is driven by the panel; this is the smallest stand-in for its fields.
function fakeElement() {
  const listeners = new Map();
  return {
    value: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
  };
}

function fakeForm(request) {
  const names = ['preset', 'provider', 'baseUrl', 'apiKey', 'modelInput', 'modelSelect', 'modelSearch', 'effort', 'refresh', 'test', 'testResult', 'modelInfo', 'chatgptSection', 'compatibleSection'];
  const fields = Object.fromEntries(names.map((name) => [name, fakeElement()]));
  const root = {
    querySelector: (selector) => fields[selector.match(/data-field="([^"]+)"/)[1]],
    addEventListener: () => {},
  };
  const form = createProviderForm(root, {
    request,
    getPresets: () => COMPATIBLE_PRESETS,
    keyStore: { show: () => {}, register: () => {} },
  });
  return { fields, form };
}

test('choosing MiniMax in the form offers its efforts, also when the model list fails', async () => {
  const { fields, form } = fakeForm(async (type) => {
    if (type === 'list-models') throw new Error('the model list is not available');
    return {};
  });
  form.fill({
    provider: 'compatible',
    chatgpt: { model: '', effort: '' },
    compatible: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: '', effort: '' },
  });

  fields.preset.value = 'minimax';
  fields.preset.dispatchEvent({ type: 'change' });
  // Before the model list comes back.
  assert.match(fields.effort.innerHTML, /value="xhigh"/);
  assert.doesNotMatch(fields.effort.innerHTML, /value="off"/, 'MiniMax cannot stop thinking');
  assert.equal(fields.baseUrl.value, 'https://api.minimax.io/v1');
  assert.equal(fields.modelInput.value, 'MiniMax-M3.1-Flash');

  await new Promise((resolve) => setTimeout(resolve, 0));

  // And after it failed: the efforts are still the ones of the preset.
  assert.match(fields.effort.innerHTML, /value="xhigh"/);
  assert.doesNotMatch(fields.effort.innerHTML, /value="off"/);
});
