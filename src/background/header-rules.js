// The request-header rules (declarativeNetRequest) for this extension's own
// requests. Chrome drops an Origin or a User-Agent a fetch tries to change, so
// the providers that need either are served by a rule; pages are never touched.

/**
 * The dynamic rules to install.
 * - The Codex backend and OpenAI's sign-in do not expect a browser Origin.
 * - OpenCode asks clients to name themselves in the User-Agent.
 * - The Claude and xAI sign-in endpoints refuse a browser Origin.
 * - Anthropic wants the Claude Code identity in the User-Agent. Its token
 *   endpoint (platform.claude.com) answers a browser User-Agent with 429
 *   "Rate limited" even on a first try, which made the code exchange and every
 *   refresh fail (seen 2026-10-23).
 */
export function headerRules({ extensionId, extensionVersion, claudeCliVersion }) {
  const own = { initiatorDomains: [extensionId], resourceTypes: ['xmlhttprequest', 'other'] };
  const noOrigin = { header: 'origin', operation: 'remove' };
  const claudeCli = { header: 'user-agent', operation: 'set', value: `claude-cli/${claudeCliVersion}` };
  const postora = { header: 'user-agent', operation: 'set', value: `postora-browser-agent/${extensionVersion}` };
  return [
    { id: 1, urlFilter: '||chatgpt.com/backend-api/codex', requestHeaders: [noOrigin] },
    { id: 2, urlFilter: '||auth.openai.com/', requestHeaders: [noOrigin] },
    { id: 3, urlFilter: '||opencode.ai/zen/', requestHeaders: [postora] },
    { id: 4, urlFilter: '||platform.claude.com/', requestHeaders: [noOrigin, claudeCli] },
    { id: 5, urlFilter: '||claude.ai/', requestHeaders: [noOrigin] },
    { id: 6, urlFilter: '||auth.x.ai/', requestHeaders: [noOrigin] },
    { id: 7, urlFilter: '||api.anthropic.com/', requestHeaders: [claudeCli] },
  ].map(({ id, urlFilter, requestHeaders }) => ({
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: { urlFilter, ...own },
  }));
}
