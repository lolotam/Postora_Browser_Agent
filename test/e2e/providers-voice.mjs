// Synthetic keys only. Optional real, checksum-verified local model download:
// POSTORA_TEST_DOWNLOAD=1 node test/e2e/providers-voice.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-voice-ui-'));
const { key } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map((n) => String.fromCharCode(97 + (n >> 4), 97 + (n & 15))).join('');
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
try {
  const page = await context.newPage(); const errors = [];
  await page.setViewportSize({ width: 400, height: 850 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
  await page.waitForFunction(() => document.getElementById('provider').options.length > 10);
  await page.waitForSelector('#provider', { state: 'visible' });
  assert.equal(await page.locator('#provider optgroup').count(), 2);
  await page.selectOption('#provider', 'claude-api');
  assert.equal(await page.locator('#claudeSection [data-field="claudeAccount"]').isVisible(), false);
  assert.equal(await page.locator('#claudeSection [data-field="claudeApiKey"]').isVisible(), true);
  await page.selectOption('#provider', 'claude');
  assert.equal(await page.locator('#claudeSection [data-auth="login"]').isVisible(), true);
  for (const preset of ['openrouter', 'minimax-coding-plan', 'zai-coding']) {
    await page.selectOption('#provider', `api:${preset}`);
    assert.equal(await page.inputValue('#preset'), preset);
  }
  await page.selectOption('#provider', 'openrouter-auth');
  assert.equal(await page.locator('[data-field="openrouterSignIn"]').first().isVisible(), true);
  await page.click('#closeSettingsBtn');
  if (!(await page.locator('#settingsRowVoice').isVisible())) await page.click('#closeSettingsBtn');
  await page.click('#settingsRowVoice');
  await page.evaluate(() => {
    globalThis.__testOriginalSpeech = window.speechSynthesis;
    globalThis.__testOriginalUtterance = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ lang: 'en-US' }], cancel() {}, resume() {},
      speak(utterance) { utterance.onerror({ error: 'not-allowed' }); },
    } });
  });
  await page.click('#testSpeechArabic');
  await page.waitForFunction(() => document.getElementById('speechTestStatus').textContent.includes('No Arabic'));
  await page.click('#testSpeechEnglish');
  await page.waitForFunction(() => document.getElementById('speechTestStatus').textContent.includes('blocked sound'));
  await page.selectOption('#transcriptionPause', '600');
  assert.equal(await page.inputValue('#transcriptionPause'), '600');
  await page.evaluate(() => { Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: globalThis.__testOriginalSpeech }); window.SpeechSynthesisUtterance = globalThis.__testOriginalUtterance; delete globalThis.__testOriginalSpeech; delete globalThis.__testOriginalUtterance; });
  await page.selectOption('#transcriptionService', 'groq');
  assert.equal(await page.inputValue('#transcriptionModel'), 'whisper-large-v3-turbo');
  await page.fill('#transcriptionKey', 'SYNTHETIC-GROQ');
  await page.selectOption('#transcriptionService', 'deepgram');
  assert.equal(await page.inputValue('#transcriptionKey'), '');
  assert.equal(await page.inputValue('#transcriptionModel'), 'nova-3');
  await page.fill('#transcriptionKey', 'SYNTHETIC-DEEPGRAM');
  await page.selectOption('#transcriptionService', 'groq');
  assert.equal(await page.inputValue('#transcriptionKey'), 'SYNTHETIC-GROQ');
  await page.selectOption('#transcriptionService', 'local');
  assert.equal(await page.locator('#transcriptionCloud').isVisible(), false);
  await page.waitForFunction(() => document.getElementById('localModelStatus').textContent || !document.getElementById('downloadLocalModel').hidden);
  if (process.env.POSTORA_TEST_DOWNLOAD === '1') {
    if (await page.locator('#downloadLocalModel').isVisible()) {
      await page.click('#downloadLocalModel');
      await page.waitForFunction(() => document.getElementById('localModelProgress').value > 0, { timeout: 120000 });
      await page.waitForFunction(() => document.getElementById('downloadLocalModel').hidden, { timeout: 600000 });
    }
    const result = await page.evaluate(async () => {
      const { transcribeAudio } = await import(chrome.runtime.getURL('src/voice/transcription.js'));
      const { pcmWav } = await import(chrome.runtime.getURL('src/voice/local-transcription.js'));
      const wav = pcmWav(new Float32Array(16000));
      const text = await transcribeAudio(new Blob([wav], { type: 'audio/wav' }), { provider: 'local' });
      return { ok: typeof text === 'string' };
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(errors, []);
  if (process.env.E2E_SCREENSHOTS) {
    fs.mkdirSync(process.env.E2E_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, 'voice-local.png') });
  }
  console.log('PROVIDERS/VOICE PASSED: grouped routes, account/API switching, per-service keys, local UI' + (process.env.POSTORA_TEST_DOWNLOAD === '1' ? ', actual model download and local inference.' : '.'));
} finally { await context.close(); }
