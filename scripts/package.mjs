// Builds the Chrome Web Store upload: dist/postora-browser-agent-v<version>.zip with only
// what the extension runs (manifest, locales, icons, src). The manifest's "key"
// is dropped, since the store assigns the extension's ID itself. The store build
// leaves out the run-JavaScript tool: src/lib/build.js says STORE_BUILD = true and
// code between "// @store-strip-start" and "// @store-strip-end" is removed. All of
// this happens on the copies going into the ZIP; the repository is never changed.
//
//   npm run package

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['_locales', 'icons', 'src'];
const SOURCE_ONLY = new Set(['icons/logo-source.png']); // icons are rendered from it; not needed at runtime
const MAX_DESCRIPTION = 132; // the store rejects longer manifest descriptions

/** Relative paths (forward slashes) of every file that ships, sorted. */
export function packageFiles(root = ROOT) {
  const files = ['manifest.json'];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (!entry.name.startsWith('.') && !SOURCE_ONLY.has(rel)) files.push(rel);
    }
  };
  INCLUDE.forEach(walk);
  return files.sort();
}

/** The manifest as uploaded: no "key". */
export function storeManifest(manifest) {
  const { key, ...rest } = manifest;
  return { ...rest, ...(rest.permissions ? { permissions: rest.permissions.filter((permission) => permission !== 'nativeMessaging') } : {}) };
}

/** Locale descriptions longer than the store accepts, as "lang: n chars". */
export function overlongDescriptions(root = ROOT) {
  return fs.readdirSync(path.join(root, '_locales')).flatMap((lang) => {
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', lang, 'messages.json'), 'utf8'));
    const n = [...(messages.extDescription?.message ?? '')].length;
    return n > MAX_DESCRIPTION ? [`${lang}: ${n} chars`] : [];
  });
}

// A marker is the whole line; anything else mentioning @store-strip is a typo.
const MARKER = /^[ \t]*\/\/ @store-strip-(start|end)[ \t]*\r?$/;
const BUILD_FLAG = 'export const STORE_BUILD = false;';

/**
 * Removes the lines from each start marker through its end marker. Read line by
 * line, so a start inside a block, an end without a start, or a block left open
 * stops the build instead of silently swallowing the code between two blocks.
 */
function stripMarked(name, text) {
  const kept = [];
  let open = 0; // line number of the open start marker, or 0
  text.split('\n').forEach((line, i) => {
    const marker = line.match(MARKER)?.[1];
    if (marker === 'start') {
      if (open) throw new Error(`${name}:${i + 1}: @store-strip-start inside the block opened at line ${open}`);
      open = i + 1;
    } else if (marker === 'end') {
      if (!open) throw new Error(`${name}:${i + 1}: @store-strip-end without a start`);
      open = 0;
    } else if (line.includes('@store-strip')) {
      // Inside a block too: a misspelled end must not let a later end decide what goes.
      throw new Error(`${name}:${i + 1}: malformed @store-strip marker`);
    } else if (!open) {
      kept.push(line);
    }
  });
  if (open) throw new Error(`${name}:${open}: @store-strip-start never closed`);
  return kept.join('\n');
}

/** A source file as it ships in the store build. */
export function storeSource(name, text) {
  let out = stripMarked(name, text);
  if (name === 'src/lib/build.js') {
    if (!out.includes(BUILD_FLAG)) throw new Error(`${name}: "${BUILD_FLAG}" not found`);
    out = out.replace(BUILD_FLAG, 'export const STORE_BUILD = true;');
  }
  return out;
}

/** Every file of the store build with the bytes it ships with. */
export function packageEntries(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  return packageFiles(root).map((name) => {
    if (name === 'manifest.json') return { name, data: Buffer.from(`${JSON.stringify(storeManifest(manifest), null, 2)}\n`) };
    const data = fs.readFileSync(path.join(root, name));
    return { name, data: /\.(js|mjs|html)$/.test(name) ? Buffer.from(storeSource(name, data.toString('utf8'))) : data };
  });
}

// CRC-32 (IEEE), computed here because zlib.crc32 needs Node 22.2 and the docs promise Node 20.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal ZIP writer (deflate, no external tools), enough for the store upload. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = (sig, size) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00, so builds are reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function main() {
  const overlong = overlongDescriptions();
  if (overlong.length) throw new Error(`Store descriptions must be ≤ ${MAX_DESCRIPTION} characters: ${overlong.join(', ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entries = packageEntries();
  const out = path.join(ROOT, 'dist', `postora-browser-agent-v${manifest.version}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip(entries));
  console.log(`${path.relative(ROOT, out)}: ${entries.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
