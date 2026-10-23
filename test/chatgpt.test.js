import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage stand-in shared by the auth module.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => { delete store[key]; },
    },
  },
  tabs: { create: async () => ({ id: 1 }) },
  runtime: { getPlatformInfo: async () => ({}) },
};

const { startAccountLogin } = await import('../src/background/account-login.js');
const { accountStatus } = await import('../src/providers/account-auth.js');
const { ChatgptSession, listChatgptModels } = await import('../src/providers/chatgpt.js');

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const accessToken = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: 'me@x.y',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9', chatgpt_plan_type: 'pro' },
});

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

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the sign-in did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

test('the device login exchanges the approved code and stores the identity', async () => {
  stubFetch((url) => {
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'dev1', user_code: 'ABCD-1234', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code1', code_verifier: 'ver1' });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: accessToken, refresh_token: 'rt1', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  });
  const events = [];

  const shown = await startAccountLogin('chatgpt', { post: (event) => events.push(event) });

  assert.equal(shown.userCode, 'ABCD-1234');
  assert.equal(shown.verificationUrl, 'https://auth.openai.com/codex/device');
  await until(() => events.some((event) => event.type === 'auth-success'));

  const exchange = calls.find((c) => c.url.endsWith('/oauth/token'));
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code_verifier'), 'ver1');
  assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  const status = await accountStatus('chatgpt');
  assert.equal(status.connected, true);
  assert.equal(status.email, 'me@x.y');
  assert.equal(status.planType, 'pro');
  assert.equal(status.accountId, 'acc_9');
});

// Regression 2026-10: client_version=0.99.0 got only a hidden model back, so the
// model list showed empty right after a successful ChatGPT sign-in. A fixed version
// goes stale with every Codex release, so the list asks as npm's latest one.
test('model list asks as the newest Codex release and caches that version for a day', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch((url) => (url.includes('registry.npmjs.org')
    ? Response.json({ version: '0.170.2' })
    : Response.json({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', priority: 1 }] })));

  await listChatgptModels();
  await listChatgptModels();

  const modelCalls = calls.filter((c) => c.url.includes('/models?'));
  assert.deepEqual(modelCalls.map((c) => new URL(c.url).searchParams.get('client_version')), ['0.170.2', '0.170.2']);
  assert.equal(calls.filter((c) => c.url.includes('registry.npmjs.org')).length, 1);
});

test('model list still loads when npm is unreachable', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch((url) => (url.includes('registry.npmjs.org')
    ? new Response('', { status: 503 })
    : Response.json({ models: [{ slug: 'gpt-6-sol', visibility: 'list', priority: 1 }] })));

  const models = await listChatgptModels();

  const [, minor] = new URL(calls.at(-1).url).searchParams.get('client_version').split('.').map(Number);
  assert.ok(minor >= 161, 'the fallback must not be older than the release that surfaced this bug');
  assert.deepEqual(models.map((m) => m.id), ['gpt-6-sol']);
});

test('models OpenAI hides are listed after the visible ones and flagged', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  store.codexVersion = { version: '0.170.2', fetchedAt: Date.now() };
  stubFetch(() => Response.json({ models: [
    { slug: 'gpt-5.5', visibility: 'hide', priority: 1 },
    { slug: 'gpt-6-sol', visibility: 'list', priority: 3 },
  ] }));

  const models = await listChatgptModels();

  assert.deepEqual(models.map((m) => [m.id, m.hidden]), [['gpt-6-sol', false], ['gpt-5.5', true]]);
});

test('ChatgptSession streams a Responses turn with the subscription headers', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch(() => sseResponse([
    { type: 'response.reasoning_summary_text.delta', delta: 'Plan' },
    { type: 'response.output_text.delta', delta: 'Opening' },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' } },
    { type: 'response.output_item.done', item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'Opening' }] } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'navigate', arguments: '{"url":"x.com"}' } },
    { type: 'response.completed', response: { usage: { total_tokens: 42 } } },
  ]));
  const session = new ChatgptSession({ model: 'gpt-x', effort: 'high', systemPrompt: 'SYS', tools: [{ name: 'navigate', description: 'd', parameters: {} }] });
  session.addUserMessage('task');
  const deltas = [];
  const turn = await session.next({ onEvent: (e) => deltas.push(e.type) });

  assert.deepEqual(turn.toolCalls, [{ id: 'c1', name: 'navigate', args: { url: 'x.com' } }]);
  assert.equal(turn.usage.total_tokens, 42);
  assert.deepEqual(deltas, ['reasoning-delta', 'text-delta']);

  const { url, init } = calls[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(init.headers['ChatGPT-Account-ID'], 'acc_9');
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(body.instructions, 'SYS');
  // Output items are replayed without server ids on the next turn.
  assert.ok(session.input.slice(1).every((i) => !('id' in i)));
});

test('ChatgptSession moves the system prompt into input when instructions are rejected', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch((_url, _init, n) => (n === 1
    ? Response.json({ detail: 'Instructions are not valid' }, { status: 400 })
    // A turn only counts once the response completed, so the stream says so.
    : sseResponse([
      { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'response.completed', response: { usage: { total_tokens: 3 } } },
    ])));
  const session = new ChatgptSession({ model: 'gpt-x', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  const turn = await session.next({});
  assert.equal(turn.text, 'ok');
  const retry = JSON.parse(calls[1].init.body);
  assert.equal(retry.instructions, undefined);
  assert.equal(retry.input[0].role, 'developer');
});

test('ChatgptSession reports plan usage limits clearly', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch(() => Response.json({ error: { message: 'You have hit your usage limit.' } }, { status: 429 }));
  const session = new ChatgptSession({ model: 'gpt-x', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), /usage limit reached for this plan/);
});

test('ChatgptSession says what a refusal of the Codex backend means', async () => {
  store.chatgptAuth = { accessToken, refreshToken: 'rt', accountId: 'acc_9', expiresAt: Date.now() + 3600e3 };
  stubFetch(() => Response.json({ error: { message: 'no Codex access' } }, { status: 403 }));
  const session = new ChatgptSession({ model: 'gpt-x', effort: '', systemPrompt: 'SYS', tools: [] });
  session.addUserMessage('task');
  await assert.rejects(session.next({}), /refused the request \(HTTP 403\)\. The plan may not include Codex access/);
});
