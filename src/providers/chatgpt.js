// Model access through a ChatGPT subscription: the Codex backend speaks the
// OpenAI Responses API at chatgpt.com/backend-api/codex.

import { ResponsesSession } from './responses.js';
import { getValidAuth } from './chatgpt-auth.js';
import { providerErrorMessage } from '../lib/failure.js';

const BASE_URL = 'https://chatgpt.com/backend-api/codex';
// The backend drops models newer than the asking client, so ask as the newest
// Codex CLI release on npm. The fallback only matters when npm is unreachable.
const FALLBACK_CLIENT_VERSION = '0.161.0';
const CLIENT_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

async function authHeaders(forceRefresh = false) {
  const auth = await getValidAuth({ forceRefresh });
  const headers = { Authorization: `Bearer ${auth.accessToken}`, originator: 'codex_cli_rs' };
  if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
  return headers;
}

/** Lists every model the signed-in plan returns; ones OpenAI hides come last, flagged. */
export async function listChatgptModels() {
  const url = `${BASE_URL}/models?client_version=${await codexClientVersion()}`;
  let res = await fetch(url, { credentials: 'omit', headers: await authHeaders() });
  if (res.status === 401) res = await fetch(url, { credentials: 'omit', headers: await authHeaders(true) });
  if (!res.ok) throw new Error(`Could not load models (HTTP ${res.status}).`);
  const { models = [] } = await res.json();
  const isHidden = (m) => m.visibility === 'hide' || m.visibility === 'none';
  return models
    .sort((a, b) => isHidden(a) - isHidden(b) || (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({
      id: m.slug,
      name: m.display_name ?? m.slug,
      description: m.description ?? '',
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level ?? null,
      contextWindow: m.context_window ?? null,
      hidden: isHidden(m),
    }));
}

/** Latest @openai/codex version, cached a day; falls back to the last known one when npm fails. */
async function codexClientVersion() {
  const { codexVersion: cached } = await chrome.storage.local.get('codexVersion');
  if (cached && Date.now() - cached.fetchedAt < CLIENT_VERSION_TTL_MS) return cached.version;
  try {
    const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', { credentials: 'omit' });
    const { version } = res.ok ? await res.json() : {};
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`unexpected npm answer (HTTP ${res.status})`);
    await chrome.storage.local.set({ codexVersion: { version, fetchedAt: Date.now() } });
    return version;
  } catch {
    return cached?.version ?? FALLBACK_CLIENT_VERSION;
  }
}

/** A ChatGPT subscription through the Responses API the Codex backend speaks. */
export class ChatgptSession extends ResponsesSession {
  constructor({ model, effort = '', systemPrompt = '', tools = [], notify = null }) {
    super({
      baseUrl: BASE_URL,
      model,
      effort,
      systemPrompt,
      tools,
      notify,
      authHeaders,
      extraHeaders: (session) => ({
        'OpenAI-Beta': 'responses=experimental',
        'session-id': session.sessionId,
        session_id: session.sessionId,
      }),
      // The Codex backend takes the system prompt as a field of its own.
      instructionsAsField: true,
      provider: 'chatgpt',
      describeError: describeChatgptError,
    });
  }
}

/** What a refusal of the Codex backend usually means. */
function describeChatgptError(status, detail) {
  return providerErrorMessage('ChatGPT', status, detail, {
    forbidden: 'The plan may not include Codex access, or OpenAI blocked this client.',
  });
}

export { compactInput, parseOutput, withoutId } from './responses.js';
