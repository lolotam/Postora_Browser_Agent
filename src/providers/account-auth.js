// One OAuth credential per account provider (ChatGPT, Claude, Grok), each in
// its own chrome.storage.local key, so two providers never overwrite each
// other. Every write for a provider runs in one queue, and a refresh or login
// result is stored only if the record it started from is still the current
// one: a late result never undoes a sign-out or a newer sign-in.

import { anthropicOAuth, openaiCodexOAuth, xaiOAuth } from '../vendor/pi-oauth.js';
import { chatgptIdentity } from '../lib/jwt.js';

/** The providers this extension can sign in to, and the pi-ai flow each uses. */
export const ACCOUNT_PROVIDERS = {
  chatgpt: { flow: 'openaiCodexOAuth', label: 'ChatGPT' },
  claude: { flow: 'anthropicOAuth', label: 'Claude' },
  grok: { flow: 'xaiOAuth', label: 'Grok' },
};

/** The storage key of every provider's credential record. */
export const ACCOUNT_STORAGE_KEYS = Object.keys(ACCOUNT_PROVIDERS).map((provider) => `accountAuth.${provider}`);

const LEGACY_KEY = 'chatgptAuth';
// A token is refreshed when less than this is left, so pi-ai's own five-minute
// margin never comes into play.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30 * 1000;
// The OAuth error codes that mean the token is dead for good.
const DEAD_TOKEN_CODES = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token'];
const DEAD_TOKEN_STATUSES = [400, 401, 403];

const REFRESH_FAILED = 'The sign-in could not be refreshed. Please try again.';
const SIGN_IN_EXPIRED = 'The sign-in expired. Please sign in again.';
const SIGN_IN_INCOMPLETE = 'The sign-in is incomplete. Please sign in again.';

/** A sign-in problem the panel can show; `retryable` says whether trying again can help. */
export class AccountAuthError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'AccountAuthError';
    this.retryable = retryable;
  }
}

let flows = { anthropicOAuth, openaiCodexOAuth, xaiOAuth };

/** Replaces OAuth flows, for tests. */
export function setAccountFlows(replacement) {
  flows = { ...flows, ...replacement };
}

/** The pi-ai OAuth flow of a provider. */
export function accountFlow(provider) {
  const name = knownProvider(provider).flow;
  const flow = flows[name];
  if (!flow) throw new AccountAuthError(`Unknown account provider ${provider}.`, { retryable: false });
  return flow;
}

/** The provider must be one this extension knows, or a key of junk would be written. */
function knownProvider(provider) {
  const known = ACCOUNT_PROVIDERS[provider];
  if (!known) throw new AccountAuthError(`Unknown account provider ${provider}.`, { retryable: false });
  return known;
}

// One write at a time per provider, so a read-modify-write is never interleaved.
const queues = new Map();
// The refresh that is running for a provider, so a second caller waits for it.
const refreshes = new Map();
// The login attempt that may still store a credential, and the record it began from.
const attempts = new Map();

/** Runs `task` after every earlier write for the same provider. */
function enqueue(provider, task) {
  const previous = queues.get(provider) ?? Promise.resolve();
  const run = previous.then(task);
  queues.set(provider, run.catch(() => undefined));
  return run;
}

