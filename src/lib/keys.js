// One API key per provider for the whole app: a key entered for OpenRouter in the
// main slot is used by the backup and the fast layer whenever they pick
// OpenRouter too. Zen and Go are two OpenCode gateways on the same account key.
// The Anthropic key is one key for the whole app too, so the Claude slot of the
// main model and the one of its backup share it. Custom endpoints differ per
// URL, so their keys are never shared. Every other provider keeps its own
// group, so the two MiniMax plans (pay-as-you-go and the coding plan) never
// share a key.

const SHARED_GROUP = { 'opencode-zen': 'opencode', 'opencode-go': 'opencode' };
// The key group of the Claude slots: the Anthropic key, whatever slot uses it.
export const ANTHROPIC_GROUP = 'anthropic';

/** The key a provider uses, by preset id (main/backup) or fast provider id; null when not shared. */
export function keyGroup(provider) {
  if (!provider || provider === 'custom') return null;
  return SHARED_GROUP[provider] ?? provider;
}

/** Each slot that holds an API key, with the provider that decides which key it is. */
function keySlots(settings) {
  return [
    [settings.compatible, settings.compatible?.preset],
    [settings.fallback?.compatible, settings.fallback?.compatible?.preset],
    // The Claude slots of the main model and of its backup share one Anthropic key.
    [settings.claude, ANTHROPIC_GROUP],
    [settings.fallback?.claude, ANTHROPIC_GROUP],
    [settings.fast, settings.fast?.provider],
    [settings.fast?.fallback, settings.fast?.fallback?.provider],
  ].filter(([slot]) => slot);
}

/**
 * Fills `settings.keys` from slot keys it does not know yet (settings saved before
 * keys were shared), then gives every slot without a key its provider's key.
 * Slot objects are updated in place.
 */
export function shareKeys(settings) {
  const keys = { ...settings.keys };
  const slots = keySlots(settings).map(([slot, provider]) => [slot, keyGroup(provider)]).filter(([, group]) => group);
  for (const [slot, group] of slots) if (slot.apiKey && !keys[group]) keys[group] = slot.apiKey;
  for (const [slot, group] of slots) if (!slot.apiKey && keys[group]) slot.apiKey = keys[group];
  settings.keys = keys;
  return settings;
}
