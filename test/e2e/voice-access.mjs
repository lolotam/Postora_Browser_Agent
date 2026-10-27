// The voice path in the real extension: the spoken command, the question the
// worker asks about it, and the one card the user answers.
//
// The scenarios drive the real panel and the real worker, through the real
// browser of the panel — the payload the panel sends is the payload the worker
// reads. The recognition is mocked (Chrome has no speech service in a test),
// the fast decision endpoint is local, and every value on the page is
// synthetic: no account, no provider, no microphone and no shell is ever used.
//
// The voice path asks the same authority the chat asks: the card is the shared
// one in the chat, not the old box of the voice screen. The old box never
// appears, in any mode.
//
//   node test/e2e/voice-access.mjs        (this scenario alone)
//   npm run e2e                           (the whole suite, this scenario included)
//   E2E_EXTENSION_DIR=/path/to/unpacked-store-build node test/e2e/voice-access.mjs

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The page the voice path acts on: synthetic values only, a local file.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/postora-voice-fixture.html');

// ---------- the mock fast layer ----------

/**
 * The decision endpoint of the fast layer.
 *
 * It answers the questions of the voice path: which action the command means,
 * which element on the page it means, and which span of the command is the
 * argument.
 */
function jevAnswer(body) {
  const command = String(body.state?.spoken_command ?? '');
  const lower = command.toLowerCase();
  const wanted = lower.includes('read') ? 'read_field'
    : lower.includes('enter') ? 'press_enter'
    : lower.includes('terminal') ? 'insert_text'
      : lower.includes('scroll') ? 'scroll_down'
        : lower.includes('type') ? 'type_text'
          : 'click';
  const answers = {};
  for (const [name, question] of Object.entries(body.questions)) {
    if (question.type !== 'choice') {
      answers[name] = { type: 'noul', noul: 0.05 };
      continue;
    }
    const keys = Object.keys(question.criteria);
    let pick = null;
    if (name === 'action' && keys.includes(wanted)) pick = wanted;
    else if (name === 'element' && (lower.includes('password') || lower.includes('code'))) {
      // The field that holds a secret is named by what the page calls it.
      const label = lower.includes('password') ? /\bpassword\b/i : /one-time code/i;
      pick = Object.entries(question.criteria).find(([, text]) => label.test(text))?.[0] ?? null;
    } else if (name === 'argument') {
      // The value that is written is the marker in the command, not the whole
      // sentence.
      const value = command.match(/\bTEST_[A-Z_]+\b/)?.[0];
      pick = Object.entries(question.criteria).find(([, text]) => value && text === JSON.stringify(value))?.[0] ?? null;
    }
    if (!pick) pick = keys.find((key) => key !== 'none') ?? 'none';
    answers[name] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: { [pick]: 0.95 } };
  }
  return { model: 'jev-mock', answers };
}

// ---------- the local server ----------

async function startServer() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const counts = { jev: 0, llm: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        if (req.url === '/voice') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
          return;
        }
        if (req.url === '/v1/systemone') {
          const body = JSON.parse(raw || '{}');
          counts.jev += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(jevAnswer(body)));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          // The main model: the fast-only voice path must never reach it.
          counts.llm += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500).end(String(err.message));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    counts,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

// ---------- the panel ----------

/** Chrome has no recognizer in a test: the panel gets one that says what the test tells it. */
function mockRecognition() {
  class MockRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.started = false; }
    start() { this.started = true; window.__recognition = this; }
    stop() { this.started = false; this.onend?.(); }
    abort() { this.started = false; this.onend?.(); }
  }
  window.SpeechRecognition = MockRecognition;
  window.webkitSpeechRecognition = MockRecognition;
  window.__say = (text) => window.__recognition?.onresult?.({
    resultIndex: 0,
    results: [Object.assign([{ transcript: text }], { isFinal: true })],
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
  });
}

/**
 * The panel, watched.
 *
 * The test sees every card the worker drew and every answer the panel sent.
 * Nothing of the extension is changed: the panel is only read.
 */
