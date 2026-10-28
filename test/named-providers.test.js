import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_API_URL, KIMI_CODE_URL, MOONSHOT_API_URL, mergeSettings, modelListRoute, settingsProblem, slotSettings } from '../src/lib/settings.js';
import { createModelSession, modelSessionKey } from '../src/agent/model-session.js';
import { listGeminiModels } from '../src/providers/named-api.js';
import { KimiSession, listKimiModels } from '../src/providers/kimi.js';
import { getValidCredential, setAccountFlows, signOut } from '../src/providers/account-auth.js';

const store = {};
globalThis.chrome = { storage: { local: {
  get: async (key) => ({ [key]: store[key] }), set: async (values) => Object.assign(store, values), remove: async (key) => { delete store[key]; },
} } };
let calls;
let handler;
const credential = () => ({ type: 'oauth', access: 'SUBSCRIPTION-ACCESS', refresh: 'SUBSCRIPTION-REFRESH', expires: Date.now() + 3600000 });
const stream = (delta, finish = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  calls = [];
  handler = () => assert.fail('unexpected network request');
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options); };
});

test('named API provider settings are independent, validated, and invalidate model sessions', () => {
  const settings = mergeSettings({ provider: 'gemini', gemini: { apiKey: 'GOOGLE-KEY', model: 'gemini-example' }, kimi: { apiKey: 'MOONSHOT-KEY', model: 'kimi-example' } });
  assert.equal(settingsProblem(settings), null);
  assert.equal(slotSettings(settings).model, 'gemini-example');
  assert.equal(modelListRoute(settings), 'gemini');
  assert.equal(settings.keys.gemini, 'GOOGLE-KEY');
  assert.equal(settings.keys.moonshot, 'MOONSHOT-KEY');
  assert.equal(settings.fallback.gemini.apiKey, 'GOOGLE-KEY');
  const changed = mergeSettings({ ...settings, kimi: { ...settings.kimi, auth: 'account' } });
  assert.notEqual(modelSessionKey(settings), modelSessionKey(changed));
  assert.equal(settingsProblem(mergeSettings({ provider: 'gemini', gemini: { model: 'x' } })), 'err.geminiKey');
  assert.equal(settingsProblem(mergeSettings({ provider: 'kimi', kimi: { model: 'x' } })), 'err.kimiKey');
  assert.equal(settingsProblem(mergeSettings({ provider: 'kimi', kimi: { model: 'x', auth: 'account' } })), null);
});

test('legacy compatible Gemini configuration continues to use its saved endpoint and key', () => {
  const settings = mergeSettings({ provider: 'compatible', compatible: { preset: 'gemini', baseUrl: GEMINI_API_URL, apiKey: 'LEGACY-KEY', model: 'legacy-model' } });
  const session = createModelSession(settings, {}).active;
  assert.equal(settings.provider, 'compatible');
  assert.equal(session.baseUrl, GEMINI_API_URL);
  assert.equal(session.apiKey, 'LEGACY-KEY');
  assert.equal(settings.gemini.apiKey, 'LEGACY-KEY');
});

