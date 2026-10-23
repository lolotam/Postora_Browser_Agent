// What the side panel shows about the account sign-ins, without the DOM: the
// words and the flags each provider's section is drawn from. The panel asks
// the worker for the state and draws what this says.

import { t } from './i18n.js';
import { ACCOUNT_PROVIDERS, PROVIDER_LABELS } from '../lib/settings.js';

/** The phases of a sign-in that is still waiting for the user. */
export const RUNNING_PHASES = new Set(['starting', 'awaiting-code', 'authorizing']);

/**
 * The wording of a sign-in failure, by the stable code the worker sent. The
 * English text of the worker is only the fallback, used when the panel has no
 * wording of its own for the code.
 */
export function authMessage(code, fallback = '') {
  if (!code) return fallback;
  const key = `auth.error.${code}`;
  const text = t(key);
  return text === key ? fallback : text;
}

/**
 * What a provider's section shows, given the state the worker reports, the
 * attempt the panel was waiting for, and the message it showed last.
 */
export function authView(provider, state, attempt = null, note = '') {
  const connected = Boolean(state?.connected);
  const login = state?.login ?? null;
  const running = Boolean(login) && RUNNING_PHASES.has(login.phase);
  const who = state?.email || PROVIDER_LABELS[provider];
  const status = connected
    ? t('auth.connected', { who: `${who}${state?.planType ? ` — ${state.planType}` : ''}` })
    : t('auth.disconnected');
  // A signed-in provider has nothing to complain about: an old failure of an
  // earlier sign-in is not shown next to "Connected".
  if (connected) {
    return {
      status, connected, message: '', attempt: null, running: false,
      deviceCode: null, verificationUrl: null, needsCode: false,
    };
  }
  let message = note;
  let nextAttempt = null;
  if (!login && attempt) {
    // The worker lost the attempt the panel was waiting for.
    message = t('auth.interrupted');
  } else if (login) {
    nextAttempt = running ? login.id : null;
    if (login.code && login.phase !== 'signed-in') message = authMessage(login.code, login.message);
  }
  return {
    status,
    connected,
    message,
    attempt: nextAttempt,
    running,
    deviceCode: running ? (login.deviceCode ?? null) : null,
    verificationUrl: login?.verificationUrl ?? null,
    needsCode: Boolean(login?.needsCode),
  };
}

/**
 * A provider's known state after a sign-in event from the worker, so a redraw
 * between two auth-status answers draws the sign-in as it is now, not as an
 * attempt the worker lost.
 */
export function withLoginEvent(state, event) {
  const known = state ?? { connected: false, provider: event.provider };
  const login = known.login?.id === event.attemptId ? known.login : { id: event.attemptId, provider: event.provider };
  switch (event.type) {
    case 'auth-event':
      return {
        ...known,
        login: {
          ...login,
          phase: 'authorizing',
          needsCode: false,
          deviceCode: event.userCode ?? login.deviceCode ?? null,
          verificationUrl: event.verificationUrl ?? login.verificationUrl ?? null,
        },
      };
    case 'auth-prompt':
      return { ...known, login: { ...login, phase: 'awaiting-code', needsCode: true } };
    case 'auth-error':
      return { ...known, login: { ...login, phase: 'failed', needsCode: false, code: event.code, message: event.message } };
    default:
      return known;
  }
}

/**
 * What the backup frame shows: the note that it uses the sign-in above, or the
 * sign-in of its own provider, when the main frame does not show that one.
 */
export function backupAuthView({ main, backup, claudeAuth = 'account' }) {
  const account = ACCOUNT_PROVIDERS.includes(backup);
  // A Claude slot that pays with an API key needs no sign-in at all.
  const needsSignIn = account && !(backup === 'claude' && claudeAuth === 'apiKey');
  const shared = needsSignIn && backup === main;
  return { note: shared, signIn: needsSignIn && !shared ? backup : null };
}

/** The providers whose credential changed in a batch of storage changes. */
export function changedProviders(changes) {
  return Object.keys(changes ?? {})
    .filter((key) => key.startsWith('accountAuth.'))
    .map((key) => key.slice('accountAuth.'.length));
}