async function openPanel(context, extensionId, base) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (err) => errors.push(err.message));
  await panel.addInitScript(mockRecognition);
  await panel.addInitScript(() => {
    window.__cards = 0;
    window.__posted = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (info) => {
      const port = connect(info);
      const post = port.postMessage.bind(port);
      port.postMessage = (message) => { window.__posted.push(message); return post(message); };
      return port;
    };
    const watch = () => {
      const node = document.getElementById('approvals');
      if (!node) { setTimeout(watch, 50); return; }
      new MutationObserver((records) => {
        for (const record of records) {
          for (const child of record.addedNodes) {
            if (child.classList?.contains('permission-request')) window.__cards += 1;
          }
        }
      }).observe(node, { childList: true });
    };
    watch();
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.evaluate((baseUrl) => chrome.storage.local.set({
    settings: {
      provider: 'compatible',
      compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
      fast: { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: baseUrl },
      voiceEngine: 'fast_only',
      vision: true,
      maxSteps: 12,
    },
  }), base);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value);
  return { panel, errors };
}

/** The cards that are on the screen. */
const cardCount = (panel) => panel.evaluate(() => document.querySelectorAll('#approvals .permission-request').length);

/** The card the worker drew, and what it says. */
async function waitForCard(panel, { timeout = 25000 } = {}) {
  await panel.waitForFunction(() => document.querySelectorAll('#approvals .permission-request').length > 0, { timeout });
  return panel.evaluate(() => {
    const card = document.querySelector('#approvals .permission-request');
    return {
      text: card?.textContent ?? '',
      allow: Boolean(card?.querySelector('.permission-allow')),
      deny: Boolean(card?.querySelector('.permission-deny')),
    };
  });
}

/** The counters of the panel start again: this step is measured on its own. */
const resetCounters = (panel) => panel.evaluate(() => { window.__cards = 0; window.__posted = []; });

/** The old box of the voice screen is never used any more. */
const oldApprovalShown = async (panel) => panel.evaluate(() => {
  const box = document.getElementById('voiceApproval');
  return Boolean(box) && !box.hidden && box.textContent.trim().length > 0;
});

/** The entries of the activity log of the voice screen. */
const logEntries = (panel) => panel.$$eval('#voiceLog .voice-entry', (rows) => rows.map((row) => row.textContent));

/** The page starts again: nothing of the step before is left on it. */
async function resetPage(target) {
  await target.reload();
  await target.waitForFunction(() => Boolean(document.getElementById('go')));
}

/** The voice screen, and the chat behind it. */
async function openVoice(panel) {
  await panel.click('#voiceToggle');
  await panel.waitForSelector('#voiceView:not([hidden])');
}

async function backToChat(panel) {
  await panel.click('#voiceBackBtn');
  await panel.waitForSelector('#voiceView', { state: 'hidden' });
}

// ---------- the scenarios ----------

/**
 * Ask first: the worker asks about the spoken click, and a refusal changes
 * nothing.
 */
async function askFirstRefuses(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('click go'));

  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken click');
    return;
  }
  if (!card.allow || !card.deny) failures.push('the card has no Allow and Deny');
  if (!/Go/.test(card.text)) failures.push(`the card does not name the element: ${card.text}`);
  if (await oldApprovalShown(panel)) failures.push('the old box of the voice screen was shown');

  await panel.click('#approvals .permission-request .permission-deny');
  await panel.waitForFunction(() => document.querySelectorAll('#approvals .permission-request').length === 0, { timeout: 15000 }).catch(() => {});
  await target.waitForTimeout(400);
  if ((await target.textContent('#out')) !== '') failures.push('the page was clicked although the answer was no');
}

/**
 * Ask first: the same command runs once the user allows it.
 */
async function allowOnceRunsOneAction(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('click go'));

  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken click');
    return;
  }
  await panel.click('#approvals .permission-request .permission-allow');
  await target.waitForFunction(() => document.getElementById('out')?.textContent === 'clicked', { timeout: 20000 }).catch(() => {});
  if ((await target.textContent('#out')) !== 'clicked') failures.push('the allowed click did not happen');
  const trusted = await target.evaluate(() => window.__trusted ?? []);
  if (!trusted.includes('trusted')) failures.push(`the click was not a trusted input: ${JSON.stringify(trusted)}`);
}

/**
 * Ask first: a spoken scroll of the page goes through the worker as well.
 */
async function scrollGoesThroughTheWorker(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('scroll down'));

  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken scroll: ' + JSON.stringify(await logEntries(panel)));
    return;
  }
  await panel.click('#approvals .permission-request .permission-allow');
  await target.waitForFunction(() => window.scrollY > 0, { timeout: 20000 }).catch(() => {});
  const scrolled = await target.evaluate(() => window.scrollY);
  if (!(scrolled > 0)) failures.push('the page was not scrolled');
}

