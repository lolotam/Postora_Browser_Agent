import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const HIDDEN = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'vendor']);
// Windows strips trailing dots and spaces when resolving a filename, and
// compares names case-insensitively. Normalize every component the same way.
const cleanName = (name) => String(name ?? '').trim().replace(/[. ]+$/g, '').toLowerCase();
export const isGitName = (name) => cleanName(name) === '.git';
export const isHiddenName = (name) => HIDDEN.has(String(name ?? '').toLowerCase()) || HIDDEN.has(cleanName(name));
// A secret name, with or without a leading dot: `.secrets`, `.secrets.json`,
// `.token` and `auth.json` are all names a secret file has. The context the
// model reads must not carry them, and project_read / project_write must not
// read or overwrite them.
const SECRET_PATTERN = /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|\.postora-write\.lock$|^\.?(?:auth|credentials|secrets?|tokens?)(?:\.|$)|^\.npmrc$|^\.git-credentials$/i;
export const secret = (name) => SECRET_PATTERN.test(String(name ?? '')) || SECRET_PATTERN.test(cleanName(name));
export const isProtectedName = (name) => isHiddenName(name) || secret(name);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function splitComponents(relPath) {
  return String(relPath ?? '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.');
}

function assertAllowedComponents(relPath, { forWrite = false } = {}) {
  for (const part of splitComponents(relPath)) {
    if (isGitName(part)) {
      throw new Error(forWrite ? 'Writing inside .git is never allowed.' : 'Accessing .git is not allowed.');
    }
    if (isProtectedName(part)) {
      throw new Error(`Access to protected or secret path "${part}" is not allowed.`);
    }
  }
}

function isSameOrInside(parentDir, candidateDir) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parentDir), norm(candidateDir));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function assertRootPinned(canonicalRoot, allowedRoots) {
  if (allowedRoots === null || allowedRoots === undefined) return;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error('Project root is not allowed by the host configuration.');
  }
  for (const entry of allowedRoots) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) continue;
    try {
      const realAllowed = await fs.realpath(entry);
      if (isSameOrInside(realAllowed, canonicalRoot)) return;
    } catch {
      // Ignore non-existent configured roots.
    }
  }
  throw new Error('Project root is not in the host\'s pinned allowedRoots configuration.');
}

/** Bounded initial context: recursive inventory and text, with explicit limits. */
async function projectContext(root, allowedRoots = null) {
  const paths = [], directories = ['.'], files = [], errors = [];
  let truncated = false, characters = 0, pathCharacters = 0;
  for (let index = 0; index < directories.length; index++) {
    const relative = directories[index];
    let entries;
    try { entries = await fs.readdir(await projectPath(root, relative, { allowedRoots }), { withFileTypes: true }); }
    catch { errors.push(relative); continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isProtectedName(entry.name) || entry.isSymbolicLink()) continue;
      if (paths.length >= 1000) { truncated = true; break; }
      const name = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (pathCharacters + name.length > 64000) { truncated = true; break; }
      pathCharacters += name.length;
      paths.push({ path: name, directory: entry.isDirectory() });
      if (entry.isDirectory()) {
        if (name.split('/').length < 12) directories.push(name);
        else truncated = true;
      } else if (entry.isFile()) files.push(name);
    }
    if (paths.length >= 1000) break;
  }
  files.sort((a, b) => Number(!/(^|\/)(AGENTS\.md|README[^/]*|package\.json)$/i.test(a)) - Number(!/(^|\/)(AGENTS\.md|README[^/]*|package\.json)$/i.test(b)) || a.localeCompare(b));
  const documents = [];
  for (const file of files) {
    if (characters >= 48000) { truncated = true; break; }
    if (!/\.(md|txt|json|ya?ml|toml|ini|csv|ts|tsx|js|jsx|mjs|cjs|py|html|css|sql|sh|ps1|go|rs|java|cs|php|xml|vue|svelte)$/i.test(file)) continue;
    try {
      const target = await projectPath(root, file, { allowedRoots });
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const bytes = await fs.readFile(target);
      if (bytes.includes(0)) continue;
      const content = bytes.toString('utf8');
      const text = content.slice(0, Math.min(8000, 48000 - characters));
      characters += text.length;
      documents.push({ path: file, text, total: content.length, truncated: text.length < content.length });
    } catch { errors.push(file); }
  }
  return { paths, documents, characters, truncated, errors, limits: { entries: 1000, depth: 12, characters: 48000, charactersPerFile: 8000, pathCharacters: 64000 }, omitted: 'Dependencies, build output, symlinks, common secret files and binary files are omitted. Use project_list/project_read for more context.' };
}

