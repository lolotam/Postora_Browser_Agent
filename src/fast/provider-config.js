// Zen supports both native Jev and JSON chat judges. A stale `decision` flag
// must never send a chat model to System One (or Jev to chat completions).
export function isZenDecisionModel(model) {
  return /^jev-/i.test(model ?? '');
}

/** Align only known first-party Zen paths; never rewrite custom gateway URLs. */
export function fastRequestConfig(config) {
  if (config.provider !== 'opencode-zen') return config;
  const decision = isZenDecisionModel(config.model);
  let baseUrl = config.baseUrl;
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (url.origin === 'https://opencode.ai' && !url.username && !url.password && !url.search && !url.hash) {
      if (['/zen', '/zen/v1'].includes(path)) baseUrl = `${url.origin}/zen${decision ? '' : '/v1'}`;
      if (['/inference/openai/v1', '/inference/systemone', '/inference/systemone/v1'].includes(path)) {
        baseUrl = `${url.origin}/inference/${decision ? 'systemone' : 'openai/v1'}`;
      }
    }
  } catch { /* The client reports an invalid/custom URL without forwarding elsewhere. */ }
  return { ...config, baseUrl, decision };
}

export function fastCatalogBase(config) {
  const base = String(config.baseUrl).replace(/\/+$/, '');
  if (config.provider !== 'opencode-zen') return base;
  if (/^https:\/\/opencode\.ai\/inference\/(openai\/v1|systemone(?:\/v1)?)$/.test(base)) return 'https://opencode.ai/inference/v1';
  if (/^https:\/\/opencode\.ai\/zen(?:\/v1)?$/.test(base)) return 'https://opencode.ai/zen/v1';
  return base;
}
