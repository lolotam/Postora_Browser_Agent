// Sign-in for the account providers. The pi-ai OAuth flows run here, in the
// service worker, and the panel is told what it needs to do. A flow's
// authorization URL can carry a PKCE verifier, so the worker opens it and the
// panel never sees it.

import { ACCOUNT_ERROR_CODES, accountFlow, beginAccountAttempt, cancelAccountAttempt, storeCredential } from '../providers/account-auth.js';
import { ACCOUNT_PROVIDERS } from '../lib/settings.js';

const KEEP_ALIVE_MS = 20000;
// A sign-in nobody finishes stops here, so its keep-alive does not run forever.
// The device-code flows end sooner, when their code expires.
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const SIGN_IN_FAILED = 'The sign-in failed. Please try again.';
const SIGN_IN_CANCELLED = 'The sign-in was cancelled.';
const SIGN_IN_SUPERSEDED = 'The sign-in was replaced by another one. Please try again.';
const SIGN_IN_TIMED_OUT = 'The sign-in timed out after 15 minutes. Please start again.';
const DEVICE_CODE_DISABLED = 'Device-code sign-in is not enabled. In ChatGPT → Settings → Security, enable device code authorization for Codex, or import auth.json instead.';

/**
 * The fixed sign-in failures, by the stable code the panel translates. The
 * English text is the fallback the panel shows when it has no wording for the
 * code; the upstream text never reaches the panel.
 */
export const SIGN_IN_FAILURES = {
  failed: SIGN_IN_FAILED,
  cancelled: SIGN_IN_CANCELLED,
  superseded: SIGN_IN_SUPERSEDED,
  'timed-out': SIGN_IN_TIMED_OUT,
  'device-code-disabled': DEVICE_CODE_DISABLED,
};
// The login method each provider is asked for, by the option id pi-ai uses.
const SELECT_OPTION = { chatgpt: 'device_code', claude: 'copy_code' };
// The phases a sign-in is in while it still waits for the user.
const RUNNING_PHASES = new Set(['starting', 'awaiting-code', 'authorizing']);

const attempts = new Map(); // provider → its last attempt

/** Keeps the service worker alive while `task` runs: a pending fetch is not activity. */
export async function withKeepAlive(task) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  try {
    return await task();
  } finally {
    clearInterval(keepAlive);
  }
}

/**
 * Starts a sign-in for a provider. It resolves with what the panel shows (the
 * device code, or nothing when a tab was opened) and keeps running until the
 * user finishes or gives up.
 */
export async function startAccountLogin(provider, { post }) {
  if (!ACCOUNT_PROVIDERS.includes(provider)) throw new Error(`Unknown account provider ${provider}.`);
  const attempt = newAttempt(provider);
  // A new sign-in replaces the one running for this provider.
  const running = attempts.get(provider);
  if (running && RUNNING_PHASES.has(running.phase)) {
    running.superseded = true;
    running.controller.abort();
    // Its auth-start is answered now, not when its flow notices the abort.
    running.first.reject(signInError(SIGN_IN_SUPERSEDED, 'superseded'));
  }
  attempts.set(provider, attempt);
  await beginAccountAttempt(provider, attempt.id);
  const { first } = attempt;
  // The worker dies while it waits, and the sign-in would die with it.
  withKeepAlive(() => runAttempt(attempt, { post, first })).catch(() => {});
  return first.promise;
}

/** The attempt a sign-in starts with. */
function newAttempt(provider) {
  return {
    id: crypto.randomUUID(),
    provider,
    phase: 'starting',
    deviceCode: null,
    verificationUrl: null,
    needsCode: false,
    message: null,
    code: null,
    cancelled: false,
    superseded: false,
    timedOut: false,
    controller: new AbortController(),
    resolveInput: null,
    first: deferred(), // what auth-start answers: the device code, or that a tab opened
  };
}

async function runAttempt(attempt, { post, first }) {
  const deadline = setTimeout(() => {
    attempt.timedOut = true;
    attempt.controller.abort();
  }, LOGIN_TIMEOUT_MS);
  try {
    const credential = await accountFlow(attempt.provider).login(interactionFor(attempt, { post, first }));
    const stored = await storeCredential(attempt.provider, credential, { attemptId: attempt.id });
    if (!stored) {
      failAttempt(attempt, {
        post,
        first,
        ...(attempt.cancelled
          ? { message: SIGN_IN_CANCELLED, code: 'cancelled' }
          : { message: SIGN_IN_SUPERSEDED, code: 'superseded' }),
      });
      return;
    }
    attempt.phase = 'signed-in';
    // A flow that finished before showing anything still answers auth-start.
    first.resolve({ userCode: null, verificationUrl: null });
    post({ type: 'auth-success', provider: attempt.provider });
  } catch (error) {
    failAttempt(attempt, { post, first, ...safeFailure(attempt, error) });
  } finally {
    clearTimeout(deadline);
  }
}

/** What pi-ai's flow may do, until the attempt is cancelled: after that it may not ask or show anything. */
function interactionFor(attempt, { post, first }) {
  const { signal } = attempt.controller;
  return {
    signal,
    prompt: async (prompt) => {
      if (signal.aborted) throw new Error('Login cancelled');
      return askAttempt(attempt, prompt, { post, first });
    },
    notify: (event) => {
      if (!signal.aborted) onFlowEvent(attempt, event, { post, first });
    },
  };
}

