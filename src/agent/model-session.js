// Builds the model side of a session from settings: the main provider wrapped
// in FallbackSession (with the configured backup) and the fast layer's ask.

import { FallbackSession, emptyLog, handoffMessage } from './fallback-session.js';
import { buildSystemPrompt } from './prompt.js';
import { toolDefinitions } from './tools.js';
import { createFastAsk } from '../fast/clients.js';
import { COMPATIBLE_PRESETS, effectiveSettings } from '../lib/settings.js';
import { normalizeMode } from '../permissions/policy.js';
import { AnthropicSession } from '../providers/anthropic.js';
import { ChatgptSession } from '../providers/chatgpt.js';
import { CompatibleSession } from '../providers/openai-compatible.js';
import { GrokAccountSession } from '../providers/responses.js';

export { createFastAsk };

/**
 * A provider session for one model slot: the main one or settings.fallback.
 * `conversationId` is the saved session's id, so a provider that tracks
 * conversations (OpenCode) sees the same one after the worker restarts.
 *
 * `accessState` is the worker's runtime snapshot of the access mode. It is
 * passed to the prompt of every slot, so the main model and the backup both
 * describe the same mode the worker enforces. It is never read from settings.
 */
function createProviderSession(slot, settings, conversationId, notify = null, accessState = null) {
  const tools = toolDefinitions(effectiveSettings(settings));
  const systemPrompt = buildSystemPrompt(effectiveSettings(settings), { accessState });
  if (slot.provider === 'chatgpt') {
    if (!slot.chatgpt.model) throw new Error('Choose a ChatGPT model in settings first.');
    return new ChatgptSession({ ...slot.chatgpt, systemPrompt, tools, notify });
  }
  if (slot.provider === 'claude') {
    if (!slot.claude.model) throw new Error('Choose a Claude model in settings first.');
    return new AnthropicSession({ ...slot.claude, systemPrompt, tools, notify });
  }
  if (slot.provider === 'grok') {
    if (!slot.grok.model) throw new Error('Choose a Grok model in settings first.');
    return new GrokAccountSession({ ...slot.grok, systemPrompt, tools, notify });
  }
  const c = slot.compatible;
  if (!c.model) throw new Error('Choose a model in settings first.');
  const preset = COMPATIBLE_PRESETS[c.preset] ?? COMPATIBLE_PRESETS.custom;
  return new CompatibleSession({ ...c, thinkingStyle: preset.thinkingStyle, systemPrompt, tools, sessionId: conversationId, notify, textToolCalls: Boolean(preset.textToolCalls), usage: Boolean(preset.usage) });
}

const TEST_TIMEOUT_MS = 45000;

/**
 * A real request to a model slot with the tools and prompt a task uses, so a model
 * that rejects tools or the reasoning setting fails here and not in the first task.
 */
export async function testProviderSlot(slot, settings) {
  const session = createProviderSession(slot, settings);
  session.addUserMessage('Connection test: reply with the single word OK and do not call any tool.');
  const started = Date.now();
  const turn = await session.next({ signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  return { ms: Date.now() - started, model: slotLabel(slot), reply: (turn.text || '').trim().slice(0, 60) };
}

function slotLabel(slot) {
  if (slot.provider === 'chatgpt') return `ChatGPT · ${slot.chatgpt.model}`;
  if (slot.provider === 'claude') return `Claude · ${slot.claude.model}`;
  if (slot.provider === 'grok') return `Grok · ${slot.grok.model}`;
  return `${COMPATIBLE_PRESETS[slot.compatible.preset]?.label ?? 'API'} · ${slot.compatible.model}`;
}

/**
 * A fresh FallbackSession. With `seed`, the conversation so far (a neutral log)
 * reaches the new primary as a handoff message: after a task the backup
 * finished, after a settings change, or when a saved session is reopened.
 *
 * `accessState` is the worker's runtime snapshot of the access mode. Both
 * slots get it, so the backup cannot describe a different mode than the main
 * model. Without a snapshot the prompt says Ask first, the mode a session
 * starts in.
 */
export function createModelSession(settings, { notify, seed = null, conversationId, notebook = null, accessState = null } = {}) {
  const primary = createProviderSession(settings, settings, conversationId, notify, accessState);
  if (seed?.log?.task) primary.addUserMessage(handoffMessage(seed.log, seed.reason, notebook));
  const backupEnabled = settings.fallback.enabled;
  return new FallbackSession({
    primary,
    createBackup: backupEnabled ? () => createProviderSession(settings.fallback, settings, conversationId, notify, accessState) : null,
    labels: { primary: slotLabel(settings), backup: backupEnabled ? slotLabel(settings.fallback) : '' },
    notify,
    log: seed?.log ?? emptyLog(),
    notebook,
  });
}

/**
 * Settings that require a new model session when they change.
 *
 * The access mode is part of it: the prompt describes the mode the worker
 * enforces, so a mode change has to rebuild the session for the next task.
 * The mode comes from the runtime snapshot only, normalized the same way the
 * policy normalizes it, so a missing or malformed snapshot is Ask first and
 * can never be anything else.
 */
export function modelSessionKey(settings, { accessState } = {}) {
  return JSON.stringify([settings.provider, settings.chatgpt, settings.claude, settings.grok, settings.compatible, settings.fallback, settings.vision, settings.allowJavascript, settings.replyLanguage, normalizeMode(accessState?.mode)]);
}
