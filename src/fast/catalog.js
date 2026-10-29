import { FAST_PRESETS, chatModelsFor } from '../lib/settings.js';
import { listCompatibleModels } from '../providers/openai-compatible.js';
import { fastCatalogBase } from './provider-config.js';

/** A catalog is availability metadata, not proof that an account has access. */
export async function listFastModels(config) {
  const fixed = FAST_PRESETS[config.provider]?.models;
  if (fixed) return fixed.map((id) => ({ id, name: id, efforts: [], decision: true }));
  const list = await listCompatibleModels(fastCatalogBase(config), config.apiKey, { signal: AbortSignal.timeout(30000) });
  if (config.provider !== 'opencode-zen') return list.filter((model) => model.decision);
  const chat = new Set(chatModelsFor('opencode-zen', list).map((model) => model.id));
  // Console's free chat tier is restricted to OpenCode itself. No impersonation
  // or automatic substitution: offer paid chat models plus explicitly chosen Jev.
  return list.filter((model) => model.decision || (chat.has(model.id) && !/-free$/i.test(model.id) && model.id !== 'big-pickle'));
}