test('Gemini catalog uses its fixed Google endpoint and key without anonymous retry', async () => {
  handler = () => Response.json({ data: [{ id: 'models/gemini-test' }, { id: 'embedding-test' }, { id: 'image-test', type: 'image' }] });
  assert.deepEqual((await listGeminiModels({ apiKey: 'GOOGLE-KEY' })).map((model) => model.id), ['gemini-test']);
  assert.equal(calls[0].url, `${GEMINI_API_URL}/models`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer GOOGLE-KEY');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  handler = () => new Response('denied', { status: 403 });
  calls = [];
  await assert.rejects(listGeminiModels({ apiKey: 'BAD' }), /HTTP 403/);
  assert.equal(calls.length, 1);
});

test('Gemini execution keeps image input, streamed tool signatures, and subsequent tool history', async () => {
  const settings = mergeSettings({ provider: 'gemini', gemini: { apiKey: 'GOOGLE-KEY', model: 'gemini-test', effort: 'high' } });
  const session = createModelSession(settings, {}).active;
  handler = () => calls.length === 1 ? stream({ tool_calls: [{ index: 0, id: 'call-google', function: { name: 'read_page', arguments: '{}' }, extra_content: { google: { thought_signature: 'signature' } } }] }, 'tool_calls') : stream({ content: 'done' });
  session.addUserMessage('Inspect', ['data:image/png;base64,TEST']);
  const turn = await session.next({});
  assert.equal(turn.toolCalls[0].name, 'read_page');
  session.addToolResult('call-google', 'page observed');
  assert.equal((await session.next({})).text, 'done');
  assert.equal(calls[0].url, `${GEMINI_API_URL}/chat/completions`);
  const first = JSON.parse(calls[0].options.body);
  assert.equal(first.reasoning_effort, 'high');
  assert.ok(first.messages[1].content.some((part) => part.type === 'image_url'));
  const next = JSON.parse(calls[1].options.body);
  assert.equal(next.messages.find((message) => message.role === 'assistant').tool_calls[0].extra_content.google.thought_signature, 'signature');
});

test('Moonshot execution uses only its API key and preserves reasoning with tool calls', async () => {
  const settings = mergeSettings({ provider: 'kimi', kimi: { apiKey: 'MOONSHOT-KEY', model: 'kimi-k3.1-pro', effort: 'max', baseUrl: 'https://untrusted.test' } });
  const session = createModelSession(settings, {}).active;
  assert.ok(session instanceof KimiSession);
  handler = () => calls.length === 1 ? stream({ reasoning_content: 'thinking', tool_calls: [{ index: 0, id: 'k-call', function: { name: 'read_page', arguments: '{}' } }] }, 'tool_calls') : stream({ content: 'finished' });
  session.addUserMessage('Read');
  await session.next({});
  session.addToolResult('k-call', 'observed');
  await session.next({});
  assert.ok(calls.every((call) => call.url === `${MOONSHOT_API_URL}/chat/completions`));
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer MOONSHOT-KEY'));
  assert.equal(JSON.parse(calls[1].options.body).messages.find((message) => message.role === 'assistant').reasoning_content, 'thinking');
});

test('older Moonshot models never receive K3-only reasoning effort parameters', async () => {
  handler = () => Response.json({ data: [{ id: 'kimi-k2.6' }, { id: 'kimi-k3.1-pro' }] });
  const list = await listKimiModels({ apiKey: 'MOONSHOT-KEY' });
  assert.deepEqual(list[0].efforts, []);
  assert.deepEqual(list[1].efforts, ['low', 'high', 'max']);
  handler = () => stream({ content: 'older model works' });
  const session = new KimiSession({ apiKey: 'MOONSHOT-KEY', model: 'kimi-k2.6', effort: 'max', tools: [], systemPrompt: '' });
  await session.next({});
  assert.equal(JSON.parse(calls.at(-1).options.body).reasoning_effort, undefined);
});

test('Kimi Code catalog and execution use separate account credentials and a fixed .com endpoint', async () => {
  store['accountAuth.kimi'] = { generation: 1, credential: credential() };
  handler = (url) => url.endsWith('/models') ? Response.json({ data: [{ id: 'kimi-for-coding' }] }) : stream({ content: 'account answer' });
  const config = { auth: 'account', apiKey: 'DO-NOT-SEND-MOONSHOT-KEY', model: 'kimi-for-coding' };
  assert.equal((await listKimiModels(config))[0].id, 'kimi-for-coding');
  const session = new KimiSession({ ...config, tools: [], systemPrompt: 'test' });
  session.addUserMessage('hello');
  assert.equal((await session.next({})).text, 'account answer');
  assert.ok(calls.every((call) => call.url.startsWith(`${KIMI_CODE_URL}/`)));
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer SUBSCRIPTION-ACCESS'));
  assert.ok(calls.every((call) => !Object.keys(call.options.headers).some((key) => /user-agent/i.test(key))), 'never impersonate another tool');
});

test('a rejected Kimi account token refreshes once, while model-access 403 does not sign it out', async () => {
  store['accountAuth.kimi'] = { generation: 1, credential: credential() };
  let refreshes = 0;
  setAccountFlows({ kimiCodingOAuth: { refresh: async () => { refreshes += 1; return { ...credential(), access: 'ROTATED' }; } } });
  handler = () => calls.length === 1 ? new Response('expired', { status: 401 }) : stream({ content: 'ok' });
  const session = new KimiSession({ auth: 'account', model: 'kimi-for-coding', tools: [], systemPrompt: '' });
  await session.next({});
  assert.equal(refreshes, 1);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer ROTATED');
  handler = () => new Response('Model access is disabled', { status: 403 });
  await assert.rejects(session.next({}), /not available to your account/);
  assert.equal(refreshes, 1);
  assert.equal(store['accountAuth.kimi'].credential.access, 'ROTATED');
});

test('confirmed Kimi refresh rejection expires credentials; transient refresh failure retains them', async () => {
  store['accountAuth.kimi'] = { generation: 1, credential: { ...credential(), expires: 1 } };
  setAccountFlows({ kimiCodingOAuth: { refresh: async () => { throw new Error('Kimi Code token refresh failed with status 503'); } } });
  await assert.rejects(getValidCredential('kimi'), /could not be refreshed/);
  assert.ok(store['accountAuth.kimi'].credential);
  setAccountFlows({ kimiCodingOAuth: { refresh: async () => { throw new Error('Kimi Code token refresh unauthorized (status 401)'); } } });
  await assert.rejects(getValidCredential('kimi'), /expired/);
  assert.equal(store['accountAuth.kimi'].credential, null);
  await signOut('kimi');
  await assert.rejects(listKimiModels({ auth: 'account' }), /not connected/);
  assert.equal(calls.length, 0);
});