export async function projectInfo(root, { allowedRoots = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Select an absolute project directory.');
  const real = await fs.realpath(root);
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Project root must be a directory.');
  await assertRootPinned(real, allowedRoots);
  return { root: real, name: path.basename(real) || real };
}

export async function projectPath(root, relative = '.', { create = false, forWrite = false, allowedRoots = null } = {}) {
  const project = await projectInfo(root, { allowedRoots });
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Use a project-relative path.');
  const full = path.resolve(project.root, relative);
  const inside = (candidate) => {
    const rel = path.relative(project.root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path is outside the selected project.');
    return rel;
  };
  const requestedRel = inside(full);
  assertAllowedComponents(relative, { forWrite });
  assertAllowedComponents(requestedRel, { forWrite });
  try {
    const real = await fs.realpath(full);
    const canonicalRel = inside(real);
    assertAllowedComponents(canonicalRel, { forWrite });
    return real;
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error;
    // A new file may only be created in an existing, canonical directory.
    const parent = await fs.realpath(path.dirname(full));
    const parentRel = inside(parent);
    assertAllowedComponents(parentRel, { forWrite });
    const target = path.join(parent, path.basename(full));
    const canonicalRel = inside(target);
    assertAllowedComponents(canonicalRel, { forWrite });
    return target;
  }
}

function throwIfPreCommitAborted(signal) {
  if (!signal?.aborted) return;
  let err;
  try {
    signal.throwIfAborted();
  } catch (thrown) {
    err = thrown instanceof Error ? thrown : new Error(String(thrown));
  }
  err ??= new Error('The project operation was aborted before committing.');
  err.preCommitAbort = true;
  throw err;
}

export async function projectOperation(message, { signal = null, beforeCommit = null, allowedRoots = null } = {}) {
  throwIfPreCommitAborted(signal);
  const project = await projectInfo(message.root, { allowedRoots });
  if (message.type === 'project-info') return { ...project };
  if (message.type === 'project-context') return projectContext(project.root, allowedRoots);
  const relative = message.path ?? '.';
  const isWrite = message.type === 'project-write';
  const target = await projectPath(project.root, relative, { create: isWrite, forWrite: isWrite, allowedRoots });
  throwIfPreCommitAborted(signal);
  if (message.type === 'project-list') {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return { path: relative, entries: entries.filter((entry) => !isProtectedName(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })), truncated: entries.length > 500 };
  }
  if (message.type === 'project-read') {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Read supports text files up to 1 MiB.');
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) throw new Error('Binary file; select a text file.');
    const content = bytes.toString('utf8');
    const start = Math.max(0, Math.floor(Number(message.start) || 0));
    const text = content.slice(start, start + 24000);
    return { path: relative, text, hash: hash(bytes), total: content.length, start, truncated: start + text.length < content.length };
  }
  if (message.type === 'project-write') {
    if (typeof message.text !== 'string' || Buffer.byteLength(message.text) > 64000) throw new Error('Write supports up to 64000 UTF-8 bytes per file.');
    // Native requests use separate processes. Serialize cooperating writes across
    // those processes, including the final hash check and atomic replacement.
    const lockPath = `${target}.postora-write.lock`;
    let lock;
    let committed = false;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('File has an active or interrupted Postora write lock. Retry after the other write finishes; an interrupted lock requires user recovery.');
      throw error;
    }
    try {
      let previous;
      try { previous = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous ? message.expected_hash !== hash(previous) : message.expected_hash !== 'new') {
        throw new Error('File changed or expected_hash is missing. Read the current file before writing.');
      }
      // Write a sibling first so Stop or a failed write cannot leave the original
      // half-written. Only replace it after checking the current revision again.
      const temporary = `${target}.postora-${randomUUID()}.tmp`;
      try {
        const data = Buffer.from(message.text);
        const mode = previous ? (await fs.stat(target)).mode & 0o777 : 0o600;
        await fs.writeFile(temporary, data, { flag: 'wx', mode });
        if (await projectPath(project.root, relative, { create: true, forWrite: true, allowedRoots }) !== target) throw new Error('File target changed before writing.');
        let actual;
        try { actual = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous ? !actual || hash(actual) !== message.expected_hash : actual !== undefined) {
          throw new Error('File changed before writing. Read it again.');
        }
        if (typeof beforeCommit === 'function') await beforeCommit();
        if (previous) {
          throwIfPreCommitAborted(signal);
          await fs.rename(temporary, target);
          committed = true;
        } else {
          // Exclusive link creation is atomic and cannot overwrite a file that
          // appeared after the check for a new path.
          throwIfPreCommitAborted(signal);
          await fs.link(temporary, target);
          committed = true;
        }
      } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      return { path: relative, hash: hash(Buffer.from(message.text)), bytes: Buffer.byteLength(message.text) };
    } catch (error) {
      if (committed && error && typeof error === 'object') {
        error.committed = true;
        error.preCommitAbort = false;
      }
      throw error;
    } finally {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch((error) => {
        if (committed && error && typeof error === 'object') {
          error.committed = true;
          error.preCommitAbort = false;
        }
        throw error;
      });
    }
  }
  throw new Error('Unknown project operation.');
}
