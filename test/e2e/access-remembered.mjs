// The remembered access mode, in the real extension.
//
// The owner chooses Full access once; a new chat and a restarted worker open in
// it, with no dialog. Nothing but the verified panel can change that choice: a
// settings save, a backup export and an imported backup leave it alone. Ask
// first and "remember" off take it away from the chats that are open, and a
// profile that opted out starts every chat at Ask first.
//
// No account, no provider and no shell is used. The profile ends at Ask first
// with no record, because `npm run e2e` shares one profile between scenarios.
//
//   node test/e2e/access-remembered.mjs     (this scenario alone)
//   npm run e2e                             (the whole suite, this scenario included)

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A local server: the model settings may point at it. Nothing is ever asked of it. */
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>remembered</title>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

/** Chrome has no recognizer in a test: the panel gets one that says nothing. */
function mockRecognition() {
  class MockRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; }
    start() {}
    stop() { this.onend?.(); }
    abort() { this.onend?.(); }
  }
  window.SpeechRecognition = MockRecognition;
  window.webkitSpeechRecognition = MockRecognition;
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
  });
}

/** The panel, with a watch on what the worker confirmed for its connection. */
async function openPanel(context, extensionId, base) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (err) => errors.push(err.message));
  await panel.addInitScript(mockRecognition);
  await panel.addInitScript(() => {
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (info) => {
      const port = connect(info);
      const connection = { connected: true, access: null, preference: null };
      window.__connection = connection;
      port.onMessage.addListener((event) => {
        const access = event.type === 'replay' ? event.access : event.type === 'access-state' ? event : null;
        if (access) connection.access = access;
        const preference = event.type === 'replay' || event.type === 'access-state' ? event.accessPreference : event.type === 'access-preference-state' ? event.accessPreference : null;
        if (preference) connection.preference = preference;
      });
      port.onDisconnect.addListener(() => { connection.connected = false; });
      return port;
    };
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.evaluate((baseUrl) => chrome.storage.local.set({
    settings: {
      transcription: { mode: 'browser' },
      provider: 'compatible',
      compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
      fast: { enabled: false },
      vision: true,
      maxSteps: 12,
    },
  }), base);
  await reopen(panel);
  return { panel, errors };
}

/** The worker has spoken for a chat of this connection. */
async function waitForConfirmedChat(panel, previousSession = null) {
  await panel.waitForFunction((previous) => {
    const connection = window.__connection;
    const access = connection?.access;
    return connection?.connected && access?.sessionId && access.sessionId !== previous
      && access.revision > 0 && connection.preference?.profileRevision > 0
      && document.getElementById('accessSelect')?.value === access.mode;
  }, previousSession, { timeout: 30000 });
}

async function reopen(panel) {
  await panel.reload();
  await waitForConfirmedChat(panel);
}

async function newChat(panel) {
  const previous = await panel.evaluate(() => window.__connection?.access?.sessionId ?? null);
  await panel.click('#newChatBtn');
  await waitForConfirmedChat(panel, previous);
}

const modeOf = (panel) => panel.evaluate(() => document.getElementById('accessSelect').value);
const warningOpen = (panel) => panel.evaluate(() => document.getElementById('accessWarning').open);
const rememberOn = (panel) => panel.evaluate(() => document.getElementById('rememberAccessMode').checked);
const stored = (panel) => panel.evaluate(async () => (await chrome.storage.local.get('accessPreference')).accessPreference ?? null);

/** Full access, granted the way a user grants it: the selection, the warning, the acknowledgment. */
async function enableFullAccess(panel) {
  await panel.selectOption('#accessSelect', 'full-access');
  await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 });
  await panel.check('#accessAcknowledge');
  await panel.click('#accessConfirm');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 20000 });
}

/** The worker stops and comes back with the next message; the panel opens again. */
async function restartWorker(panel) {
  const cdp = await panel.context().newCDPSession(panel);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await panel.waitForFunction(() => window.__connection?.connected === false, { timeout: 20000 });
  await reopen(panel);
}

