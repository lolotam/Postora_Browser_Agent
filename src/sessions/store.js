// Sessions saved on this computer in chrome.storage.local (the extension has
// unlimitedStorage). The index holds titles, times and tab groups; each session's
// body is its own key so listing never loads transcripts.

import { sanitizeSessionBody } from '../agent/redaction.js';

const INDEX = 'sessions';
const bodyKey = (id) => `session:${id}`;
const TITLE_WORDS = 6;

// Several sessions save at once; index updates run one at a time so none is lost.
let indexQueue = Promise.resolve();
// A restore is a whole operation: read the index, decide, write. One at a time.
let importQueue = Promise.resolve();
function updateIndex(change) {
  const run = indexQueue.then(async () => {
    const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
    const next = change(index);
    await chrome.storage.local.set({ [INDEX]: next });
    return next;
  });
  indexQueue = run.catch(() => {});
  return run;
}

/** An empty title means "not named yet": the first task names it. */
export async function createStoredSession(title = '') {
  const now = Date.now();
  const meta = { id: crypto.randomUUID(), title, titled: Boolean(title), createdAt: now, updatedAt: now };
  await chrome.storage.local.set({ [bodyKey(meta.id)]: { transcript: [], log: null, groupId: null } });
  await updateIndex((index) => [...index, meta]);
  return meta;
}

export async function listSessions() {
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id) {
  const { [bodyKey(id)]: body } = await chrome.storage.local.get(bodyKey(id));
  if (!body) return null;
  const meta = (await listSessions()).find((s) => s.id === id) ?? null;
  return { ...body, meta }; // the index is the authority: a body that carries its own meta must not replace it
}

export async function saveSession(id, { transcript, log, groupId, notebook = null, pending = [], project = null, continuation = null }) {
  const clean = sanitizeSessionBody({ transcript, log, groupId, notebook, pending, project, continuation });
  await chrome.storage.local.set({ [bodyKey(id)]: clean });
  await updateIndex((index) => index.map((s) => (s.id === id ? { ...s, groupId, updatedAt: Date.now() } : s)));
}

export async function renameSession(id, title) {
  const clean = String(title).trim();
  if (!clean) return;
  await updateIndex((index) => index.map((s) => (s.id === id ? { ...s, title: clean, titled: true } : s)));
}

export async function titleFromFirstTask(id, task) {
  const words = String(task).trim().split(/\s+/);
  const title = words.slice(0, TITLE_WORDS).join(' ') + (words.length > TITLE_WORDS ? '…' : '');
  await updateIndex((index) => index.map((s) => (s.id === id && !s.titled ? { ...s, title, titled: true } : s)));
}

export async function deleteSession(id) {
  await chrome.storage.local.remove(bodyKey(id));
  await updateIndex((index) => index.filter((s) => s.id !== id));
}

/** A portable archive; browser tab/group IDs are not meaningful after reinstall. */
export async function exportSessions() {
  await indexQueue;
  const index = await listSessions();
  const bodies = await chrome.storage.local.get(index.map((meta) => bodyKey(meta.id)));
  return index.map((meta) => {
    const body = bodies[bodyKey(meta.id)];
    if (!body) throw new Error('A session is missing its history. Backup was not created.');
    const clean = sanitizeSessionBody(body);
    return { meta: { ...meta, groupId: null }, body: { ...clean, groupId: null, continuation: clean.continuation ? { ...clean.continuation, tabId: null } : null } };
  });
}

/**
 * A notebook that Notebook.from() can open: omitted, or entries of text with an
 * optional source link. A null or text-less entry would make format() throw the
 * moment the chat is opened.
 */
function validNotebook(notebook) {
  if (notebook == null) return true;
  if (typeof notebook !== 'object' || Array.isArray(notebook)) return false;
  if (notebook.entries == null) return true;
  return Array.isArray(notebook.entries)
    && notebook.entries.every((e) => e && typeof e === 'object' && typeof e.text === 'string' && (e.url == null || typeof e.url === 'string'));
}

/** Validate the entire archive before any settings or session are changed. */
export function validateSessions(archive) {
  if (!Array.isArray(archive)) throw new Error('This backup is damaged: its sessions cannot be read.');
  const ids = new Set();
  for (const entry of archive) {
    const { meta, body } = entry ?? {};
    if (!meta || typeof meta.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(meta.id) || ids.has(meta.id)
      || typeof meta.title !== 'string' || !Number.isFinite(meta.createdAt) || !Number.isFinite(meta.updatedAt)
      || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.prototype.hasOwnProperty.call(body, 'meta')
      || !Array.isArray(body.transcript) || body.transcript.some((e) => !e || typeof e.type !== 'string')
      || (body.log != null && (typeof body.log !== 'object' || Array.isArray(body.log)))
      || !validNotebook(body.notebook)
      || (body.continuation != null && (typeof body.continuation.task !== 'string' || !body.continuation.task.trim()))) {
      throw new Error('This backup is damaged: a session cannot be read.');
    }
    ids.add(meta.id);
  }
  return structuredClone(archive);
}

/**
 * Merge safely. Existing histories survive a collision with an imported ID.
 *
 * One restore at a time. Each one reads the index, decides what to write and
 * writes it, so two at once would both read the same index and both write the
 * same conversations: the second body would win, and the index would end up
 * with the same conversation twice. This queue runs the whole operation one
 * after the other, so the second one sees what the first one added.
 */
export function importSessions(archive) {
  const run = importQueue.then(async () => {
    const entries = validateSessions(archive);
    await indexQueue;
    const existing = await listSessions();
    const used = new Set(existing.map((meta) => meta.id));
    const writes = {};
    const added = [];
    const historyFields = (value) => [value?.transcript, value?.log, value?.notebook, value?.pending, value?.continuation ? { ...value.continuation, tabId: null } : null];
    // The bodies an imported session could already be stored as: its own ID, and
    // the copies an earlier restore made of it. One read for all of them.
    const stored = existing.filter((meta) => entries.some((e) => e.meta.id === meta.id || e.meta.id === meta.importedFrom));
    const bodies = stored.length ? await chrome.storage.local.get(stored.map((meta) => bodyKey(meta.id))) : {};
    for (const { meta, body } of entries) {
      const { project: _droppedProject, meta: _droppedMeta, ...restBody } = body;
      const portable = { ...restBody, project: null, groupId: null, continuation: body.continuation ? { ...body.continuation, tabId: null } : null };
      const collides = used.has(meta.id);
      if (collides) {
        const wanted = JSON.stringify(historyFields(portable));
        // The same history already stored, as itself or as a copy an earlier
        // restore made, is not added again.
        if (stored.some((s) => (s.id === meta.id || s.importedFrom === meta.id) && JSON.stringify(historyFields(bodies[bodyKey(s.id)])) === wanted)) continue;
      }
      const id = collides ? crypto.randomUUID() : meta.id;
      used.add(id);
      added.push({ ...meta, id, groupId: null, ...(collides ? { importedFrom: meta.id } : {}) });
      writes[bodyKey(id)] = portable;
    }
    await chrome.storage.local.set(writes);
    await updateIndex((index) => {
      const known = new Set(index.map((meta) => meta.id));
      return [...index, ...added.filter((meta) => !known.has(meta.id))];
    });
    return added.length;
  });
  importQueue = run.catch(() => {});
  return run;
}
