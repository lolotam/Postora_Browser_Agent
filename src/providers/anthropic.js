// Model access through a Claude subscription or an Anthropic API key: the
// Anthropic Messages API at api.anthropic.com. A signed-in Claude account
// sends the Claude Code identity Anthropic expects; an API key sends none.

import { getValidCredential } from './account-auth.js';
import { requestJson } from '../lib/json.js';
import { MODEL_IDLE_MS, fetchModel, readSse } from '../lib/sse.js';
import { ProviderHttpError, readError, withRetry } from '../lib/retry.js';
import { providerErrorMessage } from '../lib/failure.js';
import { kindOf } from '../agent/tool-kinds.js';
import { NOTEBOOK_HEADER, NOTE_SAVED_ARGS, trimKeepingNotebook, withoutNotebook } from '../agent/notebook.js';

const BASE_URL = 'https://api.anthropic.com/v1';
const KEEP_FULL_OBSERVATIONS = 2;
const TRIMMED_OBSERVATION_CHARS = 400;
// Anthropic caches the prompt prefix; the last block of the system prompt and
// the last tool carry the breakpoint.
const CACHE_CONTROL = { type: 'ephemeral' };

/**
 * The Claude Code identity Anthropic expects from a signed-in Claude account:
 * the CLI version, the feature betas and the first line of the system prompt.
 * The values come from pi-ai 1.1.0 (api/anthropic-messages.js:43 and 749-890).
 */
export const CLAUDE_CODE_IDENTITY = {
  version: '2.1.280',
  betas: ['claude-code-20250219', 'oauth-2025-04-20'],
  systemLine: "You are Claude Code, Anthropic's official CLI for Claude.",
};

/**
 * What each Claude model can do about thinking, keyed by the model id. Adaptive
 * models (Claude 4.6 and later) take an effort level, older ones a token
 * budget. The table follows pi-ai 1.1.0: api/anthropic-messages.js:936-975 and
 * the compat flags of every model in providers/data/anthropic.json. A model
 * whose id names an "off" that Anthropic does not allow cannot be told not to
 * think.
 */
const THINKING_RULES = [
  { pattern: /^claude-(?:opus|sonnet|haiku)-4-5/, mode: 'budget', efforts: ['low', 'medium', 'high'], allowOff: true, maxTokens: 64000 },
  { pattern: /^claude-(?:opus|sonnet)-4-6/, mode: 'adaptive', efforts: ['low', 'medium', 'high', 'max'], allowOff: true, maxTokens: 128000 },
  { pattern: /^claude-(?:opus|sonnet)-4-[78]/, mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], allowOff: true, maxTokens: 128000 },
  // Claude Sonnet 5 still allows the thinking to be turned off; the 5.5 of every
  // family does not.
  { pattern: /^claude-sonnet-5(?:-\d{8})?$/, mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], allowOff: true, maxTokens: 128000 },
  { pattern: /^claude-(?:opus|sonnet|haiku|fable)-5/, mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], allowOff: false, maxTokens: 128000 },
];

// A model nobody knows about thinks with a budget, like the ones before it, and
// gets a modest output limit, so a wrong id cannot ask for a huge answer.
const DEFAULT_THINKING = { mode: 'budget', efforts: ['low', 'medium', 'high'], allowOff: true, maxTokens: 32000 };

// The token budget of each effort, for the models that take one.
const BUDGET_TOKENS = { low: 2048, medium: 8192, high: 16384 };

/** What a model can do about thinking: the mode, the efforts it takes and its output limit. */
function anthropicCapability(model) {
  const id = String(model ?? '').toLowerCase();
  return THINKING_RULES.find((rule) => rule.pattern.test(id)) ?? DEFAULT_THINKING;
}

/** The efforts a model takes, for the settings form. */
export function anthropicEfforts(model) {
  return [...anthropicCapability(model).efforts];
}

/**
 * The thinking a request asks for, or nothing when the effort is empty or the
 * model does not take it. Adaptive models take an effort level, budget models a
 * token budget, and only a model that allows it can be told not to think.
 */
export function anthropicThinking(model, effort) {
  const capability = anthropicCapability(model);
  const value = String(effort ?? '').trim().toLowerCase();
  if (!value) return undefined; // the model decides for itself
  if (value === 'off') return capability.allowOff ? { thinking: { type: 'disabled' } } : undefined;
  if (!capability.efforts.includes(value)) return undefined;
  if (capability.mode === 'adaptive') return { thinking: { type: 'adaptive' }, output_config: { effort: value } };
  return { thinking: { type: 'enabled', budget_tokens: BUDGET_TOKENS[value] } };
}

