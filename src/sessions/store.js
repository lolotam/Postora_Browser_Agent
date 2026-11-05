// Sessions saved on this computer in chrome.storage.local (the extension has
// unlimitedStorage). The index holds titles, times and tab groups; each session's
// body is its own key so listing never loads transcripts.

const INDEX = 'sessions';
const bodyKey = (id) => `session:${id}`;
const TITLE_WORDS = 6;

// Several sessions save at once; index updates run one at a time so none is lost.
let indexQueue = Promise.resolve();
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
  return { meta, ...body };
}

export async function saveSession(id, { transcript, log, groupId, notebook = null, pending = [], project = null }) {
  await chrome.storage.local.set({ [bodyKey(id)]: { transcript, log, groupId, notebook, pending, project } });
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
