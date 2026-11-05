// UI routes map onto the existing provider engines and credential stores.
// A coding-plan key is not an OAuth login, even when it pays from a subscription.
export const CONNECTION_ROUTES = [
  { id: 'chatgpt', provider: 'chatgpt', label: 'ChatGPT / Codex', group: 'auth' },
  { id: 'claude', provider: 'claude', auth: 'account', label: 'Claude / Claude Code', group: 'auth' },
  { id: 'grok', provider: 'grok', label: 'xAI / Grok', group: 'auth' },
  { id: 'kimi-account', provider: 'kimi', auth: 'account', label: 'Kimi Code', group: 'auth' },
  { id: 'openrouter-auth', provider: 'compatible', preset: 'openrouter', label: 'OpenRouter (OAuth)', group: 'auth' },
  { id: 'minimax-plan', provider: 'compatible', preset: 'minimax-coding-plan', labelKey: 'connection.minimaxPlan', group: 'auth' },
  { id: 'zai-plan', provider: 'compatible', preset: 'zai-coding', labelKey: 'connection.zaiPlan', group: 'auth' },
  { id: 'claude-api', provider: 'claude', auth: 'apiKey', label: 'Claude / Anthropic', group: 'api' },
  { id: 'gemini', provider: 'gemini', label: 'Google Gemini', group: 'api' },
  { id: 'kimi', provider: 'kimi', auth: 'apiKey', label: 'Kimi / Moonshot', group: 'api' },
  ...['openrouter', 'openai', 'xai', 'minimax', 'minimax-coding-plan', 'zai', 'zai-coding', 'deepseek', 'nvidia'].map((preset) => ({
    id: `api:${preset}`, provider: 'compatible', preset, group: 'api',
  })),
  { id: 'compatible', provider: 'compatible', labelKey: 'settings.provider.compatible', group: 'api' },
];

export function connectionRoute(id) {
  return CONNECTION_ROUTES.find((route) => route.id === id) ?? CONNECTION_ROUTES.at(-1);
}

export function routeForSettings(slot) {
  const matches = (route) => route.provider === slot.provider
    && (!route.auth || route.auth === slot[route.provider]?.auth)
    && (!route.preset || route.preset === slot.compatible?.preset);
  const saved = CONNECTION_ROUTES.find((route) => route.id === slot.connectionRoute && matches(route));
  if (saved) return saved.id;
  return CONNECTION_ROUTES.find((route) => route.id !== 'openrouter-auth' && matches(route))?.id ?? 'compatible';
}
