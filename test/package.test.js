import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, overlongDescriptions, packageFiles, storeManifest, zip } from '../scripts/package.mjs';

test('the store package holds only what the extension runs', () => {
  const files = packageFiles();
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('src/background/service-worker.js'));
  assert.ok(files.includes('_locales/ar/messages.json'));
  assert.ok(files.includes('icons/icon-128.png'));
  assert.ok(!files.includes('icons/logo-source.png'));
  assert.deepEqual(files.filter((f) => /^(test|docs|scripts|node_modules|\.git)\//.test(f) || f === 'package.json'), []);
});

test('the uploaded manifest drops the development key', () => {
  const out = storeManifest({ manifest_version: 3, key: 'MIIB…', name: 'x' });
  assert.equal('key' in out, false);
  assert.equal(out.name, 'x');
});

test('native messaging stays private and the store build has no native command tool', async () => {
  const out = storeManifest({ permissions: ['storage', 'nativeMessaging'] });
  assert.deepEqual(out.permissions, ['storage']);
  const { packageEntries } = await import('../scripts/package.mjs');
  const entries = packageEntries();
  const tools = entries.find((entry) => entry.name === 'src/agent/tools.js').data.toString();
  assert.doesNotMatch(tools, /run_terminal|runNativeCommand/);
  assert.equal(entries.some((entry) => entry.name.startsWith('native/')), false);
  const worker = entries.find((entry) => entry.name === 'src/background/service-worker.js').data.toString();
  const runner = entries.find((entry) => entry.name === 'src/background/session-runner.js').data.toString();
  assert.doesNotMatch(worker, /project-list-ui|project-pick|nativeRequest|runNativeCommand/);
  assert.doesNotMatch(runner, /project-set|async setProject|nativeRequest/);
});

test('every locale description fits the store limit', () => {
  assert.deepEqual(overlongDescriptions(), []);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip writes entries that inflate back to their bytes', () => {
  const data = Buffer.from('hello hello hello');
  const archive = zip([{ name: 'a/b.txt', data }]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLen = archive.readUInt16LE(26);
  const size = archive.readUInt32LE(18);
  const body = archive.subarray(30 + nameLen, 30 + nameLen + size);
  assert.equal(zlib.inflateRawSync(body).toString(), 'hello hello hello');
  assert.equal(archive.subarray(30, 30 + nameLen).toString(), 'a/b.txt');
});

test('store-strip markers remove their block; an unmatched marker stops the build', async () => {
  const { storeSource } = await import('../scripts/package.mjs');
  const text = 'a\n  // @store-strip-start\n  secret();\n  // @store-strip-end\nb\n';
  assert.equal(storeSource('src/x.js', text), 'a\nb\n');
  assert.throws(() => storeSource('src/x.js', 'a\n// @store-strip-start\nb\n'), /never closed/);
  assert.throws(() => storeSource('src/x.js', 'a\n// @store-strip-end\nb\n'), /without a start/);
  // Two blocks, the first missing its end: the code between them must not vanish quietly.
  const lostEnd = 'a\n// @store-strip-start\nx();\nkeep();\n// @store-strip-start\ny();\n// @store-strip-end\nb\n';
  assert.throws(() => storeSource('src/x.js', lostEnd), /inside the block opened at line 2/);
  const twoBlocks = 'a\n// @store-strip-start\nx();\n// @store-strip-end\nkeep();\n// @store-strip-start\ny();\n// @store-strip-end\nb\n';
  assert.equal(storeSource('src/x.js', twoBlocks), 'a\nkeep();\nb\n');
  // Misspelled markers stop the build, inside a block or outside one.
  const typoInside = 'a\n// @store-strip-start\nx();\n// @store-strip-end-extra\nkeep();\n// @store-strip-end\nb\n';
  assert.throws(() => storeSource('src/x.js', typoInside), /4: malformed/);
  assert.throws(() => storeSource('src/x.js', 'a\n// @store-strip-ends\nb\n'), /2: malformed/);
  assert.match(storeSource('src/lib/build.js', 'export const STORE_BUILD = false;\n'), /STORE_BUILD = true/);
});

test('the store build has no run-JavaScript capability, even with the setting on', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { packageEntries } = await import('../scripts/package.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-build-'));
  try {
    const entries = packageEntries();
    for (const { name, data } of entries) {
      fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), data);
    }
    // No trace of the tool or of evaluating code in a page.
    const leaks = entries.filter(({ name, data }) => /\.(js|html)$/.test(name) && /run_javascript|Runtime\.evaluate|@store-strip/.test(data.toString()));
    assert.deepEqual(leaks.map((e) => e.name), []);
    const load = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
    const { STORE_BUILD } = await load('src/lib/build.js');
    assert.equal(STORE_BUILD, true);
    const { effectiveSettings, DEFAULT_SETTINGS } = await load('src/lib/settings.js');
    const settings = effectiveSettings({ ...DEFAULT_SETTINGS, allowJavascript: true });
    assert.equal(settings.allowJavascript, false);
    const { toolDefinitions, createToolExecutor } = await load('src/agent/tools.js');
    const { buildSystemPrompt } = await load('src/agent/prompt.js');
    assert.ok(!toolDefinitions({ vision: true, allowJavascript: true }).some((t) => /javascript/i.test(t.name)));
    assert.doesNotMatch(buildSystemPrompt({ vision: true, allowJavascript: true, replyLanguage: { enabled: false } }), /javascript/i);
    // A call to the tool (from restored history, say) is refused.
    const execute = createToolExecutor({ overlay: {}, evaluate: () => assert.fail('evaluated') }, { askUser: async () => '' });
    assert.deepEqual(await execute('run_javascript', { expression: '1' }), { output: 'Unknown tool "run_javascript".', isError: true });
    // And the settings switch for it is hidden.
    assert.match(fs.readFileSync(path.join(dir, 'src/sidepanel/panel.js'), 'utf8'), /\$\('allowJavascript'\)\.closest\('label'\)\.hidden = STORE_BUILD;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the development build keeps the tool', async () => {
  const { toolDefinitions } = await import('../src/agent/tools.js');
  const { effectiveSettings } = await import('../src/lib/settings.js');
  assert.ok(toolDefinitions(effectiveSettings({ vision: true, allowJavascript: true })).some((t) => t.name === 'run_javascript'));
});

test('an executor only runs the tools offered in its session', async () => {
  const { createToolExecutor } = await import('../src/agent/tools.js');
  const execute = createToolExecutor({ overlay: {} }, { askUser: async () => 'yes', allowed: new Set(['ask_user']) });
  assert.equal((await execute('ask_user', { question: 'ok?' })).output, 'User answered: yes');
  assert.equal((await execute('run_javascript', { expression: '1' })).isError, true);
});
