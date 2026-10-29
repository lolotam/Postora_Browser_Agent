// Named API providers reuse the existing streaming/tool-history transport.
// Their endpoint and credential scope are fixed, not editable gateway URLs.
import { GEMINI_API_URL } from '../lib/settings.js';
import { listCompatibleModels } from './openai-compatible.js';

/** Gemini's officially supported OpenAI-compatible model catalog. */
export async function listGeminiModels(config) {
  if (!config.apiKey?.trim()) throw new Error('Enter a Gemini API key in settings first.');
  return (await listCompatibleModels(GEMINI_API_URL, config.apiKey, {
    anonymousFallback: false, redirect: 'error', signal: AbortSignal.timeout(30000),
  })).filter((model) => !model.decision && model.tools !== false && geminiChatModel(model.id));
}

/** Specialized Gemini image/audio/live models are not browser-tool chat models. */
export function geminiChatModel(id) {
  return /^gemini-/i.test(id) && !/(?:^|-)(image|tts|audio|live|embedding|robotics|omni)(?:-|$)/i.test(id);
}