async function askAttempt(attempt, prompt, { post, first }) {
  if (prompt.type === 'select') return selectAnswer(attempt.provider, prompt);
  if (prompt.type !== 'manual_code' && prompt.type !== 'text') {
    throw new Error(`The sign-in asked for something this extension cannot show (${prompt.type}).`);
  }
  attempt.phase = 'awaiting-code';
  attempt.needsCode = true;
  post({ type: 'auth-prompt', provider: attempt.provider, attemptId: attempt.id, kind: prompt.type });
  first.resolve({ userCode: null, verificationUrl: null });
  return waitForInput(attempt);
}

/** The login method this extension picks for a provider, by the option id pi-ai uses. */
function selectAnswer(provider, prompt) {
  const wanted = SELECT_OPTION[provider];
  const option = prompt.options?.find((entry) => entry.id === wanted);
  if (!option) throw new Error(`This sign-in has no ${wanted} method.`);
  return option.id;
}

/** Waits for the code the user pastes, until the sign-in is cancelled. */
function waitForInput(attempt) {
  const { signal } = attempt.controller;
  return new Promise((resolve, reject) => {
    // An abort that came first would never fire the listener below.
    if (signal.aborted) {
      reject(new Error('Login cancelled'));
      return;
    }
    attempt.resolveInput = resolve;
    signal.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true });
  });
}

function onFlowEvent(attempt, event, { post, first }) {
  if (event.type === 'auth_url') return openAuthorization(attempt, event, { post, first });
  if (event.type === 'device_code') return showDeviceCode(attempt, event, { post, first });
  if (event.type === 'progress') attempt.phase = 'authorizing';
}

function openAuthorization(attempt, event, { post, first }) {
  attempt.phase = 'authorizing';
  // The URL carries the PKCE verifier, so the worker opens it and the panel
  // never sees it.
  openTab(event.url);
  post({ type: 'auth-event', provider: attempt.provider, attemptId: attempt.id, kind: 'opened' });
  first.resolve({ userCode: null, verificationUrl: null });
}

function showDeviceCode(attempt, event, { post, first }) {
  attempt.phase = 'authorizing';
  attempt.deviceCode = event.userCode;
  attempt.verificationUrl = event.verificationUri;
  openTab(event.verificationUri);
  post({
    type: 'auth-event', provider: attempt.provider, attemptId: attempt.id,
    kind: 'device_code', userCode: event.userCode, verificationUrl: event.verificationUri,
  });
  first.resolve({ userCode: event.userCode, verificationUrl: event.verificationUri });
}

function openTab(url) {
  chrome.tabs.create({ url, active: true }).catch(() => {});
}

/**
 * The attempt of a provider, without anything secret in it. It stays after the
 * sign-in ended, so the panel can tell a finished sign-in from one the worker
 * lost; only a provider that never signed in has no attempt at all.
 */
export function accountLoginState(provider) {
  const attempt = attempts.get(provider);
  if (!attempt) return null;
  return {
    id: attempt.id,
    provider: attempt.provider,
    phase: attempt.phase,
    deviceCode: attempt.deviceCode,
    verificationUrl: attempt.verificationUrl,
    needsCode: attempt.needsCode,
    message: attempt.message,
    code: attempt.code,
  };
}

/** Gives the running sign-in the code the user pasted. */
export function submitAccountInput(provider, attemptId, value) {
  const attempt = attempts.get(provider);
  if (!attempt || attempt.id !== attemptId) throw new Error('That sign-in is no longer running.');
  const resolve = attempt.resolveInput;
  if (!resolve) throw new Error('That sign-in is not asking for a code.');
  attempt.resolveInput = null;
  attempt.needsCode = false;
  resolve(String(value ?? ''));
  return null;
}

/** Stops the sign-in of a provider. */
export async function cancelAccountLogin(provider) {
  const attempt = attempts.get(provider);
  if (!attempt) return null;
  attempt.cancelled = true;
  attempt.needsCode = false;
  attempt.controller.abort();
  attempt.first.reject(signInError(SIGN_IN_CANCELLED, 'cancelled'));
  cancelAccountAttempt(provider);
  return null;
}

function failAttempt(attempt, { post, first, message, code }) {
  attempt.phase = attempt.cancelled ? 'cancelled' : 'failed';
  attempt.message = message;
  // The stable code, so the panel can show its own wording for it.
  attempt.code = code;
  // auth-start is always answered, even for a sign-in another one replaced
  // (rejecting an answered one does nothing).
  first.reject(signInError(message, code));
  if (attempt.superseded) return;
  post({ type: 'auth-error', provider: attempt.provider, attemptId: attempt.id, message, code });
}

/**
 * The message and the stable code of a failed sign-in. The upstream text is
 * never shown; the panel translates the code.
 */
function safeFailure(attempt, error) {
  if (attempt.timedOut) return { message: SIGN_IN_TIMED_OUT, code: 'timed-out' };
  if (attempt.superseded) return { message: SIGN_IN_SUPERSEDED, code: 'superseded' };
  const text = String(error?.message ?? error ?? '');
  if (error?.name === 'AbortError' || /cancelled/i.test(text)) return { message: SIGN_IN_CANCELLED, code: 'cancelled' };
  // pi-ai's Codex flow, when the account has not turned device-code sign-in on.
  if (/device code login is not enabled/i.test(text)) return { message: DEVICE_CODE_DISABLED, code: 'device-code-disabled' };
  // The credential store's own fixed problems: an expired sign-in, a refresh
  // that failed, a token that came back incomplete.
  if (error?.code && ACCOUNT_ERROR_CODES[error.code]) return { message: error.message, code: error.code };
  return { message: SIGN_IN_FAILED, code: 'failed' };
}

/**
 * A promise the caller resolves later.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a failure nobody waits for must not warn
  return { promise, resolve, reject };
}

/** An error that carries the stable code of the failure, so the panel can translate it. */
function signInError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
