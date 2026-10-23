// The credential shapes a stored record can have. The current one is pi-ai's
// OAuth credential; the older one is the ChatGPT record the extension kept
// before the per-provider keys, which still turns up in backups of version 1.
//
// This module holds no OAuth code and no token, so the panel may use it.

/**
 * The credential of the ChatGPT record the extension kept before the
 * per-provider keys: the same tokens, under the names they had then.
 */
export function legacyCredential(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.accessToken !== 'string' || !record.accessToken) return null;
  return {
    type: 'oauth',
    access: record.accessToken,
    refresh: record.refreshToken,
    expires: record.expiresAt,
    accountId: record.accountId ?? null,
    email: record.email ?? null,
    planType: record.planType ?? null,
    idToken: record.idToken ?? null,
  };
}

/**
 * The credential of a stored record, whichever shape it has: the current one,
 * or the ChatGPT record of the older versions. The local generation is not
 * part of the credential and is left out.
 */
export function credentialOf(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.access === 'string' && record.access && typeof record.refresh === 'string' && record.refresh) {
    const { generation, ...rest } = record;
    return rest;
  }
  return legacyCredential(record);
}
