import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAST_PRESETS, COMPATIBLE_PRESETS, mergeSettings } from '../src/lib/settings.js';
import { fastClientFor, createFastAsk } from '../src/fast/clients.js';
import { askChatJudge } from '../src/fast/chat-judge-client.js';
import { askJev } from '../src/fast/jev-client.js';
import { listGeminiModels } from '../src/providers/named-api.js';
import { testProviderSlot } from '../src/agent/model-session.js';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { readSse } from '../src/lib/sse.js';
import { fastRequestConfig, fastCatalogBase } from '../src/fast/provider-config.js';
import { listFastModels } from '../src/fast/catalog.js';

const sse = (chunk) => new Response(`data: ${JSON.stringify(chunk)}\r\n\r\ndata: [DONE]\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } });

test('Zen offers a paid chat-judge default and routes models rather than forcing System One', () => {
  assert.equal(FAST_PRESETS['opencode-zen'].decision, false);
  assert.equal(FAST_PRESETS['opencode-zen'].model, 'glm-5.3-flash');
  assert.equal(fastClientFor({ provider: 'opencode-zen', model: 'glm-5.3-flash', decision: true }), askChatJudge);
  assert.equal(fastClientFor({ provider: 'opencode-zen', model: 'jev-1.13', decision: false }), askJev);
});

test('Gemini catalog excludes specialized image/audio/live/video models from browser-agent choices', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'gemini-3.8-flash' }, { id: 'gemini-3.1-pro' }, { id: 'gemini-2.5-flash-image' },
    { id: 'gemini-2.5-flash-preview-tts' }, { id: 'gemini-2.5-flash-native-audio' },
    { id: 'gemini-live-2.5-flash' }, { id: 'veo-3.1-generate-preview' }, { id: 'imagen-4.0-generate' },
  ] });
  assert.deepEqual((await listGeminiModels({ apiKey: 'synthetic-google-key' })).map((m) => m.id), ['gemini-3.8-flash', 'gemini-3.1-pro']);
});

test('Gemini connection test keeps all task tools, normalizes schemas, omits optional usage, and requests text only', async () => {
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return sse({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
  };
  const settings = mergeSettings({ provider: 'gemini', gemini: { apiKey: 'synthetic-google-key', model: 'gemini-3.8-flash' } });
  const result = await testProviderSlot(settings, settings);
  assert.equal(result.reply, 'OK');
  assert.ok(sent.tools.length >= 20);
  assert.equal(sent.tool_choice, 'none');
  assert.equal(sent.stream_options, undefined);
  assert.ok(!JSON.stringify(sent.tools).includes('additionalProperties'));
  assert.equal(sent.tools.find((tool) => tool.function.name === 'read_page').function.parameters, undefined);
  assert.equal(sent.tools.find((tool) => tool.function.name === 'type_text').function.parameters.required.includes('text'), true);
  assert.equal(COMPATIBLE_PRESETS.gemini.usage, false, 'legacy preset uses the same compatibility profile');
});

test('an empty Gemini completion is an actionable failure, not a successful blank connection test', async () => {
  globalThis.fetch = async () => sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] });
  const settings = mergeSettings({ provider: 'gemini', gemini: { apiKey: 'synthetic-google-key', model: 'gemini-3.8-flash' } });
  await assert.rejects(testProviderSlot(settings, settings), /no text|empty|content_filter/i);
});

test('SSE cancellation interrupts a blocked body read instead of waiting for the three-minute idle deadline', async () => {
  let writer;
  const response = new Response(new ReadableStream({ start(controller) { writer = controller; } }));
  const controller = new AbortController();
  const events = readSse(response, controller.signal);
  const pending = events.next().then(() => 'resolved', (error) => error.name);
  controller.abort();
  let timer;
  const outcome = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve('still blocked'), 50); })]);
  clearTimeout(timer);
  if (outcome === 'still blocked') writer.close();
  await pending;
  assert.equal(outcome, 'AbortError');
});

test('Gemini omits usage options but still accepts CRLF and upstream usage-only chunks', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":1}}\r\n\r\ndata: [DONE]\r\n\r\n');
  };
  const session = new CompatibleSession({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'synthetic-google-key', model: 'gemini-3.8-flash', thinkingStyle: 'gemini', usage: true, tools: [], systemPrompt: 'test' });
  const turn = await session.next({});
  assert.equal(turn.text, 'OK');
  assert.equal(turn.usage.prompt_tokens, 12);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].stream_options, undefined);
});

test('known Zen endpoints follow an explicit model choice without changing saved/custom settings', () => {
  const saved = { provider: 'opencode-zen', baseUrl: 'https://opencode.ai/zen', model: 'jev-1.13', decision: true };
  assert.equal(fastRequestConfig(saved).baseUrl, saved.baseUrl);
  assert.equal(fastRequestConfig({ ...saved, model: 'glm-5.3-flash' }).baseUrl, 'https://opencode.ai/zen/v1');
  assert.equal(fastRequestConfig({ ...FAST_PRESETS['opencode-zen'], provider: 'opencode-zen', model: 'jev-1.13' }).baseUrl, 'https://opencode.ai/inference/systemone');
  assert.equal(fastCatalogBase({ ...FAST_PRESETS['opencode-zen'], provider: 'opencode-zen' }), 'https://opencode.ai/inference/v1');
  assert.equal(fastRequestConfig({ ...saved, baseUrl: 'https://custom.test/v1' }).baseUrl, 'https://custom.test/v1');
  assert.equal(mergeSettings({ fast: saved }).fast.model, 'jev-1.13', 'no silent substitution to a billable chat model');
});

test('Zen catalog offers chat and explicit Jev but not free-tier chat restricted to OpenCode', async () => {
  let url;
  globalThis.fetch = async (input) => {
    url = input;
    return Response.json({ data: [{ id: 'glm-5.3-flash' }, { id: 'jev-1.13' }, { id: 'jev-1.13-free' }, { id: 'glm-5.3-flash-free' }, { id: 'big-pickle' }, { id: 'claude-haiku-5-5' }] });
  };
  const list = await listFastModels({ ...FAST_PRESETS['opencode-zen'], provider: 'opencode-zen', apiKey: '' });
  assert.equal(url, 'https://opencode.ai/inference/v1/models');
  assert.deepEqual(list.map((model) => [model.id, model.decision]), [['glm-5.3-flash', false], ['jev-1.13', true], ['jev-1.13-free', true]]);
});

test('Zen Jev 403 uses Vercel once per step with one warning and no repeated primary errors', async () => {
  const calls = [];
  const notices = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (String(url).includes('systemone')) return Response.json({ error: { message: 'Upstream request failed: Model access is disabled' } }, { status: 403 });
    return Response.json({ model: 'typesafe-ai/jev', answers: { greeting: { type: 'boolean', probability: 1 } } });
  };
  const ask = createFastAsk({ provider: 'opencode-zen', baseUrl: 'https://opencode.ai/zen', model: 'jev-1.13', apiKey: 'synthetic-zen-key',
    fallback: { enabled: true, provider: 'vercel', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev', apiKey: 'synthetic-vercel-key', decision: true } }, (notice) => notices.push(notice));
  for (let index = 0; index < 3; index++) assert.equal((await ask({ state: {}, questions: { greeting: { type: 'noul', instructions: 'greeting' } } })).answers.greeting.noul, 1);
  assert.equal(calls.filter((url) => String(url).includes('systemone')).length, 1);
  assert.equal(calls.filter((url) => String(url).includes('decision-model')).length, 3);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'fast-switched');
});

test('Zen chat-judge calls use the chat endpoint and one stable session ID per task', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ model: 'glm-5.3-flash', choices: [{ message: { content: '{"greeting":1}' } }] });
  };
  const ask = createFastAsk({ ...FAST_PRESETS['opencode-zen'], provider: 'opencode-zen', apiKey: 'synthetic-zen-key' });
  const request = { state: {}, questions: { greeting: { type: 'noul', instructions: 'greeting' } } };
  await ask(request);
  await ask(request);
  assert.ok(calls.every((call) => call.url === 'https://opencode.ai/inference/openai/v1/chat/completions'));
  assert.ok(calls[0].headers['x-opencode-session']);
  assert.equal(calls[0].headers['x-opencode-session'], calls[1].headers['x-opencode-session']);
  assert.equal(calls[0].body.response_format.type, 'json_object');
});

test('Gemini connection-test deadline cancels a silent response body with an actionable result', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  const settings = mergeSettings({ provider: 'gemini', gemini: { apiKey: 'synthetic-google-key', model: 'gemini-3.8-flash' } });
  await assert.rejects(testProviderSlot(settings, settings, { timeoutMs: 25 }), /Connection test.*timed out/);
  assert.equal(cancelled, true);
});

test('thought-only and signature-only Gemini SSE events refresh idle even without visible text', async () => {
  let interval;
  let count = 0;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      interval = setInterval(() => {
        const chunk = count++ % 2 ? { choices: [{ delta: { reasoning_content: 'thinking' } }] }
          : { choices: [{ delta: { extra_content: { google: { thought_signature: 'synthetic-signature' } } } }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`));
        if (count === 8) { clearInterval(interval); controller.close(); }
      }, 20);
    },
    cancel() { clearInterval(interval); },
  }));
  let received = 0;
  for await (const _event of readSse(response, null, { idleMs: 100 })) received++;
  assert.equal(received, 8);
});
