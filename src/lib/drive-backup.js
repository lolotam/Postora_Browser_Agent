// The settings backup kept in the user's own Google Drive, in the hidden
// appDataFolder that only this OAuth client can see. Chrome deletes an extension's
// storage when it is removed; this copy is what comes back after a reinstall and
// a Google sign-in. It is a backup, not sync: each change uploads this computer's
// settings, and a restore is automatic only on a fresh install.

import { accountsIn, exportBackup, importBackup, normaliseAccounts } from './backup.js';
import { googleAccessToken } from './google-account.js';
import { mergeSettings } from './settings.js';

const FILE_NAME = 'browser-agent-backup.json';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const STATE_KEY = 'driveBackup'; // { fileId, at, hash, error }

async function drive(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const error = new Error(`Google Drive: ${body.error?.message ?? `HTTP ${res.status}`}`);
  error.status = res.status;
  throw error;
}

export async function findBackupFile(token) {
  const query = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${FILE_NAME}'`, fields: 'files(id,modifiedTime)' });
  const { files = [] } = await (await drive(token, `${FILES}?${query}`)).json();
  return files[0] ?? null;
}

async function readBackupFile(token, id) {
  return (await drive(token, `${FILES}/${id}?alt=media`)).json();
}

/** Writes the backup into the file `id`, creating the file when there is none (or it was removed); returns its id. */
async function writeBackupFile(token, data, id) {
  const fileId = id ?? (await (await drive(token, FILES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }),
  })).json()).id;
  try {
    await drive(token, `${UPLOAD}/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } catch (err) {
    if (err.status === 404 && id) return writeBackupFile(token, data, null);
    // Metadata creation already succeeded. Retain that ID if its first media
    // upload fails, so retry updates it instead of leaving empty duplicates.
    if (!id) err.backupFileId = fileId;
    throw err;
  }
  return fileId;
}

/**
 * Settings and the signed-in accounts, without the export time, so unchanged
 * settings hash the same. The local generation is left out: it moves on every
 * sign-in, while the credential itself is what a refresh changes.
 */
async function backupHash(data) {
  const bytes = new TextEncoder().encode(JSON.stringify([data.settings, normaliseAccounts(data.accounts)]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function driveBackupState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] ?? {};
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

// A manual backup, a change-triggered one and a restore must not overlap: an older
// upload finishing last would overwrite newer settings in Drive, and two first
// uploads would create two files.
let queue = Promise.resolve();
function serial(operation) {
  const run = queue.then(operation);
  queue = run.catch(() => {});
  return run;
}

/**
 * Uploads the current settings unless Drive already has them. Manual backups
 * force a real write even when unchanged. A failure is kept
 * in the state (shown in the account menu) rather than thrown, since this runs
 * on its own after every settings change.
 */
export function backUpToDrive({ getToken = googleAccessToken, force = false } = {}) {
  return serial(() => upload(getToken, force));
}

async function upload(getToken, force = false) {
  const data = await exportBackup();
  const hash = await backupHash(data);
  const state = await driveBackupState();
  if (!force && state.hash === hash && !state.error) return state;
  try {
    const token = await getToken();
    const fileId = await writeBackupFile(token, data, state.fileId ?? (await findBackupFile(token))?.id);
    return saveState({ fileId, at: Date.now(), hash, error: null });
  } catch (err) {
    return saveState({ ...state, ...(err.backupFileId ? { fileId: err.backupFileId } : {}), error: err.message });
  }
}

/**
 * True when this install has nothing a restore would overwrite: no account
 * sign-in, no stored key of any provider, and no model chosen in any slot.
 */
export function isFreshSetup({ settings, accounts }) {
  const signedIn = Object.values(accounts ?? {}).some(Boolean);
  // Any key of any provider is existing state, the Anthropic one included.
  const storedKeys = Object.values(settings.keys ?? {}).some(Boolean);
  const slotKeys = [
    settings.compatible, settings.fallback?.compatible, settings.fast, settings.fast?.fallback,
    settings.claude, settings.fallback?.claude,
    settings.gemini, settings.fallback?.gemini, settings.kimi, settings.fallback?.kimi,
  ].map((slot) => slot?.apiKey);
  const models = [
    settings.chatgpt?.model, settings.claude?.model, settings.grok?.model,
    settings.fallback?.chatgpt?.model, settings.fallback?.claude?.model, settings.fallback?.grok?.model,
    settings.gemini?.model, settings.kimi?.model,
    settings.fallback?.gemini?.model, settings.fallback?.kimi?.model,
  ];
  return !signedIn && !storedKeys && !slotKeys.some(Boolean) && !models.some(Boolean);
}

/** Restores the Drive backup; returns the restored settings. */
export function restoreFromDrive({ getToken = googleAccessToken } = {}) {
  return serial(() => restore(getToken));
}

async function restore(getToken) {
  const token = await getToken();
  const file = await findBackupFile(token);
  if (!file) throw new Error('There is no backup in Google Drive yet.');
  const data = await readBackupFile(token, file.id);
  const settings = await importBackup(data);
  // Records what Drive holds, so restoring does not upload it straight back; a local
  // sign-in the file lacks (and the import keeps) still gets uploaded.
  const held = { settings: mergeSettings(data.settings ?? {}), accounts: accountsIn(data) };
  await saveState({ fileId: file.id, at: Date.parse(file.modifiedTime) || Date.now(), hash: await backupHash(held), error: null });
  return settings;
}

/**
 * Right after sign-in: a fresh install gets its settings back; an install that is
 * already set up keeps them and is told a backup exists; with no backup yet, the
 * first one is made.
 */
export function afterGoogleSignIn({ getToken = googleAccessToken } = {}) {
  return serial(async () => {
    await saveState({}); // the state names a file in the previous account's Drive
    const file = await findBackupFile(await getToken());
    if (!file) return { backup: await upload(getToken) };
    if (isFreshSetup(await exportBackup())) return { restored: await restore(getToken) };
    return { available: file.modifiedTime };
  });
}
