// The ChatGPT sign-in of the extension: the auth.json import, and the adapter
// that hands chatgpt.js a usable credential. The sign-in itself runs through
// pi-ai's OAuth flow in the service worker (see background/account-login.js).

import { chatgptIdentity } from '../lib/jwt.js';
import { getValidCredential, storeCredential } from './account-auth.js';

/** Accepts the contents of ~/.codex/auth.json produced by `codex login`. */
export async function importCodexAuthJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  const tokens = parsed.tokens ?? parsed;
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('auth.json has no ChatGPT tokens. Run `codex login` with "Sign in with ChatGPT" first.');
  }
  const fromId = chatgptIdentity(tokens.id_token) ?? {};
  const fromAccess = chatgptIdentity(tokens.access_token) ?? {};
  // The expiry the token carries, so a stale file is refreshed on first use.
  await storeCredential('chatgpt', {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: fromAccess.expiresAt ?? Date.now(),
    accountId: tokens.account_id ?? fromId.accountId ?? fromAccess.accountId ?? null,
    email: fromId.email ?? fromAccess.email ?? null,
    planType: fromId.planType ?? fromAccess.planType ?? null,
    idToken: tokens.id_token ?? null,
  });
  return true;
}

/** The ChatGPT credential in the shape chatgpt.js expects. */
export async function getValidAuth({ forceRefresh = false } = {}) {
  const credential = await getValidCredential('chatgpt', { forceRefresh });
  return { accessToken: credential.access, accountId: credential.accountId ?? null };
}
