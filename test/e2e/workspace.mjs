// Installed native host + real extension + mock model and transcription service.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runComposerScenario } from './composer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-workspace-'));
const project = path.join(temp, 'project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'README.md'), 'Original synthetic project.');
let turn = 0, audioBody = '', modelBodies = [];
const report = 'npm: تم فحص المشروع بنجاح.\n\n| الفحص | النتيجة |\n| --- | --- |\n| `npm run build` | نجح |\n\n- تم تحديث الملف المطلوب.\n\n```sh\nnpm run build\n```';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (data) => { body += data; });
  req.on('end', () => {
    if (req.url === '/audio/transcriptions') {
      audioBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: 'افتح project files' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'workspace-model' }] })); return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Workspace fixture</h1>'); return; }
    const data = JSON.parse(body); modelBodies.push(data);
    let name, args;
    if (turn === 0) { name = 'project_read'; args = { path: 'README.md' }; }
    else if (turn === 1) {
      const last = [...data.messages].reverse().find((m) => m.role === 'tool');
      name = 'project_write'; args = { path: 'README.md', text: 'Updated synthetic project.', expected_hash: JSON.parse(last.content).hash };
    } else if (turn === 2) { name = 'project_run'; args = { command: "Write-Output 'workspace-command-ok'" }; }
    else { name = 'done'; args = { report, success: true }; }
    turn++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${turn}`, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).key;
const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + parseInt(n, 16)));
const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), { headless: true,
  executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
try {
  const failures = await runComposerScenario(context, id);
  assert.deepEqual(failures, []);
  const panel = await context.newPage();
  const errors = []; panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
  await panel.evaluate(async (base) => {
    const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
    await chrome.storage.local.set({ settings: mergeSettings({ provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${base}/v1`, model: 'workspace-model' },
      transcription: { mode: 'auto', endpoint: `${base}/audio/transcriptions`, model: 'mock-transcribe' }, fast: { enabled: false }, uiLanguage: 'ar' }) });
  }, base);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent.includes('workspace-model'));
  await panel.click('#newChatBtn');
  await panel.waitForTimeout(200);
  await panel.click('#projectBtn');
  await panel.fill('#projectRoot', project);
  await panel.click('#projectSave');
  await panel.waitForSelector('#projectChip:not([hidden])', { timeout: 10000 }).catch(async (error) => {
    throw new Error(`${error.message}; project panel: ${await panel.locator('#projectError').textContent()}; page errors: ${errors.join('; ')}`);
  });
  await panel.fill('#input', '@');
  // fill() produces input, which opens the @file chooser.
  await panel.waitForSelector('#projectFilesDialog[open]');
  await panel.getByRole('button', { name: '@ README.md', exact: true }).click();
  assert.match(await panel.inputValue('#input'), /README.md/);
  const transcription = await panel.evaluate(async () => {
    const { transcribeAudio, speechLocale } = await import(chrome.runtime.getURL('src/voice/transcription.js'));
    const settings = (await chrome.storage.local.get('settings')).settings;
    const text = await transcribeAudio(new Blob(['synthetic recording'], { type: 'audio/webm' }), settings.transcription);
    return { text, locale: speechLocale(text) };
  });
  assert.equal(transcription.text, 'افتح project files');
  assert.equal(transcription.locale, 'ar-EG');
  assert.ok(audioBody.includes('name="model"'));
  assert.equal(audioBody.includes('name="language"'), false);
  const target = await context.newPage(); await target.goto(`${base}/fixture`); await target.bringToFront();
  await panel.fill('#input', 'Update the selected synthetic project and run its check.');
  await panel.click('#sendBtn');
  await panel.waitForSelector('#approvals .permission-request', { timeout: 30000 });
  await panel.selectOption('#accessSelect', 'full-access');
  await panel.check('#accessAcknowledge'); await panel.click('#accessConfirm');
  await panel.waitForSelector('.msg.final', { timeout: 60000 });
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), 'Updated synthetic project.');
  assert.equal(await panel.locator('.mode-note').count(), 1);
  assert.ok(modelBodies.some((body) => JSON.stringify(body).includes('workspace-command-ok')));
  assert.ok(modelBodies.some((body) => JSON.stringify(body).includes('Worker access update')));
  assert.equal(await panel.locator('.msg.final').getAttribute('dir'), 'rtl');
  await panel.evaluate(() => { document.documentElement.dir = 'ltr'; });
  assert.equal(await panel.locator('.msg.final').evaluate((el) => getComputedStyle(el).direction), 'rtl');
  assert.equal(await panel.locator('.msg.final pre').evaluate((el) => getComputedStyle(el).direction), 'ltr');
  const thread = panel.locator('.thread').filter({ has: panel.locator('.step') }).first();
  assert.equal(await thread.evaluate((el) => getComputedStyle(el).borderTopWidth), '0px');
  await thread.locator(':scope > summary').click();
  const tool = thread.locator('.step').first();
  await tool.locator('summary').click();
  assert.equal(await tool.locator('.step-details').isVisible(), true);
  await tool.locator('summary').click();
  assert.equal(await tool.locator('.step-details').isVisible(), false);
  await thread.locator(':scope > summary').click();
  assert.deepEqual(errors, []);
  await panel.setViewportSize({ width: 400, height: 780 });
  if (process.env.E2E_SCREENSHOTS) {
    fs.mkdirSync(process.env.E2E_SCREENSHOTS, { recursive: true });
    await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, 'workspace-ar.png') });
  }
  await panel.waitForFunction(() => document.getElementById('stopBtn').hidden);
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ voiceHandsfree: false, voiceSpeak: true });
    window.__spokenReplies = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ lang: 'ar-EG' }, { lang: 'en-US' }], cancel() {}, resume() {},
      speak(utterance) { window.__spokenReplies.push(utterance.text); utterance.onend?.(); },
    } });
  });
  await target.bringToFront();
  await panel.click('#voiceToggle');
  await panel.waitForSelector('#voiceView:not([hidden])');
  await panel.fill('#voiceTypedInput', 'أكمل الفحص وأخبرني بالنتيجة');
  await panel.locator('#voiceTypedInput').press('Enter');
  await panel.waitForFunction(() => window.__spokenReplies.length > 0, { timeout: 30000 });
  assert.match(await panel.evaluate(() => window.__spokenReplies.at(-1)), /[\u0600-\u06ff]/);
  assert.deepEqual(errors, []);
  console.log('WORKSPACE PASSED: compact composer, Cairo/RTL, linked project, @file, hash-bound write, native command, live mode notice, multilingual transcription and full-agent spoken completion.');
} finally {
  await context.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