/**
 * Ask first: a spoken write into the field that holds a secret asks, and the
 * written value is the one that was asked for.
 */
async function secretWriteAsks(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('type TEST_WRITTEN_VALUE into the password field'));

  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken write: ' + JSON.stringify(await logEntries(panel)));
    return;
  }
  if (!/Password/i.test(card.text)) failures.push(`the card does not name the field: ${card.text}`);
  if (/TEST_WRITTEN_VALUE/.test(card.text)) failures.push('the card shows the value that was going to be written');

  await panel.click('#approvals .permission-request .permission-allow');
  await target.waitForFunction(() => document.getElementById('pw')?.value === 'TEST_WRITTEN_VALUE', { timeout: 20000 }).catch(() => {});
  const fields = await target.evaluate(() => ({
    search: document.getElementById('search').value,
    password: document.getElementById('pw').value,
    code: document.getElementById('code').value,
  }));
  if (fields.password !== 'TEST_WRITTEN_VALUE') failures.push('the secret field was not written into');
  if (fields.search) failures.push('the text went into another field');
   if (fields.code !== 'TEST_ONLY_OTP') failures.push('the one-time code field was written into');
  const trusted = await target.evaluate(() => window.__trusted ?? []);
  if (!trusted.some((entry) => entry.startsWith('pw:trusted'))) failures.push(`the value was not typed with real input: ${JSON.stringify(trusted)}`);
}

/**
 * Ask first: a spoken read of the same field asks, and only the allowed read
 * brings the value back.
 */
async function secretReadAsks(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('read the password field'));

  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken read');
    return;
  }
  if (!/Password/i.test(card.text)) failures.push(`the card does not name the field: ${card.text}`);
  if (/TEST_ONLY_PASSWORD/.test(card.text)) failures.push('the card shows the value of the field');

  await panel.click('#approvals .permission-request .permission-allow');
  await panel.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#voiceLog .voice-entry')];
    return rows.some((row) => row.textContent.includes('TEST_ONLY_PASSWORD'));
  }, { timeout: 25000 }).catch(() => {});

  const entries = await logEntries(panel);
  if (!entries.some((text) => text.includes('TEST_ONLY_PASSWORD'))) {
    failures.push(`the value of the field did not come back: ${JSON.stringify(entries)}`);
  }
  const fields = await target.evaluate(() => ({
    search: document.getElementById('search').value,
    password: document.getElementById('pw').value,
  }));
  if (fields.search) failures.push('a read wrote into a field');
  if (fields.password !== 'TEST_ONLY_PASSWORD') failures.push('the field was changed by the read');
}

/**
 * A web terminal: the text goes into the field that has the focus, and the
 * Enter that follows is real input.
 */
async function terminalTakesTheText(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);

  // The terminal takes the focus, the way it does in a browser.
  await target.click('#terminal');
  await target.waitForFunction(() => document.activeElement?.id === 'terminalInput', { timeout: 10000 }).catch(() => {});
  const focused = await target.evaluate(() => document.activeElement?.id ?? '');
  if (focused !== 'terminalInput') {
    failures.push(`the terminal did not take the focus (${focused})`);
    return;
  }

  await panel.evaluate(() => window.__say('type TEST_TERMINAL_COMMAND in the terminal'));
  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken terminal command');
    return;
  }
  await panel.click('#approvals .permission-request .permission-allow');
  await target.waitForFunction(() => document.getElementById('terminalInput')?.value === 'TEST_TERMINAL_COMMAND', { timeout: 20000 }).catch(() => {});
  const typed = await target.evaluate(() => document.getElementById('terminalInput').value);
  if (typed !== 'TEST_TERMINAL_COMMAND') failures.push(`the terminal did not get the text (${typed})`);
  const trusted = await target.evaluate(() => window.__trusted ?? []);
  if (!trusted.some((entry) => entry.startsWith('terminalInput:trusted'))) {
    failures.push(`the terminal did not get real input: ${JSON.stringify(trusted)}`);
  }

  // The Enter that follows is real input as well.
  await panel.evaluate(() => window.__say('press enter in the terminal'));
  const second = await waitForCard(panel).catch(() => null);
  if (!second) {
    failures.push('the worker did not ask about the spoken Enter');
    return;
  }
  await panel.click('#approvals .permission-request .permission-allow');
  await target.waitForFunction(() => (window.__commands ?? []).includes('TEST_TERMINAL_COMMAND'), { timeout: 20000 }).catch(() => {});
  const commands = await target.evaluate(() => window.__commands ?? []);
  if (!commands.includes('TEST_TERMINAL_COMMAND')) failures.push(`the terminal did not run the command: ${JSON.stringify(commands)}`);
}

