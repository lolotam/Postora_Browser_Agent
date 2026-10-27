// The access runtime in the real extension: the approvals the worker asks for,
// the mode that changes them, and the promise that nothing runs that the user
// did not allow.
//
// The scenarios drive the real panel and the real worker. The model is a local
// mock, the page is a local fixture, and every value on it is synthetic: no
// account, no provider, no microphone and no shell is ever used.
//
//   node test/e2e/access-runtime.mjs        (this scenario alone)
//   npm run e2e                             (the whole suite, this scenario included)
//   E2E_SCREENSHOTS=out npm run e2e         (the panel is saved after every step)

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The screenshots of a reviewer run go to the approved temp folder: on this
// machine, and in the temp folder of the system everywhere else.
const SHOT_DIR = process.env.E2E_SCREENSHOTS || (process.platform === 'win32'
  ? path.join('E:/Dev/Temp/opencode', 'chat-permissions-access-runtime')
  : path.join(os.tmpdir(), 'chat-permissions-access-runtime'));
// The page the agent acts on: synthetic values only, a local file.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/postora-permissions-fixture.html');

// The values the fixture holds. Only the one the user asked for may travel.
const SECRET = 'TEST_ONLY_PASSWORD';
const OTHER_SECRETS = ['TEST_ONLY_OTP', 'TEST_ONLY_TOKEN'];
// The value the task asks to be written into the selected field: synthetic,
// and named by the task itself.
const WRITTEN = 'POSTORA-WRITE-SECRET';

// ---------- the mock model ----------

