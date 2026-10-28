// Any OpenAI-compatible Chat Completions endpoint: xAI Grok, Z.ai GLM,
// OpenAI API keys, OpenRouter, or a local server.

import { providerMessage } from '../lib/failure.js';
import { MODEL_IDLE_MS, fetchModel, readSse } from '../lib/sse.js';
import { requestJson } from '../lib/json.js';
import { ProviderHttpError, readError, withRetry } from '../lib/retry.js';
import { parseTextToolCalls } from './text-tool-calls.js';
import { kindOf } from '../agent/tool-kinds.js';
import { NOTEBOOK_HEADER, NOTE_SAVED_ARGS, trimKeepingNotebook, withoutNotebook } from '../agent/notebook.js';

const KEEP_FULL_OBSERVATIONS = 2;
const TRIMMED_OBSERVATION_CHARS = 400;
// Gateways such as Vercel's list image, video and embedding models next to chat
// models. "evaluation" models (typesafe-ai/jev) are kept, flagged as decision models.
const NON_CHAT_TYPES = new Set(['embedding', 'image', 'video', 'reranking', 'speech', 'transcription', 'realtime']);
// Gemini and NVIDIA list embedding and rerank models without a type field.
const NON_CHAT_ID = /embed|rerank/i;

export async function listCompatibleModels(baseUrl, apiKey, { anonymousFallback = true, signal, redirect = 'follow' } = {}) {
  const url = `${trimSlash(baseUrl)}/models`;
  const options = { credentials: 'omit', signal, redirect };
  let res = await fetch(url, { ...options, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  // Vercel and OpenRouter publish their lists but reject an invalid key, so a
  // typo or a key not entered yet must not hide the list.
  if (anonymousFallback && apiKey && (res.status === 401 || res.status === 403)) res = await fetch(url, { ...options, headers: {} });
  if (!res.ok) throw Object.assign(new Error(`Could not load models (HTTP ${res.status}). Type the model id manually.`), { status: res.status });
  const body = await res.json();
  return (body.data ?? body.models ?? [])
    .map((m) => ({ ...m, id: String(m.id ?? m.name).replace(/^models\//, '') })) // Gemini may prefix ids with "models/"
    .filter((m) => !NON_CHAT_TYPES.has(m.type) && !NON_CHAT_ID.test(m.id))
    .map((m) => ({ id: m.id, name: m.id, efforts: [], decision: m.type === 'evaluation' || /^jev-/.test(m.id), tools: supportsTools(m) }));
}

/** OpenRouter lists each model's parameters; the agent needs tool calls. null: the list does not say. */
function supportsTools(model) {
  return Array.isArray(model.supported_parameters) ? model.supported_parameters.includes('tools') : null;
}

// OpenCode (Zen and Go) routes and caches by a stable conversation id, and Go
// rejects requests without one (HTTP 400 MissingSessionID).
const OPENCODE = /^https:\/\/opencode\.ai\//;
// A model without vision says so in one of these ways (OpenRouter, vLLM / NVIDIA, others).
const NO_VISION = /image input|support(?:s)? images?|does not support vision|vision is not supported|multimodal processing is not enabled|does not support multimodal/i;
const NO_VISION_STATUS = new Set([400, 404, 415, 422]);
// finish_reason values that mean the answer is complete.
const COMPLETE = new Set(['stop', 'tool_calls', 'function_call']);

// The only MiniMax model that reads reasoning_effort; the others think at their
// own depth and ignore it.
const MINIMAX_EFFORT_MODEL = /^minimax-m3\.1-flash$/i;
// The depths MiniMax documents. It rejects 'none', so an effort that asks for
// no thinking asks for the shallowest depth it accepts.
const MINIMAX_EFFORTS = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', off: 'low', none: 'low' };
// The reasoning entries whose text is joined when they follow each other.
const MERGED_DETAIL_TYPES = new Set(['reasoning.text', 'reasoning.summary']);

export class CompatibleSession {
  constructor({ baseUrl, apiKey, model, effort, thinkingStyle, systemPrompt, tools, sessionId = crypto.randomUUID(), notify = null, textToolCalls = false, usage = false, strictRedirects = false }) {
    this.strictRedirects = strictRedirects;
    this.notify = notify;
    this.usage = usage; // ask for token usage in the stream (presets known to accept it)
    this.retryWaitMs = 0;
    this.textToolCalls = textToolCalls; // only presets where models were seen writing calls as text
    this.turn = 0;
    this.baseUrl = trimSlash(baseUrl);
    this.sessionId = sessionId;
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
    this.thinkingStyle = thinkingStyle;
    this.tools = tools;
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.pendingImages = [];
  }

  addUserMessage(text, images = []) {
    this.messages.push(userMessage(text, images));
  }

  addToolResult(callId, output, images = []) {
    this.messages.push({ role: 'tool', tool_call_id: callId, content: output });
    this.pendingImages.push(...images);
  }

  async next({ signal, onEvent = () => {}, toolChoice = 'auto' }, deadline = Date.now() + MODEL_IDLE_MS, retrying = false) {
    if (this.pendingImages.length) {
      this.messages.push(this.textOnly
        ? userMessage('A screenshot was taken, but this model cannot read images. Use read_page or get_text instead.')
        : userMessage('Screenshot returned by the last tool call:', this.pendingImages));
      this.pendingImages = [];
    }
    compactMessages(this.messages);
    if (!retrying) this.retryWaitMs = 0;

    let res;
    try {
      res = await this.request(toolChoice, signal, deadline);
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      const { status, detail } = err;
      // A model without vision: drop the screenshots and ask again within the same
      // deadline, once (no images are left after that); later screenshots become a note.
      if (NO_VISION_STATUS.has(status) && NO_VISION.test(detail) && dropImages(this.messages)) {
        this.textOnly = true;
        return this.next({ signal, onEvent, toolChoice }, deadline, true);
      }
      // An endpoint that refuses the usage option: ask again without it, once.
      if (status === 400 && this.usage && /stream_options/i.test(detail)) {
        this.usage = false;
        return this.next({ signal, onEvent, toolChoice }, deadline, true);
      }
      // OpenRouter's own advice for this one is to drop a tool, which the agent cannot do.
      if (/support tool use/i.test(detail)) throw failure(err, 'this model cannot call tools, which the agent needs to use the browser. Pick another model.');
      // The provider has the model in its list but will not serve it to this account or plan.
      if (/model is unavailable|model access is disabled/i.test(detail)) throw failure(err, `${providerMessage(detail, 200)} This model is not available to your account or plan right now; pick another model in Settings.`);
      throw failure(err, providerMessage(detail, 400));
    }

    const minimax = this.thinkingStyle === 'minimax';
    const acc = createAccumulator({ reasoningDetails: minimax });
    // A model whose thinking could not be split out writes it inside the answer;
    // the block is dropped from what the user reads.
    const filter = minimax ? new ThinkFilter() : null;
    let shown = '';
    let done = false;
    let received = false; // any part of the answer (text, reasoning or a call) arrived
    for await (const { data } of readSse(res, signal)) {
      if (data === '[DONE]') {
        done = true;
        break;
      }
      const chunk = JSON.parse(data);
      if (chunk.error) {
        const message = chunk.error.message ?? JSON.stringify(chunk.error);
        // vLLM answers HTTP 200 and reports a model without vision inside the stream
        // ("multimodal processing is not enabled"): handled like the HTTP error, once,
        // and only before anything was shown, so a retry never adds to a shown answer.
        if (!received && NO_VISION.test(message) && dropImages(this.messages)) {
          this.textOnly = true;
          return this.next({ signal, onEvent, toolChoice }, deadline, true);
        }
        if (shown) onEvent({ type: 'text-reset' }); // the backup's answer must not follow a half answer
        throw new Error(message);
      }
      const delta = acc.push(chunk);
      if (delta.text || delta.reasoning || chunk.choices?.[0]?.delta?.tool_calls?.length) received = true;
      const text = filter ? filter.push(delta.text) : delta.text;
      shown += text;
      if (text) onEvent({ type: 'text-delta', delta: text });
      if (delta.reasoning) onEvent({ type: 'reasoning-delta', delta: delta.reasoning });
    }

    const result = acc.result();
    const tail = filter ? filter.flush() : { text: '', unterminated: false };
    // The answer ended inside a thinking block, so it was never finished.
    if (tail.unterminated) {
      if (shown) onEvent({ type: 'text-reset' });
      throw new Error('Model request failed: the answer ended inside a thinking block.');
    }
    // What the user reads has no thinking block in it; what travels back to the
    // provider is the text as it was written.
    let answer = shown + tail.text;
    let content = result.text;
    // Neither a finish reason nor [DONE]: the connection dropped mid-answer.
    if (!result.finishReason && !done) {
      if (answer) onEvent({ type: 'text-reset' }); // withdrawn before the backup or the error shows
      throw new Error('Model request failed: the response stream ended before the answer was complete.');
    }
    this.turn += 1;
    const complete = COMPLETE.has(result.finishReason) || (done && !result.finishReason);
    if (complete && !result.toolCalls.length && toolChoice !== 'none' && this.textToolCalls) {
      const calls = parseTextToolCalls(answer, this.tools);
      if (calls) {
        result.toolCalls = calls.map((c, n) => ({ id: `textcall_${this.turn}_${n}`, name: c.name, args: c.args }));
        result.rawToolCalls = result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
        answer = '';
        content = '';
        onEvent({ type: 'text-reset' }); // the streamed text was a call, not an answer
      }
    }
    this.messages.push({
      role: 'assistant',
      content: content || null,
      ...(result.rawToolCalls.length ? { tool_calls: result.rawToolCalls } : {}),
      // The thinking travels back in the field it came in, so the next turn of
      // a tool call keeps it.
      ...(minimax || this.thinkingStyle === 'kimi' ? storedReasoning(result) : {}),
    });
    return { text: answer, toolCalls: result.toolCalls, usage: result.usage, retryWaitMs: this.retryWaitMs };
  }

  /** The request up to its response headers, retried on rate limits and overloads. */
  request(toolChoice, signal, deadline) {
    return withRetry(async (remaining) => {
      let res;
      try {
        res = await fetchModel(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          credentials: 'omit',
          ...(this.strictRedirects ? { redirect: 'error' } : {}),
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            ...(OPENCODE.test(this.baseUrl) ? { 'x-opencode-session': this.sessionId } : {}),
          },
          body: requestJson(this.requestBody(toolChoice)),
        }, remaining);
      } catch (err) {
        if (err instanceof TypeError) err.network = true; // fetch itself failed: no connection
        throw err;
      }
      if (res.ok) return res;
      throw new ProviderHttpError(await readError(res, deadline - Date.now()));
    }, { signal, deadline, notify: this.notify, onWait: (ms) => { this.retryWaitMs += ms; } });
  }

  requestBody(toolChoice) {
    const body = {
      model: this.model,
      messages: this.messages,
      tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: toolChoice,
      stream: true,
      ...(this.usage ? { stream_options: { include_usage: true } } : {}),
    };
    if (this.thinkingStyle === 'glm') {
      if (this.effort) body.thinking = { type: this.effort === 'off' ? 'disabled' : 'enabled' };
    } else if (this.thinkingStyle === 'minimax') {
      // MiniMax keeps the thinking inside the answer unless the request asks for
      // it out, and M3.1-Flash rejects a request that asks it to stay in, so the
      // split is always asked for.
      body.reasoning_split = true;
      const depth = MINIMAX_EFFORTS[String(this.effort ?? '').trim().toLowerCase()];
      if (depth && MINIMAX_EFFORT_MODEL.test(this.model)) body.reasoning_effort = depth;
    } else if (this.effort && this.effort !== 'off') {
      body.reasoning_effort = this.effort;
    }
    return body;
  }
}

/** Reassembles streamed Chat Completions deltas, including split tool-call arguments. */
export function createAccumulator({ reasoningDetails = false } = {}) {
  let text = '';
  let usage = null;
  let finishReason = null;
  const calls = [];
  // The thinking, in the field the provider sent it in: MiniMax sends the
  // thinking it split out as reasoning_details, others as reasoning_content.
  let reasoning = '';
  let reasoningField = null;
  let detailEntries = null;
  return {
    push(chunk) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta ?? {};
      const out = { text: delta.content ?? '', reasoning: delta.reasoning_content ?? delta.reasoning ?? '' };
      text += out.text;
      if (reasoningDetails && Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
        out.reasoning = delta.reasoning_details.map((d) => (typeof d === 'string' ? d : d?.text ?? '')).join('');
        reasoningField = 'reasoning_details';
        detailEntries = appendReasoningDetail(detailEntries, delta.reasoning_details);
      } else if (out.reasoning && !reasoningField) {
        reasoningField = delta.reasoning_content != null ? 'reasoning_content' : 'reasoning';
      }
      reasoning += out.reasoning;
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        // Gemini 3 puts a thought signature here and rejects the next turn without it.
        if (tc.extra_content) calls[i].extra = { ...calls[i].extra, ...tc.extra_content };
      }
      return out;
    },
    result() {
      const present = calls.filter(Boolean).map((c, n) => ({ ...c, id: c.id || `call_${n}_${Date.now()}` }));
      return {
        text,
        usage,
        finishReason,
        rawToolCalls: present.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
          ...(c.extra ? { extra_content: c.extra } : {}),
        })),
        toolCalls: present.map((c) => ({ id: c.id, name: c.name, args: safeJson(c.arguments) })),
        reasoning,
        reasoningField,
        reasoningDetails: detailEntries,
      };
    },
  };
}