/**
 * Full access: the warning is shown, the user agrees, and the spoken click
 * runs without any question.
 */
async function fullAccessAsksNothing(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);

  // The access control lives in the chat: the voice screen goes back first.
  await backToChat(panel);

  // The warning is the real one: the user has to read it and agree.
  await panel.selectOption('#accessSelect', 'full-access');
  await panel.waitForSelector('#accessWarning[open]', { timeout: 10000 }).catch(() => {});
  const warning = await panel.textContent('#accessWarning').catch(() => '');
  if (!/Full access/i.test(warning)) failures.push('the warning does not say what Full access is');
  await panel.check('#accessAcknowledge');
  await panel.click('#accessConfirm');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 }).catch(() => {});

  // The voice screen again, and the spoken click runs without a question.
  await openVoice(panel);
  await panel.evaluate(() => window.__say('click go'));
  await target.waitForFunction(() => document.getElementById('out')?.textContent === 'clicked', { timeout: 25000 }).catch(() => {});
  if ((await target.textContent('#out')) !== 'clicked') failures.push('the click did not run under Full access');
  if ((await cardCount(panel)) !== 0) failures.push('Full access asked the user anyway');
  if (await oldApprovalShown(panel)) failures.push('the old box of the voice screen was shown');

  // The mode goes back to Ask first for the next step.
  await backToChat(panel);
  await panel.selectOption('#accessSelect', 'ask-first');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first', { timeout: 10000 }).catch(() => {});
  await openVoice(panel);
}

/**
 * The real Stop of the voice screen: the command is withdrawn while the
 * question is open, and nothing runs.
 */
async function stopWithdrawsTheQuestion(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await panel.evaluate(() => window.__say('click go'));
  const card = await waitForCard(panel).catch(() => null);
  if (!card) {
    failures.push('the worker did not ask about the spoken click');
    return;
  }

  // The Stop of the voice screen: the back button cancels the command that is
  // running, with its question.
  await panel.click('#voiceBackBtn');
  await panel.waitForSelector('#voiceView', { state: 'hidden' });
  await panel.waitForFunction(() => document.querySelectorAll('#approvals .permission-request').length === 0, { timeout: 15000 }).catch(() => {});
  const cards = await cardCount(panel);
  if (cards !== 0) failures.push('the question was still open after the command was stopped');
  await target.waitForTimeout(500);
  if ((await target.textContent('#out')) !== '') failures.push('the page was clicked although the command was stopped');

  // The voice screen again, for the steps that follow.
  await openVoice(panel);
}

// ---------- the scenario ----------

export async function runVoiceAccessScenario(context, extensionId) {
  const failures = [];
  const { server, counts, base } = await startServer();
  const { panel, errors } = await openPanel(context, extensionId, base);
  let target = null;
  try {
    target = await context.newPage();
    await target.goto(`${base}/voice`);
    await target.bringToFront();

    // The composer microphone opens the voice screen.
    await openVoice(panel);

    await askFirstRefuses(panel, target, failures);
    await allowOnceRunsOneAction(panel, target, failures);
    await scrollGoesThroughTheWorker(panel, target, failures);
    await secretWriteAsks(panel, target, failures);
    await secretReadAsks(panel, target, failures);
    await terminalTakesTheText(panel, target, failures);
    await fullAccessAsksNothing(panel, target, failures);
    await stopWithdrawsTheQuestion(panel, target, failures);

    // The fast-only engine never asks the main model.
    if (counts.llm !== 0) failures.push(`the main model was asked ${counts.llm} times by the fast-only voice path`);

    if (errors.length) failures.push(`side panel errors: ${errors.join(' | ')}`);
    console.log(`\n== scenario: voice-access ==\nfast calls: ${counts.jev}, main calls: ${counts.llm}\n${failures.length ? failures.join('\n') : 'the voice path asked the worker'}`);
    return failures;
  } finally {
    await target?.close();
    await panel.close();
    server.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-voice-access-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    colorScheme: process.env.E2E_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // The default headless shell cannot load extensions; full Chromium in new headless mode can.
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const failures = await runVoiceAccessScenario(context, extensionId);
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nVOICE ACCESS E2E PASSED');
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
