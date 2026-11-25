// Settings, API keys, account sign-ins and sessions as one JSON document. Chrome
// deletes an extension's storage when it is removed, so this document is what
// survives a remove-and-reinstall: as a file the user keeps, or in their Google
// Drive (drive-backup.js).

import { mergeSettings, ACCOUNT_PROVIDERS, COMPATIBLE_PRESETS, FAST_PRESETS } from './settings.js';
import { keyGroup, shareKeys } from './keys.js';
import { credentialOf } from './credentials.js';
import { ACCOUNT_STORAGE_KEYS, migrateLegacyAccounts, storeCredential } from '../providers/account-auth.js';
import { exportSessions, importSessions, validateSessions } from '../sessions/store.js';

const FORMAT = 'browser-agent-backup';
const VERSION = 3;

const trimSlash = (url = '') => String(url).trim().replace(/\/+$/, '');

/**
 * Strips every API key from a merged settings object for a credential-free
 * cloud backup.
 */
export function stripSettingsCredentials(settings) {
  const clean = structuredClone(settings);
  clean.keys = {};
  for (const slot of [
    clean.compatible,
    clean.claude,
    clean.gemini,
    clean.kimi,
    clean.fast,
    clean.fast?.fallback,
    clean.fallback?.compatible,
    clean.fallback?.claude,
    clean.fallback?.gemini,
    clean.fallback?.kimi,
  ]) {
    if (slot && typeof slot === 'object' && 'apiKey' in slot) slot.apiKey = '';
  }
  if (clean.transcription && typeof clean.transcription === 'object') {
    clean.transcription.apiKey = '';
    if (clean.transcription.services && typeof clean.transcription.services === 'object') {
      for (const svc of Object.values(clean.transcription.services)) {
        if (svc && typeof svc === 'object' && 'apiKey' in svc) svc.apiKey = '';
      }
    }
  }
  return clean;
}

function compatibleEndpoint(slot) {
  if (!slot || typeof slot !== 'object') return '';
  if (slot.baseUrl) return trimSlash(slot.baseUrl);
  const presetUrl = COMPATIBLE_PRESETS[slot.preset]?.baseUrl;
  return presetUrl ? trimSlash(presetUrl) : '';
}

function fastEndpoint(slot) {
  if (!slot || typeof slot !== 'object') return '';
  if (slot.baseUrl) return trimSlash(slot.baseUrl);
  const presetUrl = FAST_PRESETS[slot.provider]?.baseUrl;
  return presetUrl ? trimSlash(presetUrl) : '';
}

/**
 * Preserves local API keys when restoring a backup that omitted credentials,
 * pairing a kept local key only when the restored slot points at the same
 * provider and base URL endpoint.
 */
