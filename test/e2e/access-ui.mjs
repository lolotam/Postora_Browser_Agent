// The access-mode consent UI, in the real extension.
//
// The panel asks the worker for the mode of a chat, the worker confirms it,
// and the panel shows what the worker confirmed. This scenario drives that
// round trip through the real UI: the selection opens the warning, the
// warning has to be read and acknowledged, and only the worker's own answer
// turns the mode into Full access.
//
//   node test/e2e/access-ui.mjs          (this scenario alone)
//   npm run e2e                         (the whole suite, this scenario included)
//   E2E_SCREENSHOTS=out npm run e2e    (the panel is saved after the scenario)

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
  ? path.join('E:/Dev/Temp/opencode', 'chat-permissions-access-ui')
  : path.join(os.tmpdir(), 'chat-permissions-access-ui'));

// The page the panel may act on. Nothing is done to it: the mode is the only
// thing this scenario is about.
const TARGET_PAGE = `<!doctype html><html><body>
<h1>Access test page</h1>
<input id="q" name="q" placeholder="Search">
<button id="go">Go</button>
<div id="out"></div>
</body></html>`;

/** A local server: the model settings may point at it, and it serves a page. */
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(TARGET_PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

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
  window.__say = (text) => window.__recognition?.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
  });
}

/** What the access control shows right now. */
const accessState = (page) => page.evaluate(() => {
  const node = (id) => document.getElementById(id);
  const risk = node('accessRisk');
  const voice = node('voiceAccess');
  return {
    value: node('accessSelect').value,
    state: node('accessState').textContent.trim(),
    risk: risk.textContent.trim(),
    riskHidden: risk.hidden,
    voice: voice.textContent.trim(),
    voiceRisk: voice.classList.contains('risk'),
    warningOpen: node('accessWarning').open,
    checked: node('accessAcknowledge').checked,
    confirmDisabled: node('accessConfirm').disabled,
    focused: document.activeElement?.id ?? '',
    draft: node('input').value,
  };
});

/** The panel must not stick out of its own column. */
const layout = (page) => page.evaluate(() => {
  const doc = document.documentElement;
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const risk = document.getElementById('accessRisk');
  return {
    dir: doc.dir,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    select: box(document.getElementById('accessSelect')),
    riskHidden: risk.hidden,
    riskVisible: box(risk).height > 0 && box(risk).width > 0,
    riskBackground: getComputedStyle(risk).backgroundColor,
    riskColor: getComputedStyle(risk).color,
  };
});

/** The mode of the control, and the way to the Full access warning. */
async function openWarning(page) {
  await page.selectOption('#accessSelect', 'full-access');
  await page.waitForSelector('#accessWarning[open]');
}

/**
 * The picture of the panel.
 *
 * A tab that was in the background keeps the picture it had, so the tab comes
 * to the front and is asked for a new frame: a page that is a little
 * transparent is drawn again, in the theme and the language it is in.
 */
async function shot(page, file) {
  await page.bringToFront();
  await page.evaluate(() => { document.documentElement.style.opacity = '0.999'; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, file) });
  await page.evaluate(() => { document.documentElement.style.opacity = ''; });
}

async function acknowledgeAndConfirm(page) {
  await page.check('#accessAcknowledge');
  await page.click('#accessConfirm');
  await page.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 });
}

/**
 * The panel in the dark theme, in a browser of its own.
 *
 * A tab that is in the background keeps the picture it had, so the dark theme
 * is looked at in a browser in which the panel is the only page on the
 * screen. The mode is asked for through the same UI, so the picture shows what
 * the user would see.
 */