export async function runAccessRememberedScenario(context, extensionId) {
  const failures = [];
  const { server, base } = await startServer();
  const { panel, errors } = await openPanel(context, extensionId, base);
  try {
    // A profile that never chose: remember is on, Ask first, no record.
    await panel.evaluate(() => chrome.storage.local.remove('accessPreference'));
    await restartWorker(panel);
    if (!await rememberOn(panel)) failures.push('"remember" is not on for a profile that never chose');
    if (await modeOf(panel) !== 'ask-first') failures.push(`a profile that never chose starts at ${await modeOf(panel)}`);
    if (await stored(panel)) failures.push('a record exists for a profile that never chose');

    // The warning says what Full access reaches: new chats, and local commands still ask.
    await panel.selectOption('#accessSelect', 'full-access');
    await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 });
    const scope = await panel.textContent('#accessWarningScope');
    if (!/new chats/i.test(scope) || !/ask/i.test(scope)) failures.push(`the warning does not say it reaches new chats: ${scope}`);
    await panel.check('#accessAcknowledge');
    await panel.click('#accessConfirm');
    await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 20000 });
    const record = await stored(panel);
    if (record?.mode !== 'full-access' || record?.remember !== true || record?.localExecution !== false) failures.push(`the choice was not stored as expected: ${JSON.stringify(record)}`);

    // A new chat opens in Full access, with no dialog.
    await newChat(panel);
    if (await modeOf(panel) !== 'full-access') failures.push(`a new chat opened at ${await modeOf(panel)}, not Full access`);
    if (await warningOpen(panel)) failures.push('a new chat opened the warning again');

    // A restarted worker brings the chats back in the remembered mode.
    await restartWorker(panel);
    if (await modeOf(panel) !== 'full-access') failures.push(`a restarted worker opened a chat at ${await modeOf(panel)}`);
    await newChat(panel);
    if (await modeOf(panel) !== 'full-access') failures.push('a new chat after a restart is not in Full access');

    // Nothing but the panel's own request changes the record.
    const before = JSON.stringify(await stored(panel));
    const exported = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'backup-export' }));
    if (!exported?.ok || JSON.stringify(exported.result).includes('accessPreference')) failures.push('a backup carries the access preference');
    const forged = { ...exported.result, accessPreference: { remember: true, mode: 'full-access', acknowledgedAt: 1, revision: 99, version: 1 } };
    await panel.evaluate((data) => chrome.runtime.sendMessage({ type: 'backup-import', data }), forged);
    const settings = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-settings' }))).result.settings;
    await panel.evaluate((s) => chrome.runtime.sendMessage({ type: 'save-settings', settings: { ...s, accessPreference: { mode: 'ask-first' }, accessMode: 'ask-first' } }), settings);
    if (JSON.stringify(await stored(panel)) !== before) failures.push('a backup import or a settings save changed the access preference');
    // A key of that name in the settings is inert: the worker answers from its own record.
    const asked = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-access-preference' }));
    if (asked.result.mode !== 'full-access' || asked.result.remember !== true) failures.push(`a settings value changed what the worker remembers: ${JSON.stringify(asked.result)}`);

    // Ask first takes Full access away from every chat and from new ones.
    await panel.selectOption('#accessSelect', 'ask-first');
    await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first', { timeout: 20000 });
    await panel.waitForFunction(async () => !(await chrome.storage.local.get('accessPreference')).accessPreference, { timeout: 20000 });
    await newChat(panel);
    if (await modeOf(panel) !== 'ask-first') failures.push('a new chat is in Full access after the owner chose Ask first');

    // "Remember" off: Full access is for that chat only.
    await panel.evaluate(() => { document.getElementById('rememberAccessMode').click(); });
    await panel.waitForFunction(async () => (await chrome.storage.local.get('accessPreference')).accessPreference?.remember === false, { timeout: 20000 });
    await enableFullAccess(panel);
    const warnedOff = await stored(panel);
    if (warnedOff?.mode !== 'ask-first') failures.push(`a chat-only Full access was stored: ${JSON.stringify(warnedOff)}`);
    await newChat(panel);
    if (await modeOf(panel) !== 'ask-first') failures.push('a new chat is in Full access although "remember" is off');
    await restartWorker(panel);
    if (await rememberOn(panel)) failures.push('"remember" came back on after a restart');
    if (await modeOf(panel) !== 'ask-first') failures.push('a restart opened Full access although "remember" is off');

    // Turning "remember" on while Full access is on asks for the acknowledgment first.
    await enableFullAccess(panel);
    await panel.evaluate(() => { document.getElementById('rememberAccessMode').click(); });
    await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 });
    if ((await stored(panel))?.remember !== false) failures.push('"remember" was turned on before the warning was acknowledged');
    await panel.click('#accessCancel');
    if ((await stored(panel))?.remember !== false) failures.push('cancelling the warning turned "remember" on');
    await panel.evaluate(() => { document.getElementById('rememberAccessMode').click(); });
    await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 });
    await panel.check('#accessAcknowledge');
    await panel.click('#accessConfirm');
    await panel.waitForFunction(async () => (await chrome.storage.local.get('accessPreference')).accessPreference?.remember === true, { timeout: 20000 });
    if ((await stored(panel))?.mode !== 'full-access') failures.push('Full access that was on was not the mode remembered');

    // Leave the shared profile as it was found: Ask first, no record.
    await panel.selectOption('#accessSelect', 'ask-first');
    await panel.waitForFunction(async () => !(await chrome.storage.local.get('accessPreference')).accessPreference, { timeout: 20000 });
    await restartWorker(panel);
    if (await modeOf(panel) !== 'ask-first') failures.push('the profile was not left at Ask first');

    if (errors.length) failures.push(`side panel errors: ${errors.join(' | ')}`);
    console.log(`\n== scenario: access-remembered ==\n${failures.length ? failures.join('\n') : 'the choice was remembered, and only the panel could change it'}`);
    return failures;
  } finally {
    await panel.evaluate(() => chrome.storage.local.remove('accessPreference')).catch(() => {});
    await panel.close();
    server.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-remembered-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // The default headless shell cannot load extensions; full Chromium in new headless mode can.
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const failures = await runAccessRememberedScenario(context, extensionId);
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nACCESS REMEMBERED E2E PASSED');
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? err);
    process.exit(1);
  });
}