/**
 * A Claude session: the Anthropic Messages API, with either the token of a
 * signed-in Claude account or an Anthropic API key.
 */
export class AnthropicSession {
  constructor({ auth = 'account', apiKey = '', model, effort = '', systemPrompt = '', tools = [], notify = null }) {
    this.auth = auth; // 'account' or 'apiKey'
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.notify = notify;
    this.messages = [];
    this.retryWaitMs = 0;
  }

  addUserMessage(text, images = []) {
    const blocks = [...textBlocks(text), ...images.map(imageBlock)];
    // A message with nothing to say is not sent: Anthropic rejects a message
    // without a content block.
    if (!blocks.length) return;
    const last = this.messages[this.messages.length - 1];
    // Anthropic wants the roles to alternate, so a second message joins the first.
    if (last?.role === 'user') {
      last.content.push(...blocks);
      return;
    }
    this.messages.push({ role: 'user', content: blocks });
  }

  addToolResult(callId, output, images = []) {
    const text = String(output ?? '');
    const content = [...textBlocks(text), ...images.map(imageBlock)];
    const block = {
      type: 'tool_result',
      tool_use_id: callId,
      // An empty result travels as an empty string; Anthropic rejects an empty
      // text block.
      content: content.length ? content : '',
    };
    const last = this.messages[this.messages.length - 1];
    // The results of one turn travel in one message, right after the call.
    if (last?.role === 'user' && last.content[0]?.type === 'tool_result') {
      last.content.push(block);
      return;
    }
    this.messages.push({ role: 'user', content: [block] });
  }

  async next({ signal, onEvent = () => {}, toolChoice = 'auto' }) {
    compactMessages(this.messages);
    this.retryWaitMs = 0;

    const response = await this.post(toolChoice, signal);
    const turn = await readAnthropicStream(response, { signal, onEvent });
    // The turn only counts when the message stopped; a stream that ends early
    // leaves the conversation as it was.
    if (!turn.stopped) {
      if (turn.streamed) onEvent({ type: 'text-reset' });
      throw new Error('Model request failed: the response stream ended before the answer was complete.');
    }
    const content = turn.blocks.map(finalBlock).filter(Boolean);
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    // Only the text blocks are the answer; thinking is not.
    const text = turn.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    // A reply that ran out of output room is not an answer; a turn with complete
    // calls still is.
    if (turn.stopReason === 'max_tokens' && !toolCalls.length) {
      if (turn.streamed) onEvent({ type: 'text-reset' });
      throw new Error('The reply hit the output limit before it was finished.');
    }
    this.messages.push({ role: 'assistant', content });
    return { text, toolCalls, usage: turn.usage, retryWaitMs: this.retryWaitMs };
  }

  async post(toolChoice, signal, { refreshed = false, deadline = Date.now() + MODEL_IDLE_MS } = {}) {
    const auth = await resolveAuth(this.auth, this.apiKey, refreshed);
    const headers = {
      ...modelHeaders(auth),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const body = this.requestBody(toolChoice, auth);
    try {
      return await withRetry(async (remaining) => {
        let res;
        try {
          res = await fetchModel(`${BASE_URL}/messages`, { method: 'POST', credentials: 'omit', signal, headers, body: requestJson(body) }, remaining);
        } catch (err) {
          if (err instanceof TypeError) err.network = true;
          throw err;
        }
        if (res.ok) return res;
        throw new ProviderHttpError(await readError(res, deadline - Date.now()));
      }, { signal, deadline, provider: 'anthropic', notify: this.notify, onWait: (ms) => { this.retryWaitMs += ms; } });
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      // The account token was refused: refresh it once and ask again.
      if (err.status === 401 && !refreshed && auth.mode === 'account') return this.post(toolChoice, signal, { refreshed: true, deadline });
      const out = new Error(providerErrorMessage('Claude', err.status, err.detail));
      out.status = err.status;
      out.detail = err.detail;
      throw out;
    }
  }

  requestBody(toolChoice, auth) {
    const thinking = anthropicThinking(this.model, this.effort);
    const system = this.systemBlocks(auth);
    const tools = this.toolBlocks(auth);
    return {
      model: this.model,
      max_tokens: anthropicCapability(this.model).maxTokens,
      ...(system.length ? { system } : {}),
      messages: this.messages,
      ...(tools.length ? { tools, tool_choice: anthropicToolChoice(toolChoice) } : {}),
      stream: true,
      ...(thinking ?? {}),
    };
  }

  /** The identity line comes first in account mode, then the extension's own prompt. */
  systemBlocks(auth) {
    const blocks = [];
    if (auth.mode === 'account') blocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY.systemLine });
    if (this.systemPrompt) blocks.push({ type: 'text', text: this.systemPrompt });
    // An API key pays for the cache; an account does not.
    if (auth.mode === 'apiKey' && blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL };
    return blocks;
  }

  /** The tools of the request, with the cache breakpoint on the last one. */
  toolBlocks(auth) {
    const tools = this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (auth.mode === 'apiKey' && tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE_CONTROL };
    return tools;
  }
}

