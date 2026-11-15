// Synthetic keys only. Optional real, checksum-verified local model download:
// POSTORA_TEST_DOWNLOAD=1 node test/e2e/providers-voice.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { extensionWorker } from './extension-worker.mjs';
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-voice-ui-'));
const { key } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map((n) => String.fromCharCode(97 + (n >> 4), 97 + (n & 15))).join('');
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
try {
  const page = await context.newPage(); const errors = [];
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 400, height: 850 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
  await page.waitForFunction(() => document.getElementById('provider').options.length > 10);
  await page.waitForSelector('#provider', { state: 'visible' });
  const worker = extensionWorker(context, page, id);
  await worker.evaluate(() => {
    const fetchOriginal = globalThis.fetch;
    globalThis.__openrouterStarted = false;
    chrome.identity.launchWebAuthFlow = async ({ url }) => {
      const parsed = new URL(url);
      globalThis.__openrouterStarted = parsed.origin === 'https://openrouter.ai' && parsed.searchParams.get('code_challenge_method') === 'S256';
      return parsed.searchParams.get('callback_url') + '?code=SYNTHETIC-CODE';
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://account.minimax.io/oauth2/device/code') {
        const body = new URLSearchParams(init.body);
        return Response.json({ state: body.get('state'), user_code: 'SYNTHETIC-PLAN', verification_uri: 'https://platform.minimax.io/postora-test', expired_in: Date.now() + 60000, interval: 1000 });
      }
      if (url === 'https://account.minimax.io/oauth2/token') return Response.json({ status: 'success', access_token: 'synthetic-minimax-token', refresh_token: 'synthetic-minimax-refresh', expired_in: Date.now() + 3600000 });
      if (url === 'https://zcode.z.ai/api/v1/oauth/cli/init') return Response.json({ code: 0, data: { flow_id: 'fixture', authorize_url: 'https://chat.z.ai/postora-test', expires_at: Date.now() + 60000, poll_interval_sec: 1 } });
      if (url === 'https://zcode.z.ai/api/v1/oauth/cli/poll/fixture') return Response.json({ code: 0, data: { status: 'ready', user: { user_id: 'synthetic-user' }, zai: { access_token: 'synthetic-zai-identity' } } });
      if (url === 'https://api.z.ai/api/auth/z/login') return Response.json({ code: 0, data: { access_token: 'synthetic-zai-business' } });
      if (url.endsWith('/getCustomerInfo')) return Response.json({ code: 200, data: { organizations: [{ organizationId: 'fixture-org', projects: [{ projectId: 'fixture-project' }] }] } });
      if (url.startsWith('https://api.z.ai/api/biz/')) {
        if (url.endsWith('/access_tokens')) return Response.json({ code: 200, data: { accessToken: 'synthetic-zai-inference', tokenType: 'Bearer', expiresAt: Date.now() / 1000 + 3600, expiresIn: 3600 } });
        return Response.json({ code: 200, data: [{ name: 'postora-coding-plan', apiKey: 'fixture-key' }] });
      }
      if (url === 'https://openrouter.ai/api/v1/auth/keys') return Response.json({ key: 'SYNTHETIC-OPENROUTER' });
      if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [{ id: 'fixture-model' }] });
      return fetchOriginal(input, init);
    };
  });
  assert.equal(await page.locator('#provider optgroup').count(), 3);
  assert.deepEqual(await page.locator('#provider option').evaluateAll((els) => els.map((el) => el.value)), await page.locator('#fallbackProvider [data-field="provider"] option').evaluateAll((els) => els.map((el) => el.value)));
  assert.deepEqual(await page.locator('#mainProvider [data-field]').evaluateAll((els) => els.map((el) => el.dataset.field)), await page.locator('#fallbackProvider [data-field]').evaluateAll((els) => els.map((el) => el.dataset.field)));
  await page.selectOption('#provider', 'claude-api');
  assert.equal(await page.locator('#claudeSection [data-field="claudeAccount"]').isVisible(), false);
  assert.equal(await page.locator('#claudeSection [data-field="claudeApiKey"]').isVisible(), true);
  await page.selectOption('#provider', 'claude');
  assert.equal(await page.locator('#claudeSection [data-auth="login"]').isVisible(), true);
  for (const preset of ['openrouter', 'minimax-coding-plan', 'zai-coding']) {
    await page.selectOption('#provider', ({ 'minimax-coding-plan': 'minimax-plan', 'zai-coding': 'zai-plan' })[preset] ?? `api:${preset}`);
    assert.equal(await page.inputValue('#preset'), preset);
  }
  await page.selectOption('#provider', 'minimax-plan');
  assert.equal(await page.locator('[data-field="planAccount"]').first().isVisible(), true);
  assert.equal(await page.locator('[data-field="planAccount"]').first().getAttribute('href'), 'https://platform.minimax.io/subscribe/coding-plan');
  await page.selectOption('#provider', 'openrouter-auth');
  assert.equal(await page.locator('[data-field="openrouterSignIn"]').first().isVisible(), true);
  for (const field of ['presetField', 'baseUrlField', 'apiKeyField']) {
    assert.equal(await page.locator(`[data-field="${field}"]`).first().isVisible(), false);
  }
  await page.locator('[data-field="openrouterSignIn"]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-field="openrouterStatus"]').textContent.includes('Connected'));
  assert.equal(await worker.evaluate(() => globalThis.__openrouterStarted), true);
  assert.equal(await page.inputValue('#apiKey'), 'SYNTHETIC-OPENROUTER');
  await page.selectOption('#provider', 'api:openrouter');
  assert.equal(await page.locator('[data-field="apiKeyField"]').first().isVisible(), true);
  // The backup is the same form, including real account login controls.
  await page.click('#closeSettingsBtn');
  await page.check('#fallbackEnabled');
  await page.click('#settingsRowBackup');
  for (const provider of ['minimax', 'zai']) {
    await page.selectOption('#fallbackProvider [data-field="provider"]', `${provider}-auth`);
    assert.equal(await page.locator('#fallbackProvider [data-field="apiKeyField"]').isVisible(), false);
    await page.locator(`#fallbackProvider [data-provider="${provider}"] [data-auth="login"]`).click();
    await page.bringToFront();
    await page.waitForSelector(`#fallbackProvider [data-provider="${provider}"] [data-auth="logout"]:not([hidden])`);
    await page.locator(`#fallbackProvider [data-provider="${provider}"] [data-auth="logout"]`).click();
    await page.waitForSelector(`#fallbackProvider [data-provider="${provider}"] [data-auth="login"]:not([hidden])`);
  }
  await page.click('#closeSettingsBtn');
  await page.click('#settingsRowMain');
  assert.equal(await page.locator('[data-field="openrouterLogin"]').first().isVisible(), false);
  await page.selectOption('#provider', 'zai-plan');
  assert.equal(await page.locator('[data-field="zaiAccount"]').first().isVisible(), true);
  assert.equal(await page.locator('[data-field="apiKeyField"]').first().isVisible(), true);
  // Reproduce the reported old-background response without touching real auth.
  await page.evaluate(async () => {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async () => ({ ok: false, error: 'Unknown request openrouter-login' });
    try { const { request } = await import(chrome.runtime.getURL('src/sidepanel/request.js')); await request('openrouter-login'); } catch { /* Expected mismatch. */ }
    finally { chrome.runtime.sendMessage = original; }
  });
  assert.equal(await page.locator('#workerUpdateNotice').isVisible(), true);
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
  await page.selectOption('#transcriptionMode', 'auto');
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
