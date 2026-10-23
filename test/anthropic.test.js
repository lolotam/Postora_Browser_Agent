import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage stand-in shared by the credential store.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
};

const {
  AnthropicSession, CLAUDE_CODE_IDENTITY, anthropicEfforts, anthropicThinking, listAnthropicModels,
} = await import('../src/providers/anthropic.js');
const { setAccountFlows } = await import('../src/providers/account-auth.js');

// The refresh of a Claude account, so the test can say what the provider answers.
let refreshed = { type: 'oauth', access: 'sk-ant-oat01-refreshed', refresh: 'rt2', expires: Date.now() + 3600e3 };
setAccountFlows({
  anthropicOAuth: {
    name: 'Anthropic (Claude Pro/Max)',
    async login() { throw new Error('the login flow is not used in this test'); },
    async refresh() { return refreshed; },
  },
});

const ACCOUNT_TOKEN = 'sk-ant-oat01-account-token';

function sseResponse(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** A stream with one text block and the closing events. */
function answer(text = 'Hello') {
  return sseResponse([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]);
}

let calls;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
}

/** A signed-in Claude account with a token that is good for an hour. */
function signedIn(token = ACCOUNT_TOKEN) {
  store['accountAuth.claude'] = { generation: 1, credential: { type: 'oauth', access: token, refresh: 'rt', expires: Date.now() + 3600e3 } };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

test('an account request carries the Claude Code identity and the system prompt after it', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-sonnet-4-6', effort: 'high', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  await session.next({});

  const { url, init } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
  assert.equal(init.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
  assert.equal(init.headers['x-app'], 'cli');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['Content-Type'], 'application/json');
  // The service worker sends this version as the User-Agent of the request.
  assert.equal(CLAUDE_CODE_IDENTITY.version, '2.1.280');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.system, [
    { type: 'text', text: CLAUDE_CODE_IDENTITY.systemLine },
    { type: 'text', text: 'SYS' },
  ]);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'claude-sonnet-4-6');
});

test('an API key request sends x-api-key and no identity line', async () => {
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'apiKey', apiKey: 'sk-ant-api03-key', model: 'claude-sonnet-4-5', effort: 'medium', systemPrompt: 'SYS', tools: [{ name: 'navigate', description: 'd', parameters: {} }] });
  session.addUserMessage('task');

  await session.next({});

  const { init } = calls[0];
  assert.equal(init.headers['x-api-key'], 'sk-ant-api03-key');
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.headers['x-app'], undefined);
  const body = JSON.parse(init.body);
  // An API key pays for the cache, so the last system block and the last tool
  // carry the breakpoint.
  assert.deepEqual(body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.tools, [{ name: 'navigate', description: 'd', input_schema: {}, cache_control: { type: 'ephemeral' } }]);
});

test('adaptive models take an effort and budget models a token budget', async () => {
  assert.deepEqual(anthropicThinking('claude-opus-5-5', 'high'), { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, output_config: { effort: 'high' } });
  assert.deepEqual(anthropicThinking('claude-sonnet-4-6', 'medium'), { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
  assert.deepEqual(anthropicThinking('claude-sonnet-4-5', 'low'), { thinking: { type: 'enabled', budget_tokens: 2048 } });
  assert.deepEqual(anthropicThinking('claude-sonnet-4-5', 'medium'), { thinking: { type: 'enabled', budget_tokens: 8192 } });
  assert.deepEqual(anthropicThinking('claude-sonnet-4-5', 'high'), { thinking: { type: 'enabled', budget_tokens: 16384 } });
  // Only a model that allows it can be told not to think.
  assert.deepEqual(anthropicThinking('claude-sonnet-4-5', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(anthropicThinking('claude-sonnet-5', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(anthropicThinking('claude-opus-5', 'off'), { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } });
  assert.deepEqual(anthropicThinking('claude-sonnet-5-5', 'off'), { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } }, 'Claude Sonnet 5.5 cannot be told not to think');
  assert.deepEqual(anthropicThinking('claude-haiku-5-5', 'off'), { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } });
  // No effort means the model decides for itself.
  assert.deepEqual(anthropicThinking('claude-opus-5-5', ''), { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } }, 'a binding model always asks for binding');
  assert.deepEqual(anthropicEfforts('claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(anthropicEfforts('claude-haiku-4-5'), ['low', 'medium', 'high']);
  assert.equal(anthropicEfforts('claude-sonnet-5-5').includes('off'), false);
});

test('a model nobody knows gets a modest output limit', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-9-9', effort: 'high', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  await session.next({});

  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 32000);
});

test('the request carries the thinking the model takes and room for it', async () => {
  signedIn();
  stubFetch(() => answer());
  const adaptive = new AnthropicSession({ auth: 'account', model: 'claude-sonnet-4-6', effort: 'high', systemPrompt: 'SYS', tools: [] });
  adaptive.addUserMessage('task');
  await adaptive.next({});
  const adaptiveBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(adaptiveBody.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptiveBody.output_config, { effort: 'high' });
  assert.ok(adaptiveBody.max_tokens > 16384, 'the output limit stays above the thinking budget');

  calls = [];
  stubFetch(() => answer());
  const budget = new AnthropicSession({ auth: 'account', model: 'claude-sonnet-4-5', effort: 'medium', systemPrompt: 'SYS', tools: [] });
  budget.addUserMessage('task');
  await budget.next({});
  const budgetBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(budgetBody.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.equal(budgetBody.output_config, undefined);
  assert.ok(budgetBody.max_tokens > 8192);
});

test('the stream is read as text, thinking with its signature and a call with streamed arguments', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Opening' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"url":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x.com"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [{ name: 'navigate', description: 'd', parameters: {} }] });
  session.addUserMessage('task');
  const events = [];
  const turn = await session.next({ onEvent: (e) => events.push(e) });

  assert.equal(turn.text, 'Opening');
  assert.deepEqual(turn.toolCalls, [{ id: 'toolu_1', name: 'navigate', args: { url: 'x.com' } }]);
  assert.deepEqual(turn.usage, { input_tokens: 12, output_tokens: 20 });
  assert.deepEqual(events.map((e) => e.type), ['reasoning-delta', 'text-delta']);
});

test('the signed thinking and the call travel back unchanged', async () => {
  signedIn();
  stubFetch((_url, _init, n) => (n === 1
    ? sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":"x.com"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    : answer('Done')));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  await session.next({});
  session.addToolResult('toolu_1', 'The page');
  await session.next({});

  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Plan', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: { url: 'x.com' } },
    ],
  });
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'The page' }] }],
  });
});