/**
 * Reads the Anthropic stream into the blocks of the assistant turn, in the order
 * they arrived: thinking with its signature, redacted thinking, text and calls.
 * One handler per event type.
 */
async function readAnthropicStream(response, { signal, onEvent }) {
  const state = { blocks: [], byIndex: new Map(), usage: null, stopReason: null, stopped: false, streamed: false };
  for await (const { data } of readSse(response, signal)) {
    const event = JSON.parse(data);
    const handler = STREAM_HANDLERS[event.type];
    if (handler) handler(state, event, onEvent);
  }
  return state;
}

/** What each Anthropic stream event does to the turn being read. */
const STREAM_HANDLERS = {
  message_start: (state, event) => {
    state.usage = { ...(state.usage ?? {}), ...(event.message?.usage ?? {}) };
  },
  content_block_start: (state, event) => {
    const block = event.content_block ?? {};
    const entry = { index: event.index, type: block.type };
    if (block.type === 'text') entry.text = block.text ?? '';
    else if (block.type === 'thinking') {
      entry.thinking = block.thinking ?? '';
      entry.signature = block.signature ?? '';
    } else if (block.type === 'redacted_thinking') entry.data = block.data ?? '';
    else if (block.type === 'tool_use') {
      entry.id = block.id;
      entry.name = block.name;
      entry.json = '';
    }
    state.blocks.push(entry);
    state.byIndex.set(event.index, entry);
  },
  content_block_delta: (state, event, onEvent) => {
    const entry = state.byIndex.get(event.index);
    const delta = event.delta ?? {};
    if (delta.type === 'text_delta' && entry?.type === 'text') {
      entry.text += delta.text ?? '';
      state.streamed = true;
      onEvent({ type: 'text-delta', delta: delta.text ?? '' });
    } else if (delta.type === 'thinking_delta' && entry?.type === 'thinking') {
      entry.thinking += delta.thinking ?? '';
      onEvent({ type: 'reasoning-delta', delta: delta.thinking ?? '' });
    } else if (delta.type === 'signature_delta' && entry?.type === 'thinking') {
      entry.signature += delta.signature ?? '';
    } else if (delta.type === 'input_json_delta' && entry?.type === 'tool_use') {
      entry.json += delta.partial_json ?? '';
    }
  },
  content_block_stop: (state, event, onEvent) => {
    const entry = state.byIndex.get(event.index);
    if (entry?.type !== 'tool_use') return;
    try {
      // A call whose arguments are not JSON is not a call: running it would act
      // on arguments nobody wrote.
      entry.input = toolInput(entry.json);
    } catch (err) {
      if (state.streamed) onEvent({ type: 'text-reset' });
      throw err;
    }
  },
  message_delta: (state, event) => {
    state.stopReason = event.delta?.stop_reason ?? state.stopReason;
    state.usage = { ...(state.usage ?? {}), ...(event.usage ?? {}) };
  },
  message_stop: (state) => {
    state.stopped = true;
  },
  error: (state, event, onEvent) => {
    if (state.streamed) onEvent({ type: 'text-reset' });
    throw new Error(event.error?.message ?? 'The model returned an error.');
  },
};

/** The models a Claude account or an Anthropic API key may use. */
export async function listAnthropicModels({ auth = 'account', apiKey = '' } = {}) {
  const url = `${BASE_URL}/models`;
  let res = await fetch(url, { credentials: 'omit', headers: modelHeaders(await resolveAuth(auth, apiKey, false)) });
  if (res.status === 401) res = await fetch(url, { credentials: 'omit', headers: modelHeaders(await resolveAuth(auth, apiKey, true)) });
  if (!res.ok) throw new Error(`Could not load models (HTTP ${res.status}).`);
  const { data = [] } = await res.json();
  return data
    .filter((m) => m?.id)
    .map((m) => ({ id: m.id, name: m.display_name ?? m.id, description: m.description ?? '', efforts: anthropicEfforts(m.id), defaultEffort: null }));
}

/**
 * The credential a request uses: the token of a signed-in Claude account, or an
 * Anthropic API key. An account token is an OAuth token (sk-ant-oat…); anything
 * else is sent as an API key.
 */