async function readRecord(provider) {
  const key = `accountAuth.${provider}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

async function writeRecord(provider, generation, credential) {
  await chrome.storage.local.set({ [`accountAuth.${provider}`]: { generation, credential } });
}

/**
 * Moves the ChatGPT record of older versions into the per-provider key. It
 * runs inside the ChatGPT queue and does nothing once the new record is there.
 */
async function migrateLegacyChatgpt() {
  const legacy = await chrome.storage.local.get(LEGACY_KEY);
  const old = legacy[LEGACY_KEY];
  if (!old) return;
  const record = await readRecord('chatgpt');
  // A signed-out record ({ credential: null }) is no reason to drop the old sign-in.
  if (!record?.credential && old.accessToken) {
    await writeRecord('chatgpt', (record?.generation ?? 0) + 1, {
      type: 'oauth',
      access: old.accessToken,
      refresh: old.refreshToken,
      expires: old.expiresAt,
      accountId: old.accountId ?? null,
      email: old.email ?? null,
      planType: old.planType ?? null,
      idToken: old.idToken ?? null,
    });
  }
  await chrome.storage.local.remove(LEGACY_KEY);
}

/** Runs the legacy migration once, inside the provider's own queue. */
async function ensureMigrated(provider) {
  if (provider !== 'chatgpt') return;
  await enqueue(provider, migrateLegacyChatgpt);
}

/**
 * Registers the login attempt that may store a credential for this provider.
 * The record's generation now is what a later store is checked against, so a
 * sign-out or a newer sign-in in between drops the result.
 */
export async function beginAccountAttempt(provider, attemptId) {
  await ensureMigrated(provider);
  return enqueue(provider, async () => {
    const record = await readRecord(provider);
    attempts.set(provider, { id: attemptId, generation: record?.generation ?? 0 });
    return attemptId;
  });
}

/** Drops the provider's running attempt, so its result can never be stored. */
export function cancelAccountAttempt(provider) {
  attempts.delete(provider);
}

/** A credential with the tokens a request needs. */
function hasTokens(credential) {
  return typeof credential?.access === 'string' && credential.access.length > 0
    && typeof credential.refresh === 'string' && credential.refresh.length > 0;
}

/** A credential that can be used right now: tokens, and an expiry in the future. */
function isUsable(credential) {
  return hasTokens(credential) && Number.isFinite(credential.expires) && credential.expires > Date.now();
}

/** A credential with more than the refresh margin left is good enough. */
function isFresh(credential) {
  return Number.isFinite(credential.expires) && credential.expires - Date.now() > REFRESH_MARGIN_MS;
}

/** The stored credential of a provider, or null. Never refreshes it. */
export async function readCredential(provider) {
  await ensureMigrated(provider);
  return (await readRecord(provider))?.credential ?? null;
}

/**
 * A credential that is good to use now, refreshed when it is close to expiry.
 * `forceRefresh` refreshes even a fresh token, for when the provider rejected it.
 */
export async function getValidCredential(provider, { forceRefresh = false, signal = null } = {}) {
  await ensureMigrated(provider);
  const record = await readRecord(provider);
  const credential = record?.credential ?? null;
  if (!credential) throw new AccountAuthError(notConnected(provider), { retryable: false });
  if (!forceRefresh && isFresh(credential)) return credential;
  try {
    return await startRefresh(provider, record, { signal });
  } catch (error) {
    // An early refresh that failed for a passing reason leaves a token that
    // still works for a few minutes; the next call tries again.
    if (!forceRefresh && error.retryable && isUsable(credential)) return credential;
    throw error;
  }
}

/** One refresh at a time per provider: a second caller joins the one running. */
function startRefresh(provider, record, { signal }) {
  const running = refreshes.get(provider);
  if (running) return running;
  const run = refreshCredential(provider, record, { signal }).finally(() => refreshes.delete(provider));
  refreshes.set(provider, run);
  return run;
}

async function refreshCredential(provider, record, { signal }) {
  const flow = accountFlow(provider);
  let refreshed;
  try {
    refreshed = await flow.refresh(record.credential, refreshSignal(signal));
  } catch (error) {
    throw await refreshError(provider, record, error);
  }
  if (!isUsable(refreshed)) {
    // pi-ai's Anthropic refresh turns an HTTP 200 with an empty body into
    // undefined tokens; the old record stays and the next try may work.
    throw new AccountAuthError(REFRESH_FAILED, { retryable: true });
  }
  return storeRefreshed(provider, record, refreshed);
}

/** Stores a refreshed credential, if the record it belongs to is still the current one. */
function storeRefreshed(provider, record, refreshed) {
  return enqueue(provider, async () => {
    const current = await readRecord(provider);
    if (!sameRecord(current, record)) {
      // A sign-out or a newer sign-in happened while the refresh was running.
      const latest = current?.credential ?? null;
      if (latest && isUsable(latest)) return latest;
      throw new AccountAuthError(notConnected(provider), { retryable: false });
    }
    // pi-ai returns only the tokens; what the record knew besides (email, plan,
    // account id) is kept unless the refresh says otherwise.
    const merged = { ...current.credential, ...withoutUndefined(refreshed) };
    // The rotated refresh token is written before the new credential is handed
    // out: losing it signs the user out.
    await writeRecord(provider, current.generation, merged);
    return merged;
  });
}

/**
 * The error a failed refresh reports. A confirmed OAuth rejection signs the
 * account out; anything else keeps the record, because the token may still work.
 */
async function refreshError(provider, record, error) {
  if (!isDeadToken(error)) return new AccountAuthError(REFRESH_FAILED, { retryable: true });
  return enqueue(provider, async () => {
    const current = await readRecord(provider);
    if (sameRecord(current, record)) await writeRecord(provider, current.generation, null);
    return new AccountAuthError(SIGN_IN_EXPIRED, { retryable: false });
  });
}

/** True when pi-ai's error is a confirmed OAuth rejection. */
function isDeadToken(error) {
  const text = String(error?.message ?? error ?? '');
  if (!DEAD_TOKEN_CODES.some((code) => text.includes(code))) return false;
  const status = statusIn(text);
  return status !== null && DEAD_TOKEN_STATUSES.includes(status);
}

/** The HTTP status in pi-ai's error text, which carries no status of its own. */
function statusIn(text) {
  const match = text.match(/\bHTTP\s+(\d{3})\b/i) ?? text.match(/\bstatus[=:]\s*(\d{3})\b/i) ?? text.match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

/** The signal a refresh runs under: the caller's, a timeout, or both. */
function refreshSignal(signal) {
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** True when the stored record is still the one a refresh started from. */
function sameRecord(current, started) {
  return Boolean(current)
    && current.generation === started.generation
    && current.credential?.refresh === started.credential?.refresh;
}

/** What the panel shows about a provider: signed in, and who. */
export async function accountStatus(provider) {
  await ensureMigrated(provider);
  const credential = (await readRecord(provider))?.credential ?? null;
  if (!credential) return { connected: false };
  const identity = identityOf(provider, credential);
  return {
    connected: true,
    email: identity.email,
    planType: identity.planType,
    accountId: credential.accountId ?? null,
    expires: credential.expires ?? null,
  };
}

/** The email and plan of a credential: what it carries, or what its token says. */
function identityOf(provider, credential) {
  if (credential.email || credential.planType) {
    return { email: credential.email ?? null, planType: credential.planType ?? null };
  }
  if (provider !== 'chatgpt') return { email: null, planType: null };
  const claims = chatgptIdentity(credential.access);
  return { email: claims?.email ?? null, planType: claims?.planType ?? null };
}

/** Signs a provider out and drops any login still running for it. */
export async function signOut(provider) {
  knownProvider(provider);
  cancelAccountAttempt(provider);
  await ensureMigrated(provider);
  return enqueue(provider, async () => {
    const record = await readRecord(provider);
    // The record stays, with a higher generation, so a refresh that is still
    // running cannot put the account back.
    await writeRecord(provider, (record?.generation ?? 0) + 1, null);
    return null;
  });
}

/**
 * Stores a credential for a provider.
 *
 * `attemptId` is the id of the login attempt that produced it: the store
 * happens only while that attempt is still the provider's current one and the
 * record has not changed since it started. Without an attempt id the store
 * replaces whatever is there — the path an auth.json import takes — and drops
 * any login still running for the provider.
 */
export async function storeCredential(provider, credential, { attemptId = null } = {}) {
  knownProvider(provider);
  if (!attemptId) cancelAccountAttempt(provider);
  await ensureMigrated(provider);
  return enqueue(provider, async () => {
    const record = await readRecord(provider);
    if (attemptId && !mayStore(provider, attemptId, record)) return null;
    if (!hasTokens(credential)) throw new AccountAuthError(SIGN_IN_INCOMPLETE, { retryable: false });
    // A login must bring a usable token; an imported one may be stale and is
    // refreshed on first use.
    if (attemptId && !isUsable(credential)) throw new AccountAuthError(SIGN_IN_INCOMPLETE, { retryable: true });
    await writeRecord(provider, (record?.generation ?? 0) + 1, credential);
    return credential;
  });
}

/** True while the login attempt may still store its result. */
function mayStore(provider, attemptId, record) {
  const attempt = attempts.get(provider);
  if (!attempt || attempt.id !== attemptId) return false;
  return (record?.generation ?? 0) === attempt.generation;
}

function notConnected(provider) {
  return `${ACCOUNT_PROVIDERS[provider]?.label ?? 'The account'} is not connected. Open settings and sign in.`;
}
