import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseChunk } from '../src/lib/sse.js';
import { chatgptIdentity } from '../src/lib/jwt.js';
import { compactInput, parseOutput, withoutId } from '../src/providers/chatgpt.js';
import { CompatibleSession, compactMessages, createAccumulator, listCompatibleModels } from '../src/providers/openai-compatible.js';
import { mergeSettings } from '../src/lib/settings.js';

const fakeJwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('parseSseChunk keeps an incomplete trailing event for the next chunk', () => {
  const { events, rest } = parseSseChunk('event: a\ndata: {"x":1}\n\ndata: par');
  assert.deepEqual(events, [{ event: 'a', data: '{"x":1}' }]);
  assert.equal(rest, 'data: par');
  const next = parseSseChunk(`${rest}t\r\n\r\n`);
  assert.deepEqual(next.events, [{ event: 'message', data: 'part' }]);
});

test('parseSseChunk joins multi-line data and skips comments', () => {
  const { events } = parseSseChunk(': keepalive\ndata: one\ndata: two\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'one\ntwo' }]);
});

test('chatgptIdentity reads account, plan, email and expiry from OpenAI claims', () => {
  const token = fakeJwt({
    exp: 2000000000,
    email: 'a@b.c',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1', chatgpt_plan_type: 'plus' },
  });
  assert.deepEqual(chatgptIdentity(token), { accountId: 'acc_1', planType: 'plus', email: 'a@b.c', expiresAt: 2000000000000 });
  assert.equal(chatgptIdentity('not-a-jwt'), null);
});

test('parseOutput extracts text and function calls from Responses items', () => {
  const items = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' },
    { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Looking' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'click', arguments: '{"index":3}' },
  ];
  const out = parseOutput(items);
  assert.equal(out.text, 'Looking');
  assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'click', args: { index: 3 } }]);
  assert.equal('id' in withoutId(items[0]), false);
  assert.equal(withoutId(items[0]).encrypted_content, 'x');
});

test('compactInput trims all but the latest observations and screenshots', () => {
  const long = 'x'.repeat(2000);
  const input = [
    { type: 'function_call_output', call_id: '1', output: long },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:a' }] },
    { type: 'function_call_output', call_id: '2', output: long },
    { type: 'function_call_output', call_id: '3', output: long },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:b' }] },
  ];
  compactInput(input);
  assert.ok(input[0].output.endsWith('[older page state trimmed]'));
  assert.equal(input[2].output, long);
  assert.equal(input[3].output, long);
  assert.equal(input[1].content[0].type, 'input_text');
  assert.equal(input[4].content[0].type, 'input_image');
});