/** The thinking of an answer, in the field the provider sent it in. */
function storedReasoning(result) {
  if (result.reasoningField === 'reasoning_details') return { reasoning_details: result.reasoningDetails };
  if (result.reasoningField) return { [result.reasoningField]: result.reasoning };
  return {};
}

/**
 * Adds the reasoning entries of one chunk to the ones already there. Entries of
 * the same kind are one entry, as pi-ai does, so thinking that arrives in
 * chunks travels back as the model wrote it.
 */
function appendReasoningDetail(entries, incoming) {
  const merged = entries ?? [];
  for (const entry of incoming) {
    const last = merged[merged.length - 1];
    if (mergeableDetail(last, entry)) {
      if (typeof entry.text === 'string') last.text = (last.text ?? '') + entry.text;
      if (typeof entry.summary === 'string') last.summary = (last.summary ?? '') + entry.summary;
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

/** True when two reasoning entries belong together and their texts can be joined. */
function mergeableDetail(last, entry) {
  if (!last) return false;
  if (last.type || entry.type) return last.type === entry.type && MERGED_DETAIL_TYPES.has(last.type);
  // MiniMax's own entries carry only the text.
  return typeof last.text === 'string' && typeof entry.text === 'string';
}

/**
 * Keeps the last two page observations and the latest notebook read in full; older
 * ones are cut. Notes are short and never cut, and do not push observations out.
 */
export function compactMessages(messages) {
  const names = new Map();
  for (const m of messages) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function?.name);
  const toolMessages = messages.filter((m) => m.role === 'tool');
  const kindOfResult = (m) => kindOf(names.get(m.tool_call_id));
  const observations = toolMessages.filter((m) => !['bookkeeping', 'notes'].includes(kindOfResult(m)));
  const notebookReads = toolMessages.filter((m) => kindOfResult(m) === 'notes');
  // Only the agent adds the notebook header (tools quote it in page text), so it marks
  // a notebook copy; one copy is enough, the latest.
  const lastNotebook = messages.findLastIndex((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes(NOTEBOOK_HEADER));
  messages.forEach((m, i) => {
    if (m.role === 'tool' && i < lastNotebook && typeof m.content === 'string') m.content = withoutNotebook(m.content);
  });
  for (const m of [...observations.slice(0, -KEEP_FULL_OBSERVATIONS), ...notebookReads.slice(0, -1)]) {
    if (typeof m.content === 'string') m.content = trimKeepingNotebook(m.content, TRIMMED_OBSERVATION_CHARS);
  }
  // A note's text is in the latest notebook copy, so once one follows, the call keeps
  // only a marker and old notes no longer grow the context.
  const resultAt = new Map(messages.map((m, i) => [m.role === 'tool' ? m.tool_call_id : null, i]));
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.function?.name === 'note' && resultAt.get(tc.id) < lastNotebook) tc.function.arguments = NOTE_SAVED_ARGS;
    }
  }
  const withImages = messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  for (const m of withImages.slice(0, -1)) {
    m.content = m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[older screenshot removed]' } : c));
  }
}