test('a stream that ends without message_stop is an error', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } },
    { type: 'content_block_stop', index: 0 },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];
  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /ended before the answer was complete/);
  assert.ok(events.some((e) => e.type === 'text-reset'), 'the half answer is withdrawn');
  assert.deepEqual(session.messages.length, 1, 'nothing is kept of the failed turn');
});

test('an error inside the stream is an error', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];
  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /Overloaded/);
  assert.ok(events.some((e) => e.type === 'text-reset'));
  assert.deepEqual(session.messages, [{ role: 'user', content: [{ type: 'text', text: 'task' }] }], 'the failed turn is not kept');
});

test('a call with broken arguments is not run', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), /broken arguments/);
  assert.deepEqual(session.messages.length, 1, 'the failed turn is not kept');
});

test('a call with broken arguments after some text withdraws the text', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];
  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /broken arguments/);
  assert.ok(events.some((e) => e.type === 'text-reset'), 'the half answer is withdrawn');
  assert.deepEqual(session.messages.length, 1, 'the failed turn is not kept');
});

test('an empty text block is dropped, so the next request is accepted', async () => {
  signedIn();
  stubFetch((_url, _init, n) => (n === 1
    ? sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":"x.com"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    : answer('Done')));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  await session.next({});
  session.addToolResult('toolu_1', 'The page');
  await session.next({});

  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body.messages[1].content, [{ type: 'tool_use', id: 'toolu_1', name: 'navigate', input: { url: 'x.com' } }]);
});

test('a result with nothing to say carries no empty text block', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  session.addToolResult('toolu_1', '');
  await session.next({});

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.messages[1].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '' }]);
});

test('only the newest screenshot of a tool result is kept', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  for (let n = 1; n <= 4; n += 1) session.addToolResult(`toolu_${n}`, 'The page', [`data:image/jpeg;base64,SHOT${n}`]);

  await session.next({});

  const body = JSON.parse(calls[0].init.body);
  const images = [];
  for (const message of body.messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool_result') continue;
      for (const part of block.content ?? []) if (part.type === 'image') images.push(part.source.data);
    }
  }
  assert.deepEqual(images, ['SHOT4']);
});

test('thinking without a signature is not part of the answer', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.equal(turn.text, '', 'thinking is not answer text');
  // The history keeps it as plain text, so the model still sees what it thought.
  assert.deepEqual(session.messages.at(-1).content, [{ type: 'text', text: 'Plan' }]);
});

test('a reply that hit the output limit is an error', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cut off' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /output limit/);

  assert.deepEqual(session.messages.length, 1, 'the cut-off turn is not kept');
});

test('a call that came with the output limit is still a call', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"x.com"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.deepEqual(turn.toolCalls, [{ id: 'toolu_1', name: 'navigate', args: { url: 'x.com' } }]);
});

test('a refused token is refreshed and the request is made again', async () => {
  signedIn();
  stubFetch((_url, _init, n) => (n === 1
    ? Response.json({ error: { message: 'invalid token' } }, { status: 401 })
    : answer('Hello')));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.equal(turn.text, 'Hello');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-ant-oat01-refreshed');
  assert.equal(store['accountAuth.claude'].credential.access, 'sk-ant-oat01-refreshed', 'the new token is stored');
});

