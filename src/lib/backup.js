// Settings, API keys and the account sign-ins as one JSON document. Chrome
// deletes an extension's storage when it is removed, so this document is what
// survives a remove-and-reinstall: as a file the user keeps, or in their Google
// Drive (drive-backup.js).

import { mergeSettings, ACCOUNT_PROVIDERS } from './settings.js';
import { credentialOf } from './credentials.js';
import { ACCOUNT_STORAGE_KEYS, migrateLegacyAccounts, storeCredential } from '../providers/account-auth.js';

const FORMAT = 'browser-agent-backup';
const VERSION = 2;

export async function exportBackup() {
  // A ChatGPT sign-in from before the update is still under its old key until
  // something asks for it; the backup must not leave it out.
  await migrateLegacyAccounts();
  const stored = await chrome.storage.local.get(['settings', ...ACCOUNT_STORAGE_KEYS]);
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: mergeSettings(stored.settings),
    accounts: signedInAccounts(stored),
  };
}

/** The credentials of the providers that are signed in. */
function signedInAccounts(stored) {
  const accounts = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const credential = stored[`accountAuth.${provider}`]?.credential ?? null;
    if (!credential) continue;
    accounts[provider] = credential;
  }
  return accounts;
}

/**
 * The accounts a backup file carries, whichever version it is. A version 1 file
 * held only the ChatGPT sign-in, and only when there was one: a null or missing
 * record means the provider was not signed in, and the local one is kept.
 */
export function accountsIn(data) {
  if (Number(data?.version) >= 2) {
    const { accounts } = data;
    // Every version-2 file has an accounts object, empty when nobody signed in.
    if (accounts !== undefined && (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts))) {
      throw new Error('This backup is damaged: its sign-ins cannot be read.');
    }
    return normaliseAccounts(accounts);
  }
  const credential = credentialOf(data?.chatgptAuth);
  return credential ? { chatgpt: credential } : {};
}

/** The accounts of a file, in a fixed order and without the local generation. */
export function normaliseAccounts(accounts = {}) {
  const out = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const credential = credentialOf(accounts[provider]);
    if (credential) out[provider] = credential;
  }
  return out;
}

/** Restores a file from exportBackup; returns the restored settings. */
export async function importBackup(data) {
  if (data?.format !== FORMAT) throw new Error('This file is not a Postora Browser Agent backup.');
  if (!(data.version <= VERSION)) throw new Error(`This backup was made by a newer version of Postora Browser Agent (format ${data.version}).`);
  // Read everything first: a damaged file must leave the local settings alone.
  const accounts = accountsIn(data);
  const values = { settings: mergeSettings(data.settings ?? {}) };
  await chrome.storage.local.set(values);
  await restoreAccounts(accounts);
  return values.settings;
}

/**
 * The sign-ins of the file, per provider. A provider in the file replaces the
 * local record (through its queue, so the generation moves on); a provider that
 * is not in it keeps the local one. There are no tombstones: a backup never
 * signs a provider out.
 */
async function restoreAccounts(accounts) {
  for (const provider of ACCOUNT_PROVIDERS) {
    const credential = accounts[provider];
    if (!credential) continue;
    await storeCredential(provider, credential);
  }
}