export function preserveLocalKeysOnRestore(restoredRaw, localRaw) {
  const local = mergeSettings(localRaw ?? {});
  const raw = structuredClone(restoredRaw ?? {});
  const merged = mergeSettings(raw);

  // If the incoming backup explicitly carried any key, merge it on top of
  // endpoint-matched local keys so omitted keys are kept while provided keys win.
  const keepCompatibleSlot = (restoredSlot, localSlot, rawSlot) => {
    if (!restoredSlot || !localSlot) return;
    if (rawSlot?.apiKey) return;
    const samePreset = (restoredSlot.preset || 'custom') === (localSlot.preset || 'custom');
    const sameUrl = compatibleEndpoint(restoredSlot) === compatibleEndpoint(localSlot);
    if (samePreset && sameUrl && localSlot.apiKey) {
      restoredSlot.apiKey = localSlot.apiKey;
    } else {
      restoredSlot.apiKey = '';
    }
  };

  const keepFixedEndpointSlot = (restoredSlot, localSlot, rawSlot) => {
    if (!restoredSlot || !localSlot) return;
    if (rawSlot?.apiKey) return;
    if (localSlot.apiKey) restoredSlot.apiKey = localSlot.apiKey;
  };

  const keepFastSlot = (restoredSlot, localSlot, rawSlot) => {
    if (!restoredSlot || !localSlot) return;
    if (rawSlot?.apiKey) return;
    const sameProvider = (restoredSlot.provider || '') === (localSlot.provider || '');
    const sameUrl = fastEndpoint(restoredSlot) === fastEndpoint(localSlot);
    if (sameProvider && sameUrl && localSlot.apiKey) {
      restoredSlot.apiKey = localSlot.apiKey;
    } else {
      restoredSlot.apiKey = '';
    }
  };

  // Start with raw keys from the backup only (do not blindly copy local.keys
  // before checking whether a slot changed its baseUrl).
  merged.keys = { ...(raw.keys ?? {}) };
  for (const slot of [
    merged.compatible,
    merged.fallback?.compatible,
    merged.fast,
    merged.fast?.fallback,
  ]) {
    if (slot) slot.apiKey = '';
  }
  if (raw.compatible?.apiKey) merged.compatible.apiKey = raw.compatible.apiKey;
  if (raw.fallback?.compatible?.apiKey) merged.fallback.compatible.apiKey = raw.fallback.compatible.apiKey;
  if (raw.fast?.apiKey) merged.fast.apiKey = raw.fast.apiKey;
  if (raw.fast?.fallback?.apiKey) merged.fast.fallback.apiKey = raw.fast.fallback.apiKey;

  const mismatchedGroups = new Set();
  for (const [rSlot, lSlot, kind] of [
    [merged.compatible, local.compatible, 'compat'],
    [merged.fallback?.compatible, local.fallback?.compatible, 'compat'],
    [merged.fast, local.fast, 'fast'],
    [merged.fast?.fallback, local.fast?.fallback, 'fast'],
  ]) {
    if (!rSlot || !lSlot) continue;
    const group = keyGroup(kind === 'compat' ? rSlot.preset : rSlot.provider);
    const sameEnd = kind === 'compat'
      ? compatibleEndpoint(rSlot) === compatibleEndpoint(lSlot)
      : fastEndpoint(rSlot) === fastEndpoint(lSlot);
    if (group && !sameEnd) mismatchedGroups.add(group);
  }

  keepCompatibleSlot(merged.compatible, local.compatible, raw.compatible);
  keepCompatibleSlot(merged.fallback?.compatible, local.fallback?.compatible, raw.fallback?.compatible);
  keepFastSlot(merged.fast, local.fast, raw.fast);
  keepFastSlot(merged.fast?.fallback, local.fast?.fallback, raw.fast?.fallback);
  keepFixedEndpointSlot(merged.claude, local.claude, raw.claude);
  keepFixedEndpointSlot(merged.fallback?.claude, local.fallback?.claude, raw.fallback?.claude);
  keepFixedEndpointSlot(merged.gemini, local.gemini, raw.gemini);
  keepFixedEndpointSlot(merged.fallback?.gemini, local.fallback?.gemini, raw.fallback?.gemini);
  keepFixedEndpointSlot(merged.kimi, local.kimi, raw.kimi);
  keepFixedEndpointSlot(merged.fallback?.kimi, local.fallback?.kimi, raw.fallback?.kimi);

  if (!raw.transcription?.apiKey && local.transcription?.apiKey) {
    const sameProvider = (merged.transcription?.provider || '') === (local.transcription?.provider || '');
    const sameEndpoint = trimSlash(merged.transcription?.endpoint) === trimSlash(local.transcription?.endpoint);
    if (sameProvider && sameEndpoint) {
      merged.transcription.apiKey = local.transcription.apiKey;
    }
  }

  if (mismatchedGroups.size) {
    for (const [rSlot, kind] of [
      [merged.compatible, 'compat'],
      [merged.fallback?.compatible, 'compat'],
      [merged.fast, 'fast'],
      [merged.fast?.fallback, 'fast'],
    ]) {
      if (!rSlot) continue;
      const group = keyGroup(kind === 'compat' ? rSlot.preset : rSlot.provider);
      if (group && mismatchedGroups.has(group)) {
        rSlot.apiKey = '';
      }
    }
  }

  // Also preserve unreferenced shared provider keys from `local.keys` only for
  // groups whose active slot did not mismatch its endpoint.
  for (const [group, key] of Object.entries(local.keys ?? {})) {
    if (key && !merged.keys[group] && !mismatchedGroups.has(group)) {
      merged.keys[group] = key;
    }
  }

  return shareKeys(merged);
}

/**
 * The backup document: settings, keys, account sign-ins and, when the user
 * wants them there, the conversations.
 *
 * `includeSessions` is off where the backup leaves this computer on its own:
 * a conversation is the user's own work, and it is not uploaded unless the user
 * said so. A file the user downloads is theirs to keep, so it holds them.
 * `includeCredentials` controls whether API keys and account sign-in tokens are
 * included (true for manual local downloads; opt-in for Google Drive backups).
 */
export async function exportBackup({ includeSessions = true, includeCredentials = true } = {}) {
  // A ChatGPT sign-in from before the update is still under its old key until
  // something asks for it; the backup must not leave it out.
  await migrateLegacyAccounts();
  const stored = await chrome.storage.local.get(['settings', ...ACCOUNT_STORAGE_KEYS]);
  const merged = mergeSettings(stored.settings);
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: includeCredentials ? merged : stripSettingsCredentials(merged),
    accounts: includeCredentials ? signedInAccounts(stored) : {},
    sessions: includeSessions ? await exportSessions() : [],
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
export async function importBackup(data, { preserveLocalCredentials = false } = {}) {
  if (data?.format !== FORMAT) throw new Error('This file is not a Postora Browser Agent backup.');
  if (!(data.version <= VERSION)) throw new Error(`This backup was made by a newer version of Postora Browser Agent (format ${data.version}).`);
  // Read everything first: a damaged file must leave the local settings alone.
  const accounts = accountsIn(data);
  const sessions = Number(data.version) >= 3 ? validateSessions(data.sessions) : [];
  let nextSettings;
  if (preserveLocalCredentials) {
    const { settings: localSettings } = await chrome.storage.local.get('settings');
    nextSettings = preserveLocalKeysOnRestore(data.settings ?? {}, localSettings);
  } else {
    nextSettings = mergeSettings(data.settings ?? {});
  }
  const values = { settings: nextSettings };
  await chrome.storage.local.set(values);
  await restoreAccounts(accounts);
  await importSessions(sessions);
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