test('createAccumulator reassembles tool-call arguments split across chunks', () => {
  const acc = createAccumulator();
  acc.push({ choices: [{ delta: { content: 'Hi ' } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{"url":"ht' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tps://x.y"}' } }] } }] });
  const result = acc.result();
  assert.equal(result.text, 'Hi ');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'navigate', args: { url: 'https://x.y' } }]);
  assert.equal(result.rawToolCalls[0].function.arguments, '{"url":"https://x.y"}');
});

test('compactMessages trims old tool observations only', () => {
  const long = 'y'.repeat(1000);
  const messages = [1, 2, 3].map((n) => ({ role: 'tool', tool_call_id: String(n), content: long }));
  compactMessages(messages);
  assert.ok(messages[0].content.length < 500);
  assert.equal(messages[2].content, long);
});

test('CompatibleSession maps effort to GLM thinking or reasoning_effort', () => {
  const base = { baseUrl: 'http://x/', apiKey: '', model: 'm', systemPrompt: 's', tools: [] };
  const glm = new CompatibleSession({ ...base, effort: 'off', thinkingStyle: 'glm' }).requestBody('auto');
  assert.deepEqual(glm.thinking, { type: 'disabled' });
  assert.equal(glm.reasoning_effort, undefined);
  const grok = new CompatibleSession({ ...base, effort: 'high', thinkingStyle: 'reasoning_effort' }).requestBody('auto');
  assert.equal(grok.reasoning_effort, 'high');
  const plain = new CompatibleSession({ ...base, effort: '', thinkingStyle: 'reasoning_effort' }).requestBody('auto');
  assert.equal('reasoning_effort' in plain, false);
});

test('CompatibleSession asks MiniMax to split the thinking out, and grades it on the model that reads it', () => {
  const base = { baseUrl: 'https://api.minimax.io/v1', apiKey: 'k', systemPrompt: 's', tools: [] };
  const flash = new CompatibleSession({ ...base, model: 'MiniMax-M3.1-Flash', effort: 'high', thinkingStyle: 'minimax' }).requestBody('auto');
  assert.equal(flash.reasoning_split, true);
  assert.equal(flash.reasoning_effort, 'high');
  // The model id is read whatever its case is.
  const lower = new CompatibleSession({ ...base, model: 'minimax-m3.1-flash', effort: 'xhigh', thinkingStyle: 'minimax' }).requestBody('auto');
  assert.equal(lower.reasoning_effort, 'xhigh');
  // The other MiniMax models think at their own depth and ignore ours.
  const other = new CompatibleSession({ ...base, model: 'MiniMax-M2.7', effort: 'high', thinkingStyle: 'minimax' }).requestBody('auto');
  assert.equal(other.reasoning_split, true);
  assert.equal(other.reasoning_effort, undefined);
  // Nor does a model whose name only starts like it.
  const lite = new CompatibleSession({ ...base, model: 'MiniMax-M3.1-Flash-lite', effort: 'high', thinkingStyle: 'minimax' }).requestBody('auto');
  assert.equal(lite.reasoning_effort, undefined);
  // Without an effort only the split is asked for.
  const noEffort = new CompatibleSession({ ...base, model: 'MiniMax-M3.1-Flash', effort: '', thinkingStyle: 'minimax' }).requestBody('auto');
  assert.equal(noEffort.reasoning_split, true);
  assert.equal(noEffort.reasoning_effort, undefined);
});

test('OpenCode requests carry one stable session id per conversation; other providers get none', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, session: init.headers['x-opencode-session'] });
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const base = { apiKey: 'k', model: 'glm-5.3', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [] };
  const go = new CompatibleSession({ ...base, baseUrl: 'https://opencode.ai/zen/go/v1' });
  go.addUserMessage('a');
  await go.next({});
  go.addUserMessage('b');
  await go.next({});
  const other = new CompatibleSession({ ...base, baseUrl: 'https://openrouter.ai/api/v1' });
  other.addUserMessage('a');
  await other.next({});
  assert.match(seen[0].session, /^[0-9a-f-]{36}$/);
  assert.equal(seen[1].session, seen[0].session);
  assert.equal(seen[2].session, undefined);
  assert.notEqual(new CompatibleSession({ ...base, baseUrl: 'https://opencode.ai/zen/v1' }).sessionId, seen[0].session);
  // A conversation reopened after a worker restart keeps its id.
  assert.equal(new CompatibleSession({ ...base, baseUrl: 'https://opencode.ai/zen/go/v1', sessionId: 'saved-session-1' }).sessionId, 'saved-session-1');
});

test('fast settings saved before providers existed keep using TypeSafe Jev', () => {
  const { fast } = mergeSettings({ fast: { enabled: true, apiKey: 'jev', baseUrl: 'https://api.typesafe.ai' } });
  assert.equal(fast.provider, 'typesafe');
});

test('model lists skip image, video and embedding models and flag decision models', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'anthropic/claude-haiku-5.5', type: 'language' },
    { id: 'openai/text-embedding-3', type: 'embedding' },
    { id: 'google/veo', type: 'video' },
    { id: 'typesafe-ai/jev', type: 'evaluation' },
    { id: 'local-model' },
  ] });
  const models = await listCompatibleModels('https://gw.example/v1', 'k');
  assert.deepEqual(models.map((m) => [m.id, m.decision]), [
    ['anthropic/claude-haiku-5.5', false],
    ['typesafe-ai/jev', true],
    ['local-model', false],
  ]);
});

test('OpenRouter models are marked by whether they can call tools; lists that do not say stay unmarked', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'openai/gpt-5', supported_parameters: ['tools', 'reasoning'] },
    { id: 'some/chat-only', supported_parameters: ['temperature'] },
    { id: 'local-model' },
  ] });
  const models = await listCompatibleModels('https://openrouter.ai/api/v1', 'k');
  assert.deepEqual(models.map((m) => [m.id, m.tools]), [['openai/gpt-5', true], ['some/chat-only', false], ['local-model', null]]);
});