async function resolveAuth(auth, apiKey, refreshed) {
  if (auth === 'apiKey') {
    if (!apiKey) throw new Error('Add an Anthropic API key in settings first.');
    return { mode: 'apiKey', token: apiKey };
  }
  const credential = await getValidCredential('claude', { forceRefresh: refreshed });
  const token = credential.access ?? '';
  return { mode: token.includes('sk-ant-oat') ? 'account' : 'apiKey', token };
}

/** The headers every Anthropic request needs. */
function modelHeaders(auth) {
  return {
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(auth.mode === 'account'
      ? { Authorization: `Bearer ${auth.token}`, 'anthropic-beta': CLAUDE_CODE_IDENTITY.betas.join(','), 'x-app': 'cli' }
      : { 'x-api-key': auth.token }),
  };
}

/** The tool choice in Anthropic's words. */
function anthropicToolChoice(toolChoice) {
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  return { type: 'auto' };
}

/**
 * The text blocks of a message. Anthropic rejects an empty text block, so a
 * message with nothing to say has no text block at all.
 */
function textBlocks(text) {
  const value = String(text ?? '');
  if (!value.trim()) return [];
  return [{ type: 'text', text: value }];
}

/** The arguments of a call; broken JSON means the call is not run. */
function toolInput(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    throw new Error('The model sent a tool call with broken arguments, so it was not run.');
  }
}

/** The block as it travels back to Anthropic: the scratch fields are gone. */
function finalBlock(entry) {
  const { index, json, ...rest } = entry;
  const block = rest.type === 'thinking' && !rest.signature
    // Anthropic only takes a thinking block back with its signature; without
    // one it travels as plain text.
    ? { type: 'text', text: rest.thinking ?? '' }
    : rest;
  // Anthropic rejects an empty text block.
  if (block.type === 'text' && !block.text?.trim()) return null;
  return block;
}

/** The text of a tool result, wherever it sits in the content. */
function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? []).find((b) => b.type === 'text')?.text ?? '';
}

/** Replaces the text of a tool result, keeping its images. */
function setResultText(block, text) {
  if (typeof block.content === 'string') {
    block.content = text;
    return;
  }
  const index = (block.content ?? []).findIndex((b) => b.type === 'text');
  if (index >= 0) block.content[index] = { ...block.content[index], text };
}

/** A screenshot as an image block. */
function imageBlock(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(String(dataUrl ?? ''));
  if (!match) return { type: 'text', text: '[screenshot could not be read]' };
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

/**
 * Keeps the last two page observations and the latest notebook read in full;
 * older ones are cut. Notes are short and never cut, and do not push
 * observations out.
 */
function compactMessages(messages) {
  const names = new Map();
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
    }
  }
  const results = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_result') results.push({ block, name: names.get(block.tool_use_id) });
    }
  }
  const kindOfResult = (r) => kindOf(r.name);
  const observations = results.filter((r) => !['bookkeeping', 'notes'].includes(kindOfResult(r)));
  const notebookReads = results.filter((r) => kindOfResult(r) === 'notes');
  // Only the agent adds the notebook header, so it marks a notebook copy; one
  // copy is enough, the latest.
  const lastNotebook = results.findLastIndex((r) => resultText(r.block).includes(NOTEBOOK_HEADER));
  results.forEach((r, n) => {
    if (n < lastNotebook) setResultText(r.block, withoutNotebook(resultText(r.block)));
  });
  for (const r of [...observations.slice(0, -KEEP_FULL_OBSERVATIONS), ...notebookReads.slice(0, -1)]) {
    setResultText(r.block, trimKeepingNotebook(resultText(r.block), TRIMMED_OBSERVATION_CHARS));
  }
  // A note's text is in the latest notebook copy, so once one follows, the call
  // keeps only a marker and old notes no longer grow the context.
  const resultAt = new Map(results.map((r, n) => [r.block.tool_use_id, n]));
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'note' && resultAt.get(block.id) < lastNotebook) block.input = JSON.parse(NOTE_SAVED_ARGS);
    }
  }
  // Only the newest screenshot is kept; the older ones become a note, so a long
  // task does not carry every picture it ever took. The pictures of a tool
  // result sit inside its content.
  const images = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const [index, block] of message.content.entries()) {
      if (block.type === 'image') images.push({ holder: message.content, index });
      else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const [inner, part] of block.content.entries()) {
          if (part.type === 'image') images.push({ holder: block.content, index: inner });
        }
      }
    }
  }
  for (const image of images.slice(0, -1)) {
    image.holder[image.index] = { type: 'text', text: '[older screenshot removed]' };
  }
}