// A `<think>…</think>` block in an answer: a model whose thinking could not be
// split out writes it inside the content, and the answer the caller reads must
// be the text that follows it.
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const THINK_CLOSE_TAG = /<\/think>/i;
// The longest tail of the dropped text that can still open the closing tag.
const CARRY_LENGTH = THINK_CLOSE.length - 1;

/**
 * Drops a leading `<think>…</think>` block from a streamed answer. The text is
 * held back until it is clear that it does not open such a block, so a block
 * split over several chunks is still recognised, and an answer that starts
 * with anything else is handed on unchanged. Only the block at the very start
 * of the answer is dropped: once real text has been handed on, everything else
 * passes through, so a `<think>` quoted inside the answer is kept.
 */
export class ThinkFilter {
  constructor() {
    this.pending = '';
    this.dropping = false;
    this.carry = ''; // the tail of the dropped text that may still open the closing tag
    this.settled = false; // the leading block is settled: every later text belongs to the answer
    this.afterBlock = false; // the block just ended: the blank lines it left are not answer text
  }

  /** The text that can be handed on now; empty while the block may still open. */
  push(text) {
    if (this.settled) return this.afterBlock ? this.takeAfterBlock(text) : text;
    if (this.dropping) return this.drop(text);
    this.pending += text;
    const trimmed = this.pending.trimStart();
    if (trimmed === '') return '';
    if (trimmed.toLowerCase().startsWith(THINK_OPEN)) {
      const end = THINK_CLOSE_TAG.exec(trimmed);
      if (!end) {
        this.dropping = true;
        // The closing tag may be split after this chunk: keep the tail that may still open it.
        this.carry = trimmed.slice(THINK_OPEN.length).slice(-CARRY_LENGTH);
        this.pending = '';
        return '';
      }
      this.pending = '';
      this.settled = true;
      this.afterBlock = true;
      return this.takeAfterBlock(trimmed.slice(end.index + end[0].length));
    }
    // The text may still turn into a `<think>` block with the next chunk.
    if (THINK_OPEN.startsWith(trimmed.toLowerCase())) return '';
    const out = this.pending;
    this.pending = '';
    this.settled = true;
    return out;
  }