/** The index of an element in the last page state the model was given. */
function indexOf(last, label) {
  const found = last.match(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`));
  return found ? Number(found[1]) : -1;
}

/**
 * One script per task, driven by the tool results the model gets.
 *
 * The mode in the task text says which script runs: the test drives the panel
 * around it, and the script only says what the model tries to do.
 */
function scriptFor(mode, turn, last) {
  const message = indexOf(last, 'Message');
  const terminal = indexOf(last, 'Web terminal');
  const password = indexOf(last, 'Password');
  const send = indexOf(last, 'Send message');
  const report = (extra) => ['done', { success: true, report: `## Done\n${extra}\n- tool said: ${last.trim().slice(0, 300)}` }];
  switch (mode) {
    case 'deny':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['type_text', { index: message, text: 'DENIED-TEXT' }];
      return report('- asked to type');
    case 'allow':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['type_text', { index: message, text: 'ALLOWED-TEXT' }];
      if (turn === 2) return ['click', { index: send }];
      return report('- typed and asked to send');
    case 'full':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['type_text', { index: message, text: 'FULL-TEXT' }];
      if (turn === 2) return ['click', { index: send }];
      // The value that is already there, read on purpose.
      if (turn === 3) return ['read_field', { index: password }];
      // The element list again: a read reports the value, not the page.
      if (turn === 4) return ['read_page', {}];
      // The value the task asked to be written into that one field.
      if (turn === 5) return ['type_text', { index: password, text: WRITTEN }];
      // And the read back of what was written.
      if (turn === 6) return ['read_field', { index: password }];
      if (turn === 7) return ['done', { success: true, report: `## Done\n- read back: ${last.trim().slice(0, 300)}` }];
      return report('- done');
    case 'secret':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['read_field', { index: password }];
      return report('- asked to read the field');
    case 'terminal':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['click', { index: terminal }];
      if (turn === 2) return ['insert_text', { text: 'qa-command' }];
      if (turn === 3) return ['press_key', { key: 'Enter' }];
      return report('- used the terminal');
    case 'stop':
      if (turn === 0) return ['read_page', {}];
      if (turn === 1) return ['type_text', { index: message, text: 'STOPPED-TEXT' }];
      return report('- asked to type');
    default:
      return report('- nothing');
  }
}

/** The mock model server: one body per request, so a test can read them. */
function startServer() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const bodies = [];
  const counts = { llm: 0, jev: 0 };
  const turns = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        if (req.url === '/page' || req.url.startsWith('/page?')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
          return;
        }
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          const body = JSON.parse(raw);
          bodies.push(body);
          counts.llm += 1;
          const first = body.messages.find((m) => m.role === 'user');
          const task = typeof first?.content === 'string' ? first.content : '';
          const mode = task.match(/MODE:([a-z]+)/)?.[1] ?? 'deny';
          const turn = turns.get(task) ?? 0;
          turns.set(task, turn + 1);
          const last = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
          const [name, args] = scriptFor(mode, turn, last);
          const id = `call_${counts.llm}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        if (req.url === '/v1/systemone') {
          const body = JSON.parse(raw);
          counts.jev += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(jevAnswer(body)));
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        console.error(err.message);
        res.writeHead(500).end(err.message);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    bodies,
    counts,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

/**
 * The mock fast layer: it types into the message field.
 *
 * The fast layer runs the same executor as the model, so its step asks for the
 * same approval.
 */
function jevAnswer(body) {
  const elements = body.state.INTERACTIVE_ELEMENTS;
  const pick = (picked) => ({ type: 'choice', choice: picked, confidence: 0.95, probabilities: { [picked]: 0.97 } });
  const target = /^(e\d+): input[^\n]*"Message"/m.exec(elements)?.[1] ?? 'none';
  const answers = {
    operation: pick('type'),
    target: pick(target),
    text: pick('t0'),
    goal_done: { type: 'noul', noul: 0.05 },
    risky: { type: 'noul', noul: 0.02 },
  };
  return { model: 'jev-mock', answers };
}

// ---------- the panel ----------

/** Chrome has no recognizer in a test: the panel gets one that says nothing. */
function mockRecognition() {
  class MockRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.started = false; }
    start() { this.started = true; window.__recognition = this; }
    stop() { this.started = false; this.onend?.(); }
    abort() { this.started = false; this.onend?.(); }
  }
  window.SpeechRecognition = MockRecognition;
  window.webkitSpeechRecognition = MockRecognition;
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
  });
}

/**
 * The panel, watched.
 *
 * The test sees every answer the panel sends and every card the worker asked
 * for. Nothing of the extension is changed: the panel is only read.
 */
async function openPanel(context, extensionId, base, { fast = false } = {}) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (err) => errors.push(err.message));
  await panel.addInitScript(mockRecognition);
  await panel.addInitScript(() => {
    // Every answer the panel sends, so a duplicate can be seen.
    window.__posted = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (info) => {
      const port = connect(info);
      const post = port.postMessage.bind(port);
      port.postMessage = (message) => { window.__posted.push(message); return post(message); };
      return port;
    };
    // Every card the worker asked for, so "no prompt at all" can be checked.
    window.__cards = 0;
    // What every card said right after it was answered.
    window.__statuses = [];
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
      // The click of the user is answered by the card itself; this listener
      // runs after it, so it sees the card as it is right after the answer.
      node.addEventListener('click', (event) => {
        const card = event.target.closest?.('.permission-request');
        if (!card) return;
        window.__statuses.push({
          status: card.querySelector('.permission-status')?.textContent ?? '',
          disabled: card.querySelector('.permission-allow')?.disabled ?? false,
        });
      });
    };
    watch();
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.evaluate(([baseUrl, fastOn]) => chrome.storage.local.set({
    settings: {
      provider: 'compatible',
      compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
      fast: fastOn
        ? { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: baseUrl }
        : { enabled: false },
      vision: true,
      maxSteps: 12,
    },
  }), [base, fast]);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value);
  return { panel, errors };
}

/** The cards that are on the screen. */
const cardCount = (panel) => panel.evaluate(() => document.querySelectorAll('#approvals .permission-request').length);

/** The counters of the panel start again: this step is measured on its own. */
const resetCounters = (panel) => panel.evaluate(() => {
  window.__cards = 0;
  window.__posted = [];
  window.__statuses = [];
});

/** The page starts again: nothing of the step before is left on it. */
async function resetPage(target) {
  await target.reload();
  await target.waitForFunction(() => Boolean(window.qa));
}

/** The text of the shared area, as the user sees it. */
const cardText = (panel) => panel.textContent('#approvals');

/** The card the worker asked for, and the button of it. */
const waitForCard = (panel, timeout = 30000) => panel.waitForSelector('#approvals .permission-request', { timeout });

/** The heading of the card that is on the screen: every card has its own. */
async function cardHeading(panel) {
  return panel.evaluate(() => document.querySelector('#approvals .permission-request')?.getAttribute('aria-labelledby') ?? null);
}

/** That card is gone: the worker settled it. */
const cardGone = (panel, heading) => panel.waitForFunction((id) => !document.getElementById(id), heading, { timeout: 20000 });

/** No card is on the screen at all. */
const noCards = (panel) => panel.waitForFunction(() => document.querySelectorAll('#approvals .permission-request').length === 0, { timeout: 20000 });

/**
 * Full access, granted the way a user grants it: the selection, the warning,
 * the acknowledgment and the confirmation. Nothing is granted behind the
 * panel's back.
 */
async function enableFullAccess(panel) {
  await panel.selectOption('#accessSelect', 'full-access');
  await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 });
  await panel.check('#accessAcknowledge');
  await panel.click('#accessConfirm');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 20000 });
}

/** A new chat of the panel: the mode of a new chat is Ask first. */
async function newChat(panel) {
  // The task of the chat before must be over: a session may not take the tab
  // of another one, and the task that is still running holds it.
  await panel.waitForFunction(() => document.getElementById('stopBtn')?.hidden === true, { timeout: 90000 });
  await panel.click('#newChatBtn');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first', { timeout: 20000 });
}

/** The picture of the panel, for a reviewer. */
async function shot(panel, file) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await panel.bringToFront();
  await panel.evaluate(() => { document.documentElement.style.opacity = '0.999'; });
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: path.join(SHOT_DIR, file) });
  await panel.evaluate(() => { document.documentElement.style.opacity = ''; });
}

/** The mode the worker confirmed, as the panel shows it. */
const modeState = (panel) => panel.evaluate(() => ({
  value: document.getElementById('accessSelect')?.value,
  risk: document.getElementById('accessRisk')?.hidden,
  state: document.getElementById('accessState')?.textContent?.trim(),
}));

// ---------- the scenarios ----------

/**
 * The default is Ask first, and a refusal changes nothing.
 *
 * The worker asks for one action, the card says what it is about, and the
 * refusal leaves the page exactly as it was.
 */
async function askFirstDenies(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:deny Type the message and report what happened');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  const asked = await cardText(panel);
  if (!/Type text into a field/i.test(asked)) failures.push(`the card does not name the action: ${asked}`);
  if (!/127\.0\.0\.1/.test(asked)) failures.push(`the card does not name the site: ${asked}`);
  for (const secret of [SECRET, ...OTHER_SECRETS]) {
    if (asked.includes(secret)) failures.push(`the card shows a value of the page: ${secret}`);
  }
  const buttons = await panel.evaluate(() => [...document.querySelectorAll('#approvals .permission-request button')].map((b) => b.textContent.trim()));
  if (buttons.length !== 2) failures.push(`the card has ${buttons.length} buttons`);

  await panel.click('#approvals .permission-deny');
  const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
  const report = await final.innerText();
  if (!/did not allow/i.test(report)) failures.push(`the report does not say the action was refused: ${report}`);

  const page = await target.evaluate(() => ({
    message: document.getElementById('message')?.value,
    sent: window.qa.sent,
  }));
  if (page.message !== 'original message') failures.push(`the page was written into although the action was refused: ${page.message}`);
  if (page.sent !== 0) failures.push(`the page was clicked although the action was refused: ${page.sent}`);
  if ((await cardCount(panel)) !== 0) failures.push('the card is still on the screen after the refusal');
  return report;
}

/**
 * Allow once runs that one action, and only that one.
 *
 * The next action asks again: the approval is for one action, not for the task.
 */
async function allowOnceRunsOneAction(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:allow Type the message, press Send and report the result');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  const first = await cardHeading(panel);
  await panel.click('#approvals .permission-allow');
  // The answer is on its way: the card waits for the worker to settle it.
  const said = await panel.evaluate(() => window.__statuses.at(-1) ?? null);
  if (!said || !/on its way/i.test(said.status)) failures.push(`the card does not say the answer is on its way: ${JSON.stringify(said)}`);
  if (said && said.disabled !== true) failures.push('the card does not close its buttons while the answer is on its way');
  await cardGone(panel, first);

  // The second action asks again.
  await waitForCard(panel);
  const typed = await target.evaluate(() => document.getElementById('message')?.value);
  if (typed !== 'ALLOWED-TEXT') failures.push(`the approved action did not run: ${typed}`);
  const sent = await target.evaluate(() => window.qa.sent);
  if (sent !== 0) failures.push('the second action ran although it was not approved');

  await panel.click('#approvals .permission-deny');
  const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
  const report = await final.innerText();
  if (!/did not allow/i.test(report)) failures.push(`the report does not say the second action was refused: ${report}`);
  if ((await target.evaluate(() => window.qa.sent)) !== 0) failures.push('the page was clicked although the second action was refused');
  return report;
}

/**
 * Full access, granted through the real consent, asks nothing.
 *
 * The page is really changed, the field the task asked for is really read, and
 * only the value that was asked for travels to the provider.
 */
async function fullAccessAsksNothing(panel, target, bodies, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await enableFullAccess(panel);
  const granted = await modeState(panel);
  if (granted.value !== 'full-access') failures.push('the mode did not become Full access');
  if (granted.risk !== false) failures.push('the risk of Full access is not shown');

  await target.bringToFront();
  const before = bodies.length;
  await panel.fill('#input', `MODE:full Type the message, press Send, read the password field, write ${WRITTEN} into it and read it back`);
  await panel.click('#sendBtn');
  const final = await panel.waitForSelector('.msg.final', { timeout: 90000 });
  const report = await final.innerText();

  const cards = await panel.evaluate(() => window.__cards);
  if (cards !== 0) failures.push(`Full access asked ${cards} times`);
  const page = await target.evaluate(() => ({
    message: document.getElementById('message')?.value,
    sent: window.qa.sent,
    password: document.getElementById('password')?.value,
  }));
  if (page.message !== 'FULL-TEXT') failures.push(`the page was not written into: ${page.message}`);
  if (page.sent !== 1) failures.push(`the button was not pressed: ${page.sent}`);
  // The selected field really holds the value the task asked for.
  if (page.password !== WRITTEN) failures.push(`the selected field was not written into: ${page.password}`);
  if (!report.includes(WRITTEN)) failures.push('the report does not carry the value that was read back');

  // What the provider was told: the mode, the values the task asked for, and
  // nothing else that the page holds.
  const request = JSON.stringify(bodies.slice(before));
  if (!/Full access/.test(request)) failures.push('the provider was not told that the mode is Full access');
  if (!request.includes(SECRET)) failures.push('the value the task asked to read did not reach the provider');
  if (!request.includes(WRITTEN)) failures.push('the value the task asked to write did not reach the provider');
  for (const secret of OTHER_SECRETS) {
    if (request.includes(secret)) failures.push(`a value the task did not ask for reached the provider: ${secret}`);
  }
  return report;
}

/**
 * The selected field under Ask first: the value is read only when the user
 * says so, and the preview never shows it.
 */
async function askSelectedRead(panel, target, bodies, failures) {
  // Refused: the value stays on the page and never reaches the provider.
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  let before = bodies.length;
  await panel.fill('#input', 'MODE:secret-deny Read the value of the password field and report it');
  await panel.click('#sendBtn');
  await waitForCard(panel);
  const asked = await cardText(panel);
  if (!/Read the value of a field/i.test(asked)) failures.push(`the card does not name the read: ${asked}`);
  if (!/Password/.test(asked)) failures.push(`the card does not name the field: ${asked}`);
  for (const secret of [SECRET, WRITTEN, ...OTHER_SECRETS]) {
    if (asked.includes(secret)) failures.push(`the preview shows a value of the page: ${secret}`);
  }
  await panel.click('#approvals .permission-deny');
  const refused = await panel.waitForSelector('.msg.final', { timeout: 60000 });
  if (!/did not allow/i.test(await refused.innerText())) failures.push('the report does not say the read was refused');
  const denied = JSON.stringify(bodies.slice(before));
  if (denied.includes(SECRET)) failures.push('the value of the field reached the provider although the read was refused');

  // Allowed: the same read, and the value travels.
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  before = bodies.length;
  await panel.fill('#input', 'MODE:secret-allow Read the value of the password field and report it');
  await panel.click('#sendBtn');
  await waitForCard(panel);
  await panel.click('#approvals .permission-allow');
  const allowed = await panel.waitForSelector('.msg.final', { timeout: 60000 });
  const report = await allowed.innerText();
  if (!report.includes(SECRET)) failures.push('the value that was allowed did not reach the report');
  const granted = JSON.stringify(bodies.slice(before));
  if (!granted.includes(SECRET)) failures.push('the value that was allowed did not reach the provider');
  for (const secret of OTHER_SECRETS) {
    if (granted.includes(secret)) failures.push(`a value the task did not ask for reached the provider: ${secret}`);
  }
  return report;
}

/**
 * The web terminal: the text goes into the hidden field of the page, as real
 * input, and Enter runs it.
 */
async function webTerminalAsksForEachStep(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:terminal Use the web terminal to run a command and report the result');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  const asked = await cardText(panel);
  if (!/terminal/i.test(asked)) failures.push(`the card does not warn about the web terminal: ${asked}`);
  const first = await cardHeading(panel);
  await panel.click('#approvals .permission-allow');
  await cardGone(panel, first);

  await waitForCard(panel);
  const second = await cardHeading(panel);
  await panel.click('#approvals .permission-allow');
  await cardGone(panel, second);

  await waitForCard(panel);
  const third = await cardHeading(panel);
  await panel.click('#approvals .permission-allow');
  await cardGone(panel, third);

  const final = await panel.waitForSelector('.msg.final', { timeout: 90000 });
  const report = await final.innerText();
  const terminal = await target.evaluate(() => ({
    commands: window.qa.commands,
    trusted: window.qa.trustedInputs,
    output: document.getElementById('terminalOutput')?.textContent ?? '',
  }));
  if (!terminal.commands.includes('qa-command')) failures.push(`the terminal did not get the command: ${JSON.stringify(terminal.commands)}`);
  if (!terminal.trusted.includes('terminalInput')) failures.push('the terminal did not get real input');
  if (!/MOCK OUTPUT/.test(terminal.output)) failures.push(`the terminal did not run: ${terminal.output}`);
  return report;
}

/**
 * The mode that changes takes the approval with it, and nothing runs later.
 */
async function modeChangeClearsTheApproval(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:stop-mode Type the message and report what happened');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  // The user raises the mode while the question is open: the worker withdraws
  // the question of the old mode, and the card goes with it.
  await enableFullAccess(panel);
  await noCards(panel);
  const typed = await target.evaluate(() => document.getElementById('message')?.value);
  if (typed !== 'original message') failures.push(`the action ran although the mode changed: ${typed}`);
  return typed;
}

/**
 * Stop takes the approval with it too.
 */
async function stopClearsTheApproval(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:stop-stop Type the message and report what happened');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  await panel.click('#stopBtn');
  await noCards(panel);
  await panel.waitForTimeout(800);
  const typed = await target.evaluate(() => document.getElementById('message')?.value);
  if (typed !== 'original message') failures.push(`the action ran although the task was stopped: ${typed}`);
  return typed;
}

/**
 * An approval never eats the draft of the user, and never the files.
 */
async function approvalKeepsTheDraft(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:stop-draft Type the message and report what happened');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  // The user keeps writing while the question is open.
  await panel.fill('#input', 'a draft that must survive');
  await panel.setInputFiles('#fileInput', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('a file that must survive'),
  });
  await panel.waitForSelector('#fileChips li', { timeout: 10000 });
  await panel.click('#approvals .permission-deny');
  await noCards(panel);

  const kept = await panel.evaluate(() => ({
    draft: document.getElementById('input')?.value,
    files: [...document.querySelectorAll('#fileChips li')].map((li) => li.textContent),
  }));
  if (kept.draft !== 'a draft that must survive') failures.push(`the approval took the draft: ${kept.draft}`);
  if (!kept.files.length || !/notes\.txt/.test(kept.files.join(' '))) failures.push(`the approval took the files: ${JSON.stringify(kept.files)}`);
  return kept;
}

/**
 * A new chat and a worker that comes back start at Ask first.
 */
async function newChatAndRestartStartAtAskFirst(panel, failures) {
  await newChat(panel);
  const fresh = await modeState(panel);
  if (fresh.value !== 'ask-first') failures.push(`a new chat starts at ${fresh.value}`);
  if (fresh.risk !== true) failures.push('a new chat shows the risk of Full access');

  // The worker is stopped and comes back: the grant does not survive it.
  const cdp = await panel.context().newCDPSession(panel);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const dropped = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first' && document.getElementById('accessRisk')?.hidden, { timeout: 20000 })
    .then(() => true, () => false);
  if (!dropped) failures.push('the mode of a worker that is gone is still shown');
  return dropped;
}

/**
 * The fast layer runs the same executor, so it asks as well.
 */
async function fastLayerAsksToo(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:fast Type "fast text" into the message field');
  await panel.click('#sendBtn');

  await waitForCard(panel);
  const asked = await cardText(panel);
  if (!/Type text into a field/i.test(asked)) failures.push(`the fast layer did not ask: ${asked}`);
  await panel.click('#approvals .permission-deny');
  await noCards(panel);
  await panel.waitForTimeout(500);
  const typed = await target.evaluate(() => document.getElementById('message')?.value);
  if (typed !== 'original message') failures.push(`the fast layer wrote into the page although it was refused: ${typed}`);
  return typed;
}

/**
 * The card in the panel: one answer only, and the same card in the voice
 * screen, in a narrow column, in Arabic and in the dark theme.
 */
async function cardLooksRightEverywhere(panel, target, failures) {
  await resetPage(target);
  await resetCounters(panel);
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:stop-card Type the message and report what happened');
  await panel.click('#sendBtn');
  await waitForCard(panel);

  // One answer only: a second click on the same card sends nothing.
  await panel.click('#approvals .permission-allow');
  const answers = await panel.evaluate(() => window.__posted.filter((m) => m?.type === 'access-approval').length);
  if (answers !== 1) failures.push(`the card sent ${answers} answers`);
  await noCards(panel);

  // The card is visible in the voice screen too: there is one place for it.
  await newChat(panel);
  await target.bringToFront();
  await panel.fill('#input', 'MODE:stop-voice Type the message and report what happened');
  await panel.click('#sendBtn');
  await waitForCard(panel);
  await panel.click('#voiceToggle');
  await panel.waitForSelector('#voiceView:not([hidden])');
  const shared = await panel.evaluate(() => {
    const card = document.querySelector('#approvals .permission-request');
    if (!card) return { visible: false };
    const box = card.getBoundingClientRect();
    const view = document.getElementById('voiceView');
    return {
      visible: box.width > 0 && box.height > 0,
      outsideVoice: !view.contains(card),
      outsideChat: !document.getElementById('chatView').contains(card),
    };
  });
  if (!shared.visible) failures.push('the card is not on the screen in the voice screen');
  if (!shared.outsideVoice) failures.push('the voice screen has an approval of its own');
  if (!shared.outsideChat) failures.push('the chat has an approval of its own');

  // A narrow column, in Arabic and in the dark theme: nothing sticks out.
  await panel.setViewportSize({ width: 320, height: 640 });
  const narrow = await panel.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    cardRight: document.querySelector('#approvals .permission-request')?.getBoundingClientRect().right ?? 0,
  }));
  if (narrow.scrollWidth > narrow.clientWidth + 1) failures.push('the panel overflows a narrow column');
  if (narrow.cardRight > narrow.innerWidth + 1) failures.push('the card sticks out of a narrow column');
  await shot(panel, 'access-approval-320-light-en.png');

  await panel.click('#langBtn');
  await panel.waitForFunction(() => document.documentElement.dir === 'rtl');
  const arabic = await panel.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    action: document.querySelector('#approvals .permission-action')?.textContent ?? '',
    allow: document.querySelector('#approvals .permission-allow')?.textContent ?? '',
  }));
  if (arabic.scrollWidth > arabic.clientWidth + 1) failures.push('the panel overflows a narrow column in Arabic');
  if (/type_text/.test(arabic.action)) failures.push(`the Arabic card shows the name of the tool: ${arabic.action}`);
  await shot(panel, 'access-approval-320-light-ar.png');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.waitForTimeout(300);
  await shot(panel, 'access-approval-320-dark-ar.png');
  const dark = await panel.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    background: getComputedStyle(document.querySelector('#approvals .permission-request')).backgroundColor,
  }));
  if (dark.scrollWidth > dark.clientWidth + 1) failures.push('the panel overflows a narrow column in the dark theme');
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.click('#langBtn');
  await panel.waitForFunction(() => document.documentElement.dir === 'ltr');
  await panel.click('#voiceBackBtn');
  await panel.waitForSelector('#voiceView', { state: 'hidden' });
  await panel.setViewportSize({ width: 400, height: 720 });
}

export async function runAccessRuntimeScenario(context, extensionId) {
  const failures = [];
  const { server, bodies, counts, base } = await startServer();
  const { panel, errors } = await openPanel(context, extensionId, base);
  let target = null;
  try {
    target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();

    await askFirstDenies(panel, target, failures);
    await allowOnceRunsOneAction(panel, target, failures);
    await askSelectedRead(panel, target, bodies, failures);
    await fullAccessAsksNothing(panel, target, bodies, failures);
    await webTerminalAsksForEachStep(panel, target, failures);
    await modeChangeClearsTheApproval(panel, target, failures);
    await stopClearsTheApproval(panel, target, failures);
    await approvalKeepsTheDraft(panel, target, failures);
    await newChatAndRestartStartAtAskFirst(panel, failures);
    await cardLooksRightEverywhere(panel, target, failures);

    // The fast layer asks as well: it runs the same executor.
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: baseUrl },
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('accessSelect')?.value);
    await fastLayerAsksToo(panel, target, failures);

    if (errors.length) failures.push(`side panel errors: ${errors.join(' | ')}`);
    console.log(`\n== scenario: access-runtime ==\nmodel calls: ${counts.llm}, fast calls: ${counts.jev}\n${failures.length ? failures.join('\n') : 'the approvals behaved'}`);
    return failures;
  } finally {
    await target?.close();
    await panel.close();
    server.close();
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-runtime-'));
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
    const failures = await runAccessRuntimeScenario(context, extensionId);
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nACCESS RUNTIME E2E PASSED');
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