test('a public model list still loads when the key is missing or rejected', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(init.headers.Authorization ?? null);
    return init.headers.Authorization ? new Response('{"error":"bad key"}', { status: 401 }) : Response.json({ data: [{ id: 'typesafe-ai/jev', type: 'evaluation' }] });
  };
  const models = await listCompatibleModels('https://ai-gateway.vercel.sh/v1', 'typo-key');
  assert.deepEqual(sent, ['Bearer typo-key', null]);
  assert.deepEqual(models.map((m) => m.id), ['typesafe-ai/jev']);
});

test('settings saved before backups existed get disabled backups, and partial backups keep their fields', () => {
  const old = mergeSettings({ provider: 'chatgpt', fast: { enabled: true, provider: 'vercel' } });
  assert.equal(old.fallback.enabled, false);
  assert.equal(old.fallback.compatible.preset, 'openrouter');
  assert.equal(old.fast.fallback.enabled, false);
  assert.equal(old.fast.fallback.provider, 'typesafe');

  const partial = mergeSettings({ fallback: { enabled: true, compatible: { apiKey: 'or-key' } }, fast: { fallback: { enabled: true, apiKey: 'tk' } } });
  assert.equal(partial.fallback.compatible.apiKey, 'or-key');
  assert.equal(partial.fallback.compatible.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(partial.fast.fallback.apiKey, 'tk');
  assert.equal(partial.fast.fallback.model, 'jev-latest');
});

test('model lists drop embedding and rerank models and the "models/" prefix Gemini may return', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'models/gemini-3.8-flash' },
    { id: 'models/gemini-embedding-001' },
    { id: 'nvidia/nemotron-3-embed-1b' },
    { id: 'nvidia/llama-3.2-nv-rerankqa-1b-v2' },
    { id: 'nvidia/nemotron-3-super-120b-a12b' },
  ] });
  const models = await listCompatibleModels('https://generativelanguage.googleapis.com/v1beta/openai', 'k');
  assert.deepEqual(models.map((m) => m.id), ['gemini-3.8-flash', 'nvidia/nemotron-3-super-120b-a12b']);
});

test('reply language defaults to following the task language', () => {
  assert.deepEqual(mergeSettings({}).replyLanguage, { enabled: false, language: '' });
});

test('OpenCode presets list only the models served on /chat/completions', async () => {
  const { chatModelsFor } = await import('../src/lib/settings.js');
  const zen = ['glm-5.3', 'kimi-k3', 'gpt-6-sol', 'grok-4.7', 'claude-opus-5-5', 'gemini-3.8-flash', 'qwen3.8-max', 'qwen3.8-flash', 'minimax-m3', 'jev-1.13', 'big-pickle'].map((id) => ({ id }));
  assert.deepEqual(chatModelsFor('opencode-zen', zen).map((m) => m.id), ['glm-5.3', 'kimi-k3', 'qwen3.8-max', 'minimax-m3', 'big-pickle']);
  const go = ['glm-5.3', 'kimi-k3', 'gpt-6-luna', 'claude-haiku-5-5', 'qwen3.8-max', 'minimax-m3', 'deepseek-v4-pro'].map((id) => ({ id }));
  assert.deepEqual(chatModelsFor('opencode-go', go).map((m) => m.id), ['glm-5.3', 'kimi-k3', 'deepseek-v4-pro']);
  assert.equal(chatModelsFor('openai', zen).length, zen.length, 'other presets are not filtered');
});

test('Jev models in a gateway list count as decision models', async () => {
  globalThis.fetch = async () => Response.json({ data: [{ id: 'jev-1.13' }, { id: 'jev-1.13-free' }, { id: 'glm-5.3' }] });
  const models = await listCompatibleModels('https://opencode.ai/zen/v1', 'k');
  assert.deepEqual(models.filter((m) => m.decision).map((m) => m.id), ['jev-1.13', 'jev-1.13-free']);
});

// Review 2026-10 (Codex P1): Gemini 3 answers 400 on the next turn when a tool call
// comes back without the thought signature it carried.
test('tool calls keep provider extras such as the Gemini thought signature', () => {
  const acc = createAccumulator();
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'click', arguments: '' }, extra_content: { google: { thought_signature: 'sig-1' } } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"index":2}' } }] } }] });
  const [call] = acc.result().rawToolCalls;
  assert.deepEqual(call, { id: 'c1', type: 'function', function: { name: 'click', arguments: '{"index":2}' }, extra_content: { google: { thought_signature: 'sig-1' } } });

  const plain = createAccumulator();
  plain.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'read_page', arguments: '{}' } }] } }] });
  assert.equal('extra_content' in plain.result().rawToolCalls[0], false, 'other providers get the plain OpenAI shape');
});
