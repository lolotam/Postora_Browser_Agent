// The OpenAI Responses API, with the parts that differ per backend behind
// constructor options: ChatGPT's Codex backend and xAI's API both speak it.
// A turn counts only when the stream says the response completed, so a stream
// that dies half way leaves the conversation untouched and the backup
// provider can take over.

import { requestJson } from '../lib/json.js';
import { MODEL_IDLE_MS, fetchModel, readSse } from '../lib/sse.js';
import { ProviderHttpError, readError, withRetry } from '../lib/retry.js';
import { providerErrorMessage } from '../lib/failure.js';
import { getValidCredential } from './account-auth.js';
import { kindOf } from '../agent/tool-kinds.js';
import { NOTEBOOK_HEADER, NOTE_SAVED_ARGS, trimKeepingNotebook, withoutNotebook } from '../agent/notebook.js';

const KEEP_FULL_OBSERVATIONS = 2;
const TRIMMED_OBSERVATION_CHARS = 400;
// xAI's API, where a signed-in Grok account sends its requests.
const XAI_BASE_URL = 'https://api.x.ai/v1';

/**
 * A session that speaks the OpenAI Responses API. The backend decides the rest:
 * the base URL, the auth headers, the extra headers and the request fields that
 * only one backend accepts are constructor options.
 */
export class ResponsesSession {
  constructor({
    baseUrl,
    model,
    effort = '',
    systemPrompt = '',
    tools = [],
    notify = null,
    authHeaders = async () => ({}),
    extraHeaders = () => ({}),
    // The system prompt is a message of its own, for backends without an
    // instructions field.
    instructionsAsField = false,
    parallelToolCalls = true,
    provider = '',
    label = 'The provider',
    describeError = null,
  }) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.effort = effort;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.notify = notify;
    this.authHeaders = authHeaders;
    this.extraHeaders = extraHeaders;
    this.instructionsAsField = instructionsAsField;
    this.parallelToolCalls = parallelToolCalls;
    this.provider = provider;
    this.describeError = describeError ?? ((status, detail) => providerErrorMessage(label, status, detail));
    this.input = [];
    this.pendingImages = [];
    this.sessionId = crypto.randomUUID();
    this.retryWaitMs = 0;
  }

  addUserMessage(text, images = []) {
    this.input.push(userMessage(text, images));
  }

  addToolResult(callId, output, images = []) {
    this.input.push({ type: 'function_call_output', call_id: callId, output });
    this.pendingImages.push(...images);
  }

  async next({ signal, onEvent = () => {}, toolChoice = 'auto' }) {
    if (this.pendingImages.length) {
      this.input.push(userMessage('Screenshot returned by the last tool call:', this.pendingImages));
      this.pendingImages = [];
    }
    compactInput(this.input);
    this.retryWaitMs = 0;

    const response = await this.post(toolChoice, signal);
    const items = [];
    let usage = null;
    let completed = false;
    let streamed = false;
    let wasReset = false;
    // A half answer must not stay on screen, nor be followed by the backup's.
    const resetText = () => {
      if (!streamed || wasReset) return;
      wasReset = true;
      onEvent({ type: 'text-reset' });
    };
    try {
      for await (const { data } of readSse(response, signal)) {
        if (data === '[DONE]') break;
        const event = JSON.parse(data);
        switch (event.type) {
          case 'response.output_text.delta':
            streamed = true;
            onEvent({ type: 'text-delta', delta: event.delta });
            break;
          case 'response.reasoning_summary_text.delta':
            onEvent({ type: 'reasoning-delta', delta: event.delta });
            break;
          case 'response.reasoning_summary_part.done':
            onEvent({ type: 'reasoning-delta', delta: '\n\n' });
            break;
          case 'response.output_item.done':
            items.push(event.item);
            break;
          case 'response.completed':
            completed = true;
            usage = event.response?.usage ?? null;
            break;
          case 'response.failed':
          case 'response.incomplete':
            resetText();
            throw new Error(event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? 'The model response failed.');
          case 'error':
            resetText();
            throw new Error(event.message ?? event.error?.message ?? 'The model returned an error.');
          default:
            break;
        }
      }
    } catch (err) {
      // A body that fails to read, the idle timeout or a malformed event.
      resetText();
      throw err;
    }
    // The turn only counts when the response completed; a stream that ends
    // early leaves the conversation as it was.
    if (!completed) {
      resetText();
      throw new Error('Model request failed: the response stream ended before the answer was complete.');
    }
    let output;
    try {
      output = parseOutput(items, usage);
    } catch (err) {
      resetText();
      throw err;
    }
    this.input.push(...items.map(withoutId));
    return { ...output, retryWaitMs: this.retryWaitMs };
  }

  async post(toolChoice, signal, { refreshed = false, deadline = Date.now() + MODEL_IDLE_MS } = {}) {
    const headers = {
      ...(await this.authHeaders(refreshed)),
      ...this.extraHeaders(this),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const body = this.requestBody(toolChoice);
    try {
      return await withRetry(async (remaining) => {
        let res;
        try {
          res = await fetchModel(`${this.baseUrl}/responses`, { method: 'POST', credentials: 'omit', signal, headers, body: requestJson(body) }, remaining);
        } catch (err) {
          if (err instanceof TypeError) err.network = true;
          throw err;
        }
        if (res.ok) return res;
        throw new ProviderHttpError(await readError(res, deadline - Date.now()));
      }, { signal, deadline, provider: this.provider, notify: this.notify, onWait: (ms) => { this.retryWaitMs += ms; } });
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      if (err.status === 401 && !refreshed) return this.post(toolChoice, signal, { refreshed: true, deadline });
      if (err.status === 400 && this.instructionsAsField && /instruction/i.test(err.detail)) {
        this.instructionsAsField = false;
        return this.post(toolChoice, signal, { refreshed, deadline });
      }
      const out = new Error(this.describeError(err.status, err.detail));
      out.status = err.status;
      out.detail = err.detail;
      throw out;
    }
  }

  requestBody(toolChoice) {
    return {
      model: this.model,
      ...(this.instructionsAsField ? { instructions: this.systemPrompt } : {}),
      input: this.instructionsAsField ? this.input : [developerMessage(this.systemPrompt), ...this.input].filter(Boolean),
      tools: this.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      tool_choice: toolChoice,
      // A form's fields and its submit can come in one turn.
      ...(this.parallelToolCalls ? { parallel_tool_calls: true } : {}),
      reasoning: this.effort ? { effort: this.effort, summary: 'auto' } : { summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: this.sessionId,
    };
  }
}

/**
 * A Grok account (SuperGrok or X Premium) through xAI's Responses API, the
 * transport pi-ai uses for xAI.
 */
export class GrokAccountSession extends ResponsesSession {
  constructor({ model, effort = '', systemPrompt = '', tools = [], notify = null }) {
    super({
      baseUrl: XAI_BASE_URL,
      model,
      effort,
      systemPrompt,
      tools,
      notify,
      authHeaders: (refreshed) => grokAuthHeaders(refreshed),
      // The request stays the one pi-ai sends to xAI, which does not ask for
      // parallel calls.
      parallelToolCalls: false,
      provider: 'xai',
      label: 'Grok',
    });
  }
}

/** The auth headers of a signed-in Grok account. */
async function grokAuthHeaders(refreshed = false) {
  const credential = await getValidCredential('grok', { forceRefresh: refreshed });
  return { Authorization: `Bearer ${credential.access}` };
}

/** The models a signed-in Grok account may use. */
export async function listGrokModels() {
  const url = `${XAI_BASE_URL}/models`;
  let res = await fetch(url, { credentials: 'omit', headers: await grokAuthHeaders() });
  if (res.status === 401) res = await fetch(url, { credentials: 'omit', headers: await grokAuthHeaders(true) });
  if (!res.ok) throw new Error(`Could not load models (HTTP ${res.status}).`);
  const { data = [] } = await res.json();
  return data
    .filter((m) => m?.id)
    .map((m) => ({ id: m.id, name: m.name ?? m.id, description: m.description ?? '', efforts: grokEfforts(m.id), defaultEffort: null }));
}

/** The effort levels a Grok model takes: xhigh arrived with Grok 4.6. */
function grokEfforts(modelId) {
  return /grok-4\.[6-9]|grok-[5-9]/.test(String(modelId ?? '')) ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
}

function userMessage(text, images) {
  return {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' })),
    ],
  };
}

