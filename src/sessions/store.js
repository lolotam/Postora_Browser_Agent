// Sessions saved on this computer in chrome.storage.local (the extension has
// unlimitedStorage). The index holds titles, times and tab groups; each session's
// body is its own key so listing never loads transcripts.

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
  await chrome.storage.local.set({ [bodyKey(id)]: { transcript, log, groupId, notebook, pending, project, continuation } });
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
    return { meta: { ...meta, groupId: null }, body: { ...body, groupId: null, continuation: body.continuation ? { ...body.continuation, tabId: null } : null } };
  });
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
    for (const { meta, body } of entries) {
      const { project: _droppedProject, meta: _droppedMeta, ...restBody } = body;
      const portable = { ...restBody, project: null, groupId: null, continuation: body.continuation ? { ...body.continuation, tabId: null } : null };
      if (used.has(meta.id)) {
        const current = await loadSession(meta.id);
        const historyFields = (value) => [value?.transcript, value?.log, value?.notebook, value?.pending, value?.continuation ? { ...value.continuation, tabId: null } : null];
        if (JSON.stringify(historyFields(current)) === JSON.stringify(historyFields(portable))) continue;
      }
      const id = used.has(meta.id) ? crypto.randomUUID() : meta.id;
      used.add(id);
      added.push({ ...meta, id, groupId: null });
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
