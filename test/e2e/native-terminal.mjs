// Optional installed-host integration check. No models or real secrets involved.
// CHROMIUM_PATH=<extension-capable Chromium> node test/e2e/native-terminal.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { key } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-native-e2e-'));
const context = await chromium.launchPersistentContext(directory, {
  headless: true, executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
  const result = await page.evaluate(async () => {
    const { runNativeCommand } = await import(chrome.runtime.getURL('src/native/client.js'));
    return runNativeCommand({ command: "Write-Output 'postora-native-fixture-only'", timeout_ms: 10000 });
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.output, /postora-native-fixture-only/);
  console.log('PASS: real Chrome native messaging transport to installed PowerShell host.');
} finally {
  await context.close();
}
