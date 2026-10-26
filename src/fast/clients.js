import { askChatJudge } from './chat-judge-client.js';
import { askGatewayDecision } from './gateway-decision-client.js';
import { askJev } from './jev-client.js';
import { describeFailure } from '../lib/failure.js';

const PRIMARY_FAILURES_BEFORE_SKIP = 3;
// Providers that serve Jev on TypeSafe's System One API (POST <base>/v1/systemone).
const SYSTEM_ONE_PROVIDERS = new Set(['typesafe', 'opencode-zen', 'openrouter']);

/**
 * System One providers (TypeSafe, OpenCode Zen, OpenRouter) answer natively,
 * gateway decision models through the decision API, and any other model through
 * a JSON-mode chat completion.
 */
export function fastClientFor(fast) {
  if (SYSTEM_ONE_PROVIDERS.has(fast.provider)) return askJev;
  return fast.decision ? askGatewayDecision : askChatJudge;
}

/**
 * The fast layer's ask with a backup decision provider. Each step is independent,
 * so a failed step is simply asked again on the backup; after repeated failures
 * the primary is skipped for the rest of the task. `clientFor` exists for tests.
 */
export function askWithBackup({ primary, backup, notify, clientFor = fastClientFor }) {
  const askPrimary = clientFor(primary);
  const askBackup = backup ? clientFor(backup) : null;
  let failures = 0;
  let warned = false;

  return async ({ state, questions, signal }) => {
    if (askBackup && failures >= PRIMARY_FAILURES_BEFORE_SKIP) return askBackup({ ...backup, state, questions, signal });
    try {
      return await askPrimary({ ...primary, state, questions, signal });
    } catch (err) {
      if (!askBackup || err?.name === 'AbortError') throw err;
      failures += 1;
      if (!warned) {
        warned = true;
        notify({ level: 'warning', kind: 'fast-switched', from: `${primary.provider} · ${primary.model}`, to: `${backup.provider} · ${backup.model}`, ...describeFailure(err) });
      }
      return askBackup({ ...backup, state, questions, signal });
    }
  };
}

/**
 * The fast layer's ask, whichever client is behind it. The backup wrapper
 * closes over the settings it was built with while the plain clients take them
 * as arguments, so the settings travel with every call either way: the
 * provider, the model, the endpoint and the key are never lost.
 */
export function createFastAsk(fast, notify) {
  const ask = fast?.fallback?.enabled && fast?.fallback?.apiKey
    ? askWithBackup({ primary: fast, backup: fast.fallback, notify })
    : fastClientFor(fast);
  return (request) => ask({ ...fast, ...request });
}