async function darkThemeShot() {
  const failures = [];
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-dark-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    colorScheme: 'dark',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    let worker = null;
    for (let i = 0; i < 120 && !worker; i += 1) {
      worker = context.serviceWorkers()[0];
      if (!worker) await new Promise((r) => setTimeout(r, 500));
    }
    if (!worker) return ['the browser of the dark theme did not start'];
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.evaluate(() => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('accessState')?.textContent?.trim());
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    // The consent itself, in the dark theme: the warning is read and confirmed.
    await openWarning(page);
    await acknowledgeAndConfirm(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    const dark = await layout(page);
    if (dark.scrollWidth > dark.clientWidth + 1) failures.push('the panel overflows a narrow column in the dark theme');
    if (dark.riskHidden) failures.push('the risk is hidden in the dark theme');
    if (!dark.riskVisible) failures.push('the risk is not on the screen in the dark theme');
    await page.screenshot({ path: path.join(SHOT_DIR, 'access-full-320-dark.png') });
    if (pageErrors.length) failures.push(`side panel errors in the dark theme: ${pageErrors.join(' | ')}`);
    await page.close();
  } finally {
    await context.close();
  }
  return failures;
}

export async function runAccessUiScenario(context, extensionId) {
  const failures = [];
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { server, base } = await startServer();
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  let second = null;
  let target = null;
  await panel.addInitScript(mockRecognition);
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    // The model settings may be local and synthetic: the mode is not one of
    // them, and it is never granted through them.
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();
    await panel.click('#newChatBtn');
    await panel.waitForFunction(() => document.getElementById('accessState')?.textContent?.trim());

    // A new chat starts at Ask first: nothing is confirmed and nothing is shown.
    const start = await accessState(panel);
    if (start.value !== 'ask-first') failures.push(`a new chat starts at ${start.value}`);
    if (!start.riskHidden) failures.push('the risk is shown before the worker confirmed anything');
    if (!start.state) failures.push('the control shows no status of its own');

    // The draft of the composer is the user's, not the control's.
    await panel.fill('#input', 'a draft that must survive');

    // Full access asks first: the warning opens, and it says what it allows.
    await openWarning(panel);
    const warning = await panel.evaluate(() => {
      const dialog = document.getElementById('accessWarning');
      return {
        title: document.getElementById('accessWarningTitle').textContent.trim(),
        desc: document.getElementById('accessWarningDesc').textContent.trim(),
        bullets: [...dialog.querySelectorAll('li')].map((li) => li.textContent.trim()),
        label: dialog.querySelector('label.access-ack span')?.textContent.trim() ?? '',
        labelledBy: dialog.getAttribute('aria-labelledby'),
        describedBy: dialog.getAttribute('aria-describedby'),
        text: dialog.textContent,
      };
    });
    if (!warning.title || !warning.desc) failures.push('the warning has no heading or no description');
    if (warning.bullets.length < 6 || warning.bullets.some((line) => !line)) failures.push('the warning does not say what Full access allows');
    if (!warning.label) failures.push('the acknowledgment has no label');
    if (warning.labelledBy !== 'accessWarningTitle' || warning.describedBy !== 'accessWarningDesc') failures.push('the warning is not named for the reader');
    if (!/Chrome/.test(warning.text) || !/terminal/i.test(warning.text)) failures.push('the warning does not say what it does not reach');
    const opening = await accessState(panel);
    if (opening.checked) failures.push('the acknowledgment starts ticked');
    if (!opening.confirmDisabled) failures.push('the confirm button is open before the warning was read');

    // Cancelling sends nothing: the mode stays, and the focus comes back.
    await panel.click('#accessCancel');
    await panel.waitForFunction(() => !document.getElementById('accessWarning').open);
    const cancelled = await accessState(panel);
    if (cancelled.value !== 'ask-first') failures.push(`cancelling left the mode at ${cancelled.value}`);
    if (!cancelled.riskHidden) failures.push('the risk is shown after the warning was cancelled');
    if (cancelled.focused !== 'accessSelect') failures.push(`the focus went to "${cancelled.focused}" instead of the selection`);
    if (cancelled.draft !== 'a draft that must survive') failures.push('the control took the draft of the composer');

    // Escape is a refusal as well, and it hands the focus back too.
    await openWarning(panel);
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(() => !document.getElementById('accessWarning').open);
    const escaped = await accessState(panel);
    if (escaped.value !== 'ask-first') failures.push(`escape left the mode at ${escaped.value}`);
    if (escaped.focused !== 'accessSelect') failures.push(`escape sent the focus to "${escaped.focused}"`);
    if (escaped.draft !== 'a draft that must survive') failures.push('the control took the draft of the composer');

    // The warning has to be read before it can be confirmed.
    await openWarning(panel);
    if (!(await panel.isDisabled('#accessConfirm'))) failures.push('the confirm button is open before the box is ticked');
    await panel.check('#accessAcknowledge');
    if (await panel.isDisabled('#accessConfirm')) failures.push('the confirm button stayed closed after the box was ticked');

    // The worker confirms it, and only then does the panel say Full access.
    await panel.click('#accessConfirm');
    const confirmed = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 })
      .then(() => true, () => false);
    if (!confirmed) failures.push('the worker never confirmed Full access');
    const full = await accessState(panel);
    if (full.value !== 'full-access') failures.push(`the mode stayed at ${full.value} after the worker confirmed it`);
    if (full.riskHidden || !full.risk) failures.push('the risk is not shown while Full access is on');
    if (!/Full access/i.test(full.state)) failures.push(`the status does not report the mode: "${full.state}"`);
    if (full.checked || !full.confirmDisabled) failures.push('the warning was left armed after it was confirmed');

    // The voice screen shows the same mode, in the same words.
    target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    const voice = await panel.evaluate(() => {
      const node = document.getElementById('voiceAccess');
      const box = node.getBoundingClientRect();
      return { text: node.textContent.trim(), risk: node.classList.contains('risk'), shown: box.width > 0 && box.height > 0, title: node.title };
    });
    if (!voice.shown) failures.push('the voice screen shows no mode of its own');
    if (voice.text !== 'Full access') failures.push(`the voice screen says "${voice.text}"`);
    if (!voice.risk) failures.push('the voice screen does not mark the risk of Full access');
    if (!/Full access/i.test(voice.title)) failures.push(`the voice screen does not report the mode: "${voice.title}"`);
    await panel.setViewportSize({ width: 400, height: 720 });
    await shot(panel, 'access-voice-full.png');
    await panel.click('#voiceBackBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    // The page the voice commands would act on is not needed any more, and a
    // panel that is the only one on the screen paints itself again.
    await target.close();
    target = null;

    // Going back to Ask first takes the authority away again.
    await panel.selectOption('#accessSelect', 'ask-first');
    const downgraded = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first', { timeout: 10000 })
      .then(() => true, () => false);
    if (!downgraded) failures.push('the worker never confirmed the downgrade');
    const down = await accessState(panel);
    if (!down.riskHidden) failures.push('the risk is still shown after the downgrade');
    if (down.voice !== 'Ask first') failures.push(`the voice screen still says "${down.voice}"`);

    // A second panel of the same chat: the worker tells both of them.
    await panel.click('#sessionBtn');
    await panel.waitForSelector('#sessionMenu:not([hidden])');
    await panel.click('.session-item.active button.icon >> nth=0');
    await panel.fill('.session-rename', 'Access shared');
    await panel.press('.session-rename', 'Enter');
    await panel.waitForFunction(() => document.getElementById('sessionTitle')?.textContent?.trim() === 'Access shared');

    second = await context.newPage();
    second.on('pageerror', (err) => pageErrors.push(err.message));
    await second.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await second.waitForFunction(() => document.getElementById('accessState')?.textContent?.trim());
    await second.click('#sessionBtn');
    await second.waitForSelector('.session-item:has-text("Access shared") .session-open');
    await second.click('.session-item:has-text("Access shared") .session-open');
    await second.waitForFunction(() => document.getElementById('sessionTitle')?.textContent?.trim() === 'Access shared');
    await second.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first');

    await openWarning(panel);
    await acknowledgeAndConfirm(panel);
    const synced = await second.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 })
      .then(() => true, () => false);
    if (!synced) failures.push('the other panel of the same chat did not hear the worker');
    const other = await accessState(second);
    if (other.riskHidden || !other.risk) failures.push('the other panel of the same chat shows no risk');
    // The other panel has said what it had to say: the panel that is left is
    // the only one on the screen, and it paints itself again.
    await second.close();
    second = null;

    // A new chat starts over: the grant belongs to the chat it was given for.
    await panel.click('#newChatBtn');
    const fresh = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first' && document.getElementById('accessRisk')?.hidden, { timeout: 10000 })
      .then(() => true, () => false);
    if (!fresh) failures.push('a new chat kept the mode of the chat before');

    // A warning that was opened for the chat before is gone when the chat changes.
    await openWarning(panel);
    await panel.evaluate(() => document.getElementById('newChatBtn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await panel.waitForFunction(() => !document.getElementById('accessWarning').open, { timeout: 10000 });
    const stale = await accessState(panel);
    if (!stale.riskHidden) failures.push('the risk of the chat that was left is still shown');
    if (stale.checked) failures.push('the acknowledgment of the warning that was left is still ticked');
    if (!stale.confirmDisabled) failures.push('the confirm button of the warning that was left is still open');
    if (stale.value !== 'ask-first') failures.push(`the chat that was left kept the mode at ${stale.value}`);

    // A narrow panel, in English and in light: nothing sticks out.
    await panel.setViewportSize({ width: 320, height: 640 });
    const narrow = await layout(panel);
    if (narrow.scrollWidth > narrow.clientWidth + 1) failures.push('the panel overflows a narrow column');
    if (narrow.select.right > narrow.innerWidth + 1) failures.push('the access selection sticks out of the panel');
    await shot(panel, 'access-ask-first-320-light.png');

    // The warning itself fits a narrow panel and scrolls when it is long.
    await openWarning(panel);
    const dialog = await panel.evaluate(() => {
      const node = document.getElementById('accessWarning');
      const box = node.getBoundingClientRect();
      const overflow = getComputedStyle(node).overflowY;
      node.scrollTop = node.scrollHeight;
      return { overflow, top: node.scrollTop, room: node.scrollHeight - node.clientHeight, right: box.right, bottom: box.bottom, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    });
    if (dialog.overflow !== 'auto') failures.push('the warning does not scroll');
    if (dialog.room > 0 && dialog.top <= 0) failures.push('the warning does not scroll');
    if (dialog.right > dialog.innerWidth + 1 || dialog.bottom > dialog.innerHeight + 1) failures.push('the warning sticks out of a narrow panel');
    await shot(panel, 'access-warning-320-light.png');
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(() => !document.getElementById('accessWarning').open);

    // The risk is on the screen while the worker has Full access on.
    await openWarning(panel);
    await acknowledgeAndConfirm(panel);
    await shot(panel, 'access-full-320-light.png');

    // Arabic: the same control, read from the other side.
    await panel.click('#langBtn');
    await panel.waitForFunction(() => document.documentElement.dir === 'rtl');
    const arabic = await layout(panel);
    if (arabic.scrollWidth > arabic.clientWidth + 1) failures.push('the panel overflows a narrow column in Arabic');
    if (arabic.select.right > arabic.innerWidth + 1) failures.push('the access selection sticks out of the panel in Arabic');
    const lightRisk = await panel.evaluate(() => getComputedStyle(document.getElementById('accessRisk')).backgroundColor);
    await shot(panel, 'access-full-320-ar-light.png');

    // Dark: the risk is still a warning, not only a colour that is missing.
    // The panel reads the styles of the dark theme here; the picture of it is
    // taken in a browser of its own, where the page is read from the left.
    await panel.emulateMedia({ colorScheme: 'dark' });
    const dark = await layout(panel);
    if (dark.scrollWidth > dark.clientWidth + 1) failures.push('the panel overflows a narrow column in dark');
    if (dark.riskBackground === lightRisk) failures.push('the risk looks the same in the dark theme');
    if (dark.riskColor === 'rgba(0, 0, 0, 0)') failures.push('the risk has no colour of its own');
    await panel.emulateMedia({ colorScheme: 'light' });
    failures.push(...(await darkThemeShot()));

    // The language comes back, so the scenarios that follow read English.
    await panel.click('#langBtn');
    await panel.waitForFunction(() => document.documentElement.dir === 'ltr');

    // The worker is gone: the mode goes with it.
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const dropped = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first' && document.getElementById('accessRisk')?.hidden, { timeout: 10000 })
      .then(() => true, () => false);
    if (!dropped) failures.push('the mode of a worker that is gone is still shown');

    // The control works again without a task and without a reload: the panel
    // asks the worker again, waits for the state it sends, and opens a new
    // warning for the chat that is on.
    await panel.selectOption('#accessSelect', 'full-access');
    const warned = await panel.waitForSelector('#accessWarning[open]', { timeout: 20000 }).then(() => true, () => false);
    if (!warned) failures.push('the control did not ask the worker again');
    if (warned) {
      const fresh = await accessState(panel);
      if (fresh.checked) failures.push('the new warning was already acknowledged');
      if (!fresh.confirmDisabled) failures.push('the new warning could be confirmed without a new acknowledgment');
      if (fresh.value !== 'ask-first') failures.push(`the mode turned Full access before the worker confirmed it (${fresh.value})`);
      await panel.check('#accessAcknowledge');
      await panel.click('#accessConfirm');
      const elevated = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 })
        .then(() => true, () => false);
      if (!elevated) failures.push('the worker did not confirm Full access after the new warning');
      const granted = await accessState(panel);
      if (granted.riskHidden || !granted.risk) failures.push('the risk is not shown after the worker confirmed the new warning');
    }

    // A choice that waits belongs to the chat it was made for: the chat
    // changes while the panel waits, and the choice goes with it.
    await cdp.send('ServiceWorker.stopAllWorkers');
    const droppedAgain = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'ask-first' && document.getElementById('accessRisk')?.hidden, { timeout: 10000 })
      .then(() => true, () => false);
    if (!droppedAgain) failures.push('the mode of a worker that is gone is still shown');
    await panel.selectOption('#accessSelect', 'full-access');
    await panel.evaluate(() => document.getElementById('newChatBtn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await panel.waitForTimeout(2000);
    const switched = await accessState(panel);
    if (switched.warningOpen) failures.push('the warning of the chat that was left is still open');
    if (switched.value !== 'ask-first' || !switched.riskHidden) failures.push('the chat that was left kept the mode');
    if (switched.checked || !switched.confirmDisabled) failures.push('the acknowledgment of the chat that was left is still armed');

    // And the worker that comes back starts over: the grant does not survive it.
    await panel.reload();
    const back = await panel.waitForFunction(() => document.getElementById('accessState')?.textContent?.trim(), null, { timeout: 15000 })
      .then(() => true, () => false);
    if (!back) failures.push('the panel did not come back after the reload');
    const again = await accessState(panel);
    if (again.value !== 'ask-first' || !again.riskHidden) failures.push('the mode came back with the worker');

    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    console.log(`\n== scenario: access-ui ==\n${failures.length ? failures.join('\n') : 'the consent UI behaved'}`);
    return failures;
  } finally {
    await second?.close();
    await target?.close();
    await panel.close();
    server.close();
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-e2e-'));
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
    const failures = await runAccessUiScenario(context, extensionId);
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nACCESS UI E2E PASSED');
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