  /**
   * The text left when the stream ends. `unterminated` says the stream ended
   * while the block was still open, so the answer was never complete.
   */
  flush() {
    const text = this.pending;
    this.pending = '';
    const unterminated = this.dropping;
    this.dropping = false;
    this.carry = '';
    return { text, unterminated };
  }

  /** The text after the closing tag, dropping everything the block covered. */
  drop(text) {
    const window = this.carry + text;
    const end = THINK_CLOSE_TAG.exec(window);
    if (!end) {
      this.carry = window.slice(-CARRY_LENGTH);
      return '';
    }
    this.dropping = false;
    this.carry = '';
    this.settled = true;
    this.afterBlock = true;
    return this.takeAfterBlock(window.slice(end.index + end[0].length));
  }

  /** The text after the block, without the blank lines it left behind. */
  takeAfterBlock(text) {
    if (!text.trim()) return ''; // the block left blank lines, not answer text
    this.afterBlock = false;
    return text.replace(/^\s*\n/, '');
  }
}

/** Replaces every image in the conversation with a note; true when there was one. */
function dropImages(messages) {
  let dropped = false;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map((c) => {
      if (c.type !== 'image_url') return c;
      dropped = true;
      return { type: 'text', text: '[screenshot not shown: this model cannot read images]' };
    });
  }
  return dropped;
}

function userMessage(text, images = []) {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { _raw: text };
  }
}

/** The error a task sees: the provider's status stays readable for failure reasons and retries. */
function failure(err, message) {
  const out = new Error(`Model request failed (HTTP ${err.status}): ${message}`);
  out.status = err.status;
  out.detail = err.detail;
  return out;
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}
