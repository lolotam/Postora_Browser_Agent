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

const { GrokAccountSession, listGrokModels } = await import('../src/providers/responses.js');
const { setAccountFlows } = await import('../src/providers/account-auth.js');

// The refresh of a Grok account, so the test can say what the provider answers.
setAccountFlows({
  xaiOAuth: {
    name: 'xAI (Grok/X subscription)',
    async login() { throw new Error('the login flow is not used in this test'); },
    async refresh() { return { type: 'oauth', access: 'grok-refreshed-token', refresh: 'rt2', expires: Date.now() + 3600e3 }; },
  },
});

const ACCOUNT_TOKEN = 'grok-account-token';

function sseResponse(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
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

/** A signed-in Grok account with a token that is good for an hour. */
function signedIn(token = ACCOUNT_TOKEN) {
  store['accountAuth.grok'] = { generation: 1, credential: { type: 'oauth', access: token, refresh: 'rt', expires: Date.now() + 3600e3 } };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

test('a Grok request goes to xAI with the account token and function tools', async () => {
  signedIn();
  stubFetch(() => sseResponse([
    { type: 'response.output_text.delta', delta: 'Hi' },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] } },
    { type: 'response.completed', response: { usage: { total_tokens: 5 } } },
  ]));
  const session = new GrokAccountSession({
    model: 'grok-4.5', effort: 'high', systemPrompt: 'SYS',
    tools: [{ name: 'navigate', description: 'd', parameters: { type: 'object' } }],
  });
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.equal(turn.text, 'Hi');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.x.ai/v1/responses');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'grok-4.5');
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.tools, [{ type: 'function', name: 'navigate', description: 'd', parameters: { type: 'object' }, strict: false }]);
  // xAI takes the system prompt as a message of its own.
  assert.equal(body.instructions, undefined);
  assert.equal(body.input[0].role, 'developer');
  assert.equal(body.input[0].content[0].text, 'SYS');
});

test('a refused token is refreshed and the request is made again', async () => {
  signedIn();
  stubFetch((_url, _init, n) => (n === 1
    ? Response.json({ error: { message: 'invalid token' } }, { status: 401 })
    : sseResponse([
      { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] } },
      { type: 'response.completed', response: {} },
    ])));
  const session = new GrokAccountSession({ model: 'grok-4.5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  const turn = await session.next({});

  assert.equal(turn.text, 'Hi');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer grok-refreshed-token');
  assert.equal(store['accountAuth.grok'].credential.access, 'grok-refreshed-token', 'the new token is stored');
});

test('a token that is refused again after the refresh is an error, not a loop', async () => {
  signedIn();
  stubFetch(() => Response.json({ error: { message: 'invalid token' } }, { status: 401 }));
  const session = new GrokAccountSession({ model: 'grok-4.5', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');

  await assert.rejects(session.next({}), /Grok request failed \(HTTP 401\)/);

  assert.equal(calls.length, 2, 'the request is made once more, not again and again');
});

test('the model list comes from xAI with the account token', async () => {
  signedIn();
  stubFetch(() => Response.json({ data: [
    { id: 'grok-4.7', name: 'Grok 4.7' },
    { id: 'grok-4.5', name: 'Grok 4.5' },
  ] }));

  const models = await listGrokModels();

  assert.equal(calls[0].url, 'https://api.x.ai/v1/models');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
  assert.deepEqual(models.map((m) => [m.id, m.efforts]), [
    ['grok-4.7', ['low', 'medium', 'high', 'xhigh']],
    ['grok-4.5', ['low', 'medium', 'high']],
  ]);
});