/** The system prompt as a message of its own, for backends without an instructions field. */
function developerMessage(text) {
  if (!text) return null;
  return { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] };
}

/** With store:false the backend keeps nothing, so server item ids must not be echoed back. */
export function withoutId(item) {
  const { id, ...rest } = item;
  return rest;
}

export function parseOutput(items, usage = null) {
  const text = items
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
  const toolCalls = items
    .filter((i) => i.type === 'function_call')
    .map((i) => ({ id: i.call_id, name: i.name, args: toolArguments(i.arguments) }));
  return { text, toolCalls, usage };
}

/**
 * The arguments of a call. A call whose arguments are not JSON is not a call:
 * running it would act on arguments nobody wrote.
 */
function toolArguments(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('The model sent a tool call with broken arguments, so it was not run.');
  }
}

/** Shrinks old page observations and screenshots so long tasks stay within context. */
export function compactInput(input) {
  const names = new Map(input.filter((i) => i.type === 'function_call').map((i) => [i.call_id, i.name]));
  const outputs = input.filter((i) => i.type === 'function_call_output');
  const kindOfResult = (i) => kindOf(names.get(i.call_id));
  const observations = outputs.filter((i) => !['bookkeeping', 'notes'].includes(kindOfResult(i)));
  const notebookReads = outputs.filter((i) => kindOfResult(i) === 'notes');
  // One notebook copy, the latest (see compactMessages).
  const lastNotebook = input.findLastIndex((i) => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes(NOTEBOOK_HEADER));
  input.forEach((item, n) => {
    if (item.type === 'function_call_output' && n < lastNotebook && typeof item.output === 'string') item.output = withoutNotebook(item.output);
  });
  for (const item of [...observations.slice(0, -KEEP_FULL_OBSERVATIONS), ...notebookReads.slice(0, -1)]) {
    if (typeof item.output === 'string') item.output = trimKeepingNotebook(item.output, TRIMMED_OBSERVATION_CHARS);
  }
  // Notes already shown in a later notebook copy keep only a marker (see compactMessages).
  const resultAt = new Map(input.map((i, n) => [i.type === 'function_call_output' ? i.call_id : null, n]));
  for (const item of input) {
    if (item.type === 'function_call' && item.name === 'note' && resultAt.get(item.call_id) < lastNotebook) item.arguments = NOTE_SAVED_ARGS;
  }
  const withImages = input.filter((i) => i.type === 'message' && i.content?.some((c) => c.type === 'input_image'));
  for (const message of withImages.slice(0, -1)) {
    message.content = message.content.map((c) => (c.type === 'input_image' ? { type: 'input_text', text: '[older screenshot removed]' } : c));
  }
}
