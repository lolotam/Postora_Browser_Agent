// User settings persisted in chrome.storage.local.

import { keyGroup, shareKeys } from './keys.js';
import { STORE_BUILD } from './build.js';

/** The providers that sign in with an account, in the order they are listed. */
export const ACCOUNT_PROVIDERS = ['chatgpt', 'claude', 'grok'];

/** The name each account provider is shown under. */
export const PROVIDER_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };

// Main model and backup providers (both use this list). thinkingStyle 'none' sends
// no reasoning parameter, for APIs whose models reject reasoning_effort; 'gemini'
// offers no Off, because Gemini 3 thinking cannot be turned off; 'minimax' always
// asks for the thinking to be split out of the answer, because MiniMax cannot
// stop thinking.
export const COMPATIBLE_PRESETS = {
  openai: { label: 'OpenAI API key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', thinkingStyle: 'reasoning_effort', usage: true },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', thinkingStyle: 'gemini', usage: true },
  xai: { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', thinkingStyle: 'reasoning_effort', usage: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', thinkingStyle: 'none', usage: true },
  // textToolCalls: its models were seen writing tool calls as text (showcase, 2026-10-10).
  nvidia: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-super-120b-a12b', thinkingStyle: 'none', textToolCalls: true, usage: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', thinkingStyle: 'reasoning_effort', usage: true },
  'opencode-zen': { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', model: 'glm-5.3', thinkingStyle: 'none' },
  'opencode-go': { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3', thinkingStyle: 'none' },
  'zai-coding': { label: 'Z.ai GLM Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  zai: { label: 'Z.ai GLM (API)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  // MiniMax always thinks; reasoning_split moves the thinking out of the answer.
  // The coding plan bills separately, so it is a preset of its own with its own key.
  minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3.1-Flash', thinkingStyle: 'minimax', usage: true, models: ['MiniMax-M3.1-Flash'] },
  'minimax-coding-plan': { label: 'MiniMax Coding Plan', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3.1-Flash', thinkingStyle: 'minimax', usage: true, models: ['MiniMax-M3.1-Flash'] },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', model: '', thinkingStyle: 'reasoning_effort' },
};

// OpenCode serves each model family on its own endpoint (docs, Oct 2026): GPT, Grok
// and Muse on /responses, Claude, some Qwen and (on Go) MiniMax on /messages,
// Gemini on Google's path, Jev on /systemone. The agent speaks /chat/completions,
// so those families are left out of the list until those APIs are supported.
const NOT_CHAT_COMPLETIONS = {
  'opencode-zen': /^(gpt-|grok-|muse-spark|claude-|gemini-|jev-|qwen3\.(8-flash|7-|6-|5-))/,
  'opencode-go': /^(gpt-|grok-|muse-spark|claude-|qwen|minimax-)/,
};

export function chatModelsFor(presetId, models) {
  const excluded = NOT_CHAT_COMPLETIONS[presetId];
  return excluded ? models.filter((m) => !excluded.test(m.id)) : models;
}

/**
 * The models a slot shows: the provider's own list, or the fixed list of the
 * preset when the provider serves none (MiniMax has no /models).
 */
export function slotModels(preset, list) {
  if (list.length) return chatModelsFor(preset, list);
  const fixed = COMPATIBLE_PRESETS[preset]?.models ?? [];
  return fixed.map((id) => ({ id, name: id, efforts: [], decision: false }));
}

// Fast-layer providers serve decision models (Jev).
// The free pairing that did best in the Postora showcase (October 2026): NVIDIA's
// Nemotron 3 Super as the main model, Apodex Mini on OpenRouter as the backup.
export const RECOMMENDED_SETUP = {
  main: { preset: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', keyUrl: 'https://build.nvidia.com/settings/api-keys' },
  backup: { preset: 'openrouter', model: 'apodex/apodex-1.1-mini:free', keyUrl: 'https://openrouter.ai/settings/keys' },
};

/**
 * The main and backup slots for the recommended setup, built on a settings draft:
 * keys already stored for those providers are kept, the rest of the draft is untouched.
 */
export function recommendedSlots(draft, presets = COMPATIBLE_PRESETS) {
  const slot = (base, { preset, model }) => ({
    ...base,
    provider: 'compatible',
    compatible: { ...base.compatible, preset, baseUrl: presets[preset].baseUrl, apiKey: draft.keys?.[keyGroup(preset)] ?? '', model, effort: '' },
  });
  return {
    main: slot(draft, RECOMMENDED_SETUP.main),
    fallback: { ...slot(draft.fallback, RECOMMENDED_SETUP.backup), enabled: true },
  };
}

export const FAST_PRESETS = {
  typesafe: { label: 'TypeSafe Jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', minProb: 0.6, decision: true },
  vercel: { label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev', minProb: 0.6, decision: true },
  // Zen serves Jev on TypeSafe's own /v1/systemone API under its base URL.
  'opencode-zen': { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen', model: 'jev-1.13', minProb: 0.6, decision: true },
  // OpenRouter serves Jev on /api/v1/systemone too, but leaves it out of /models,
  // so its two ids are listed here.
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', minProb: 0.6, decision: true, models: ['typesafe/jev-1.13', '~typesafe/jev-latest'] },
};

export const DEFAULT_SETTINGS = {
  provider: 'chatgpt',
  chatgpt: { model: '', effort: '' },
  // The Claude slot signs in with a Claude account or pays with an Anthropic key.
  claude: { auth: 'account', apiKey: '', model: '', effort: '' },
  // The Grok slot signs in with a Grok account; an xAI key goes through the preset.
  grok: { model: '', effort: '' },
  compatible: { preset: 'xai', baseUrl: COMPATIBLE_PRESETS.xai.baseUrl, apiKey: '', model: COMPATIBLE_PRESETS.xai.model, effort: '' },
  fast: {
    enabled: false, mode: 'auto', provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', minProb: 0.6, riskyMax: 0.3,
    fallback: { enabled: false, provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', decision: true },
  },
  // Used when the main model's provider fails mid-task (see FallbackSession).
  fallback: {
    enabled: false,
    provider: 'compatible',
    chatgpt: { model: '', effort: '' },
    claude: { auth: 'account', apiKey: '', model: '', effort: '' },
    grok: { model: '', effort: '' },
    compatible: { preset: 'openrouter', baseUrl: COMPATIBLE_PRESETS.openrouter.baseUrl, apiKey: '', model: '', effort: '' },
  },
  maxSteps: 40,
  vision: true,
  allowJavascript: false,
  // The agent's cursor, captions and Stop bar drawn on the page it controls.
  showCursor: true,
  notify: false, // desktop notifications; also needs the optional permission
  // A message sent while a task runs: 'next-step', 'interrupt' or 'queue' (see SessionRunner.steer).
  steerMode: 'next-step',
  uiLanguage: 'auto',
  // Off: the agent replies in the language the task is written in.
  replyLanguage: { enabled: false, language: '' },
  // One API key per provider for every slot (see shareKeys).
  keys: {},
};

/** The settings a task runs with: the store build never offers the run-JavaScript tool. */
export function effectiveSettings(settings) {
  return STORE_BUILD ? { ...settings, allowJavascript: false } : settings;
}

/**
 * The settings of the slot a provider uses: its model, its effort and its key.
 * The main settings and a backup slot have the same shape.
 */
export function slotSettings(settings) {
  if (settings.provider === 'chatgpt') return settings.chatgpt;
  if (settings.provider === 'claude') return settings.claude;
  if (settings.provider === 'grok') return settings.grok;
  return settings.compatible;
}

/**
 * The model list a slot's provider needs: the account providers have their
 * own, every other provider goes through the OpenAI-compatible list.
 */
export function modelListRoute(settings) {
  return ACCOUNT_PROVIDERS.includes(settings.provider) ? settings.provider : 'compatible';
}

/**
 * The i18n key of the first thing that blocks saving, or null. The model is
 * the one of the slot the chosen provider uses, so a Claude or Grok slot is
 * saved with its own model, whatever the compatible slot holds.
 */
export function settingsProblem(settings) {
  if (!slotSettings(settings).model) return 'err.pickModel';
  if (needsAnthropicKey(settings)) return 'err.anthropicKey';
  if (settings.replyLanguage.enabled && !settings.replyLanguage.language) return 'err.pickReplyLanguage';
  if (settings.fallback.enabled && !slotSettings(settings.fallback).model) return 'err.fallbackModel';
  if (settings.fallback.enabled && needsAnthropicKey(settings.fallback)) return 'err.fallbackAnthropicKey';
  if (settings.fast.enabled && !settings.fast.apiKey) return 'err.fastKey';
  if (settings.fast.enabled && !settings.fast.baseUrl) return 'err.fastUrl';
  if (settings.fast.enabled && settings.fast.fallback.enabled && !settings.fast.fallback.apiKey) return 'err.fastFallbackKey';
  return null;
}

/** A Claude slot set to an Anthropic API key that has none: every request would fail. */
function needsAnthropicKey(slot) {
  return slot.provider === 'claude' && slot.claude?.auth === 'apiKey' && !slot.claude.apiKey?.trim();
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

export function mergeSettings(stored = {}) {
  return shareKeys({
    ...DEFAULT_SETTINGS,
    ...stored,
    chatgpt: { ...DEFAULT_SETTINGS.chatgpt, ...(stored.chatgpt ?? {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...(stored.claude ?? {}) },
    grok: { ...DEFAULT_SETTINGS.grok, ...(stored.grok ?? {}) },
    compatible: { ...DEFAULT_SETTINGS.compatible, ...(stored.compatible ?? {}) },
    fast: {
      ...DEFAULT_SETTINGS.fast,
      ...(stored.fast ?? {}),
      fallback: { ...DEFAULT_SETTINGS.fast.fallback, ...(stored.fast?.fallback ?? {}) },
    },
    replyLanguage: { ...DEFAULT_SETTINGS.replyLanguage, ...(stored.replyLanguage ?? {}) },
    fallback: {
      ...DEFAULT_SETTINGS.fallback,
      ...(stored.fallback ?? {}),
      chatgpt: { ...DEFAULT_SETTINGS.fallback.chatgpt, ...(stored.fallback?.chatgpt ?? {}) },
      claude: { ...DEFAULT_SETTINGS.fallback.claude, ...(stored.fallback?.claude ?? {}) },
      grok: { ...DEFAULT_SETTINGS.fallback.grok, ...(stored.fallback?.grok ?? {}) },
      compatible: { ...DEFAULT_SETTINGS.fallback.compatible, ...(stored.fallback?.compatible ?? {}) },
    },
    keys: { ...(stored.keys ?? {}) },
  });
}