test('a token that is refused again after the refresh is an error, not a loop', async () => {
  signedIn();
  stubFetch(() => Response.json({ error: { message: 'invalid token' } }, { status: 401 }));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /Claude request failed \(HTTP 401\)/);

  assert.equal(calls.length, 2, 'the request is made once more, not again and again');
});

test('the model list names the models with the efforts they take', async () => {
  signedIn();
  stubFetch(() => Response.json({ data: [
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ] }));

  const models = await listAnthropicModels({ auth: 'account' });

  assert.deepEqual(models.map((m) => [m.id, m.efforts]), [
    ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-haiku-4-5', ['low', 'medium', 'high']],
  ]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
});

test('a screenshot travels as a base64 image block', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task', ['data:image/jpeg;base64,QUJD']);

  await session.next({});

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
});

test('a connection that drops after some text withdraws the text', async () => {
  signedIn();
  const encoder = new TextEncoder();
  const lines = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  stubFetch(() => new Response(new ReadableStream({
    // The lines are read first; the connection drops on the read after them
    // (an error raised at once would discard what was queued).
    pull(controller) {
      if (lines.length) controller.enqueue(encoder.encode(lines.shift()));
      else controller.error(new TypeError('network error'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /network error/);

  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'text-reset'], 'withdrawn once');
  assert.equal(session.messages.length, 1, 'the failed turn is not kept');
});

test('a malformed event after some text withdraws the text', async () => {
  signedIn();
  const start = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } };
  stubFetch(() => new Response(`data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(delta)}\n\ndata: {not json\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), SyntaxError);

  assert.deepEqual(events.map((e) => e.type), ['text-delta', 'text-reset']);
  assert.equal(session.messages.length, 1);
});

/** The screenshots a request body still carries inside its tool results. */
function screenshotsIn(body) {
  const images = [];
  for (const message of body.messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool_result') continue;
      for (const part of block.content ?? []) if (part.type === 'image') images.push(part.source.data);
    }
  }
  return images;
}

test('a model with thinking binding asks for it, in both modes', async () => {
  for (const auth of ['account', 'apiKey']) {
    signedIn();
    stubFetch(() => answer());
    const session = new AnthropicSession({ auth, apiKey: 'sk-ant-api03-key', model: 'claude-opus-5-5', effort: 'high', systemPrompt: 'SYS', tools: [] });
    session.addUserMessage('task');
    await session.next({});

    const { init } = calls[0];
    const betas = init.headers['anthropic-beta'].split(',');
    assert.ok(betas.includes('thinking-binding-controls-2026-08-01'), `${auth}: the binding beta`);
    assert.ok(betas.includes('mid-conversation-output-config-2026-07-01'), `${auth}: the output config beta`);
    assert.equal(betas.includes('claude-code-20250219'), auth === 'account', `${auth}: the account betas only with an account`);
    assert.deepEqual(JSON.parse(init.body).thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' });
  }
});

test('a thinking model without binding keeps its history whole, so its signed thinking stays valid', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-sonnet-4-6', effort: 'high', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  for (let n = 1; n <= 4; n += 1) session.addToolResult(`toolu_${n}`, 'The page', [`data:image/jpeg;base64,SHOT${n}`]);

  await session.next({});

  assert.deepEqual(screenshotsIn(JSON.parse(calls[0].init.body)), ['SHOT1', 'SHOT2', 'SHOT3', 'SHOT4']);
});

test('the same model with its thinking off shortens old results again', async () => {
  signedIn();
  stubFetch(() => answer());
  const session = new AnthropicSession({ auth: 'account', model: 'claude-sonnet-4-6', effort: 'off', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  for (let n = 1; n <= 4; n += 1) session.addToolResult(`toolu_${n}`, 'The page', [`data:image/jpeg;base64,SHOT${n}`]);

  await session.next({});

  assert.deepEqual(screenshotsIn(JSON.parse(calls[0].init.body)), ['SHOT4']);
});

test('a reply cut off by the end of the context window is an error, not an answer', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The collected results are:' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]));
  const session = new AnthropicSession({ auth: 'account', model: 'claude-opus-5-5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const events = [];

  await assert.rejects(session.next({ onEvent: (e) => events.push(e) }), /output limit/);

  assert.ok(events.some((e) => e.type === 'text-reset'), 'the half answer is withdrawn');
  assert.equal(session.messages.length, 1, 'the cut-off turn is not kept');
});

test('Mythos and later unknown generations think adaptively, never with a token budget', () => {
  for (const model of ['claude-mythos-5', 'claude-mythos-5-1', 'claude-opus-7']) {
    const request = anthropicThinking(model, 'high');
    assert.equal(request.thinking.type, 'adaptive', model);
    assert.equal(request.thinking.budget_tokens, undefined, model);
    assert.equal(anthropicThinking(model, 'off')?.thinking?.type, undefined, `${model} cannot be told not to think`);
  }
});
