// Real-Chromium check of the browser foundation: the identity of a target, the
// check that the target is still the same thing when the action goes out, and
// the one way a selected value leaves the page.
//
// The fake page of test/browser-permission-targets.test.js cannot show what a
// browser really does: a real focus, a real shadow root, a real trusted
// keystroke, a document that is really replaced. This runs the same scripts in
// Chromium, against the synthetic fixture.
//
// The service worker may not import a module at run time, so the checks run in
// an extension page, which may.
//
// The browser has to be one that loads an unpacked extension: Playwright's own
// Chromium (`npx playwright install chromium`). The branded Chrome refuses
// `--load-extension`, and this check says so instead of failing quietly.
//
//   node test/e2e/browser-targets.mjs
//   CHROMIUM_PATH=/path/to/chromium node test/e2e/browser-targets.mjs
//   POSTORA_PERMISSION_FIXTURE=/path/to/fixture.html node test/e2e/browser-targets.mjs
//   E2E_EXTENSION_DIR=/path/to/unpacked-store-build node test/e2e/browser-targets.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// The fixture travels with the tests, so a clean checkout can run them.
const FIXTURE = process.env.POSTORA_PERMISSION_FIXTURE
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/postora-permissions-fixture.html');
// The extension under test: the working tree, or the unpacked store build.
const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

if (!fs.existsSync(FIXTURE)) {
  console.error(`The fixture is not there: ${FIXTURE}`);
  console.error('Set POSTORA_PERMISSION_FIXTURE to the page the checks should run against.');
  process.exit(2);
}

/** The fixture, served over http: a page of a normal website, not a file. */
function serveFixture() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

async function main() {
  const { server, base } = await serveFixture();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-targets-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const failures = [];
  const notes = {};
  const check = (ok, message) => { if (!ok) failures.push(message); };
  let panel;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 })
      .catch(() => null);
    if (!worker) {
      console.error('The extension did not load. Use a browser that loads an unpacked extension:');
      console.error('  npx playwright install chromium');
      process.exit(2);
    }
    const extensionId = new URL(worker.url()).host;

    const fixtureUrl = `${base}/fixture`;
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await page.bringToFront();

    // An extension page: it may import the modules of the extension, which a
    // service worker may not do at run time.
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

    const tabId = await panel.evaluate(async ([url]) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url?.startsWith(url))?.id ?? null;
    }, [base]);
    if (tabId == null) throw new Error('The fixture tab was not found.');

    // The controller lives in the extension page and acts on the fixture tab.
    await panel.evaluate(async ([id]) => {
      const { BrowserController } = await import(chrome.runtime.getURL('src/browser/controller.js'));
      const browser = new BrowserController({ title: 'Postora QA' });
      await browser.borrowTab(id);
      globalThis.__qa = { browser };
      return true;
    }, [tabId]);

    // 1. The snapshot describes the page: the value of an ordinary field is
    // what the page shows, and the value of a field that holds a secret is not
    // there at all.
    const snapshot = await panel.evaluate(async () => {
      const { browser } = globalThis.__qa;
      const snap = await browser.snapshot();
      const indexOf = (pattern) => {
        const line = snap.elements.find((entry) => pattern.test(entry));
        return line ? Number(/^\[(\d+)\]/.exec(line)[1]) : -1;
      };
      return {
        lines: snap.elements.join('\n'),
        text: snap.text,
        passwordIndex: indexOf(/input\[type=password\]/),
        messageIndex: indexOf(/input "Message"/),
      };
    });
    notes.elements = snapshot.lines.split('\n').length;
    check(!/TEST_ONLY_PASSWORD|TEST_ONLY_OTP|TEST_ONLY_TOKEN/.test(snapshot.lines), 'no secret value is described');
    check(!/TEST_ONLY_PASSWORD|TEST_ONLY_OTP|TEST_ONLY_TOKEN/.test(snapshot.text), 'no secret value is in the page text');
    check(/value="original message"/.test(snapshot.lines), 'the value of an ordinary field is what the page shows');
    check(snapshot.passwordIndex >= 0, 'the password box is in the list of the elements');
    check(snapshot.messageIndex >= 0, 'the message field is in the list of the elements');

    // 2. The capture names the element, reads nothing and touches nothing.
    const captured = await panel.evaluate(async ([index]) => {
      const { browser } = globalThis.__qa;
      const target = await browser.captureTarget({ kind: 'element', index });
      return { target };
    }, [snapshot.passwordIndex]);
    notes.target = JSON.stringify(captured.target);
    check(!JSON.stringify(captured.target).includes('TEST_ONLY_PASSWORD'), 'the capture holds no value');
    check(captured.target.tabId === tabId, 'the capture is bound to the tab');
    check(typeof captured.target.element?.token === 'string', 'the capture names the element');

    // 3. A value is only read after it was approved.
    const read = await panel.evaluate(async ([index]) => {
      const { browser } = globalThis.__qa;
      const target = await browser.captureTarget({ kind: 'element', index });
      let refused = '';
      try { await browser.readField(target); } catch (err) { refused = String(err.message); }
      const value = await browser.readField(target, { guard: async () => true });
      return { refused, value: value.value, secret: value.secret };
    }, [snapshot.passwordIndex]);
    check(/guard/.test(read.refused), 'a value is not read without a guard');
    check(read.value === 'TEST_ONLY_PASSWORD', 'the approved field is read');
    check(read.secret === true, 'the field that holds a secret is named as one');

    // 4. A field that was replaced by a twin does not inherit the approval.
    const message = await panel.evaluate(async ([index]) => {
      const { browser } = globalThis.__qa;
      return await browser.captureTarget({ kind: 'element', index });
    }, [snapshot.messageIndex]);
    await page.evaluate(() => window.replaceMessage());
    const twin = await panel.evaluate(async ([target]) => {
      const { browser } = globalThis.__qa;
      const result = await browser.validateTarget(target);
      return { ok: result.ok, reason: result.reason ?? null };
    }, [message]);
    check(twin.ok === false, 'a field that was replaced does not inherit the approval');
    notes.twin = twin.reason ?? 'ok';

    // 5. The same address, a new document: the approval does not travel with it.
    await page.reload();
    await page.waitForTimeout(400);
    const reloaded = await panel.evaluate(async ([target]) => {
      const { browser } = globalThis.__qa;
      const result = await browser.validateTarget(target);
      return { ok: result.ok, reason: result.reason ?? null };
    }, [message]);
    check(reloaded.ok === false, 'a document that was replaced does not inherit the approval');
    notes.document = reloaded.reason ?? 'ok';

    // 6. An editor that holds a secret: its contents are not in the snapshot,
    // not in the text of the page and not in the name of the box around it.
    await page.evaluate(() => {
      const editor = document.createElement('div');
      editor.id = 'qaEditor';
      editor.setAttribute('role', 'textbox');
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('aria-label', 'Access token');
      editor.textContent = 'TEST_EDITOR_SECRET';
      const wrapper = document.createElement('div');
      wrapper.id = 'qaWrapper';
      wrapper.append(editor);
      document.body.append(wrapper);
    });
    const editor = await panel.evaluate(async () => {
      const { browser } = globalThis.__qa;
      const snap = await browser.snapshot();
      const text = await browser.text(0, 15000);
      return { lines: snap.elements.join('\n'), text: snap.text, page: text.text };
    });
    check(!/TEST_EDITOR_SECRET/.test(editor.lines), 'the contents of a secret editor are not described');
    check(!/TEST_EDITOR_SECRET/.test(editor.text), 'the contents of a secret editor are not in the page text');
    check(!/TEST_EDITOR_SECRET/.test(editor.page), 'the contents of a secret editor are not in the text of the page');
    check(/original message/.test(editor.lines), 'the ordinary field keeps its value');

    // 7. The focus that was approved is not the focus that is there now: the
    // text does not follow the focus into another field.
    await page.goto(`${fixtureUrl}?redirectFocus`);
    await page.waitForTimeout(300);
    const drift = await panel.evaluate(async () => {
      const { browser } = globalThis.__qa;
      const snap = await browser.snapshot();
      const line = snap.elements.find((entry) => /input "Message"/.test(entry));
      const index = Number(/^\[(\d+)\]/.exec(line)[1]);
      const target = await browser.captureTarget({ kind: 'element', index });
      const spot = await browser.locate(index);
      await browser.clickAt(spot.x, spot.y, { wait: false });
      let typed = '';
      try { await browser.insertText('MUST NOT ARRIVE', { target }); } catch (err) { typed = String(err.message); }
      return { typed };
    });
    await page.waitForTimeout(200);
    const drifted = await page.evaluate(() => ({
      active: document.activeElement?.id ?? '',
      message: document.getElementById('message')?.value ?? '',
      password: document.getElementById('password')?.value ?? '',
    }));
    check(drifted.active === 'password', 'the page moved the focus to the password box');
    check(/inputCancelled/.test(drift.typed), 'the text does not follow the focus to another field');
    check(drifted.password === 'TEST_ONLY_PASSWORD', 'the password box was not written into');
    check(!drifted.message.includes('MUST NOT ARRIVE'), 'the text did not arrive in the message field');

    // 8. The terminal: the focus is in its own hidden textarea, and it takes
    // the text as real input. The textarea is approved by its own identity.
    await page.goto(fixtureUrl);
    await page.waitForTimeout(300);
    const terminal = await page.evaluate(() => {
      const box = document.getElementById('terminal');
      box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await panel.evaluate(async ([point]) => {
      await globalThis.__qa.browser.clickAt(point.x, point.y, { wait: false });
      return true;
    }, [terminal]);
    await page.waitForTimeout(250);
    const helper = await page.evaluate(() => ({
      active: document.activeElement?.id ?? '',
      tag: document.activeElement?.tagName ?? '',
    }));
    check(helper.active === 'terminalInput', 'the focus is in the hidden helper of the terminal');
    const typed = await panel.evaluate(async () => {
      const { browser } = globalThis.__qa;
      const target = await browser.captureTarget({ kind: 'focus' });
      await browser.insertText('qa command', { target });
      await browser.pressKey('Enter', { target, wait: false });
      return { tag: target.element?.tag ?? '' };
    });
    check(typed.tag === 'textarea', 'the capture names the helper of the terminal');
    await page.waitForTimeout(400);
    const qa = await page.evaluate(() => ({ commands: window.qa.commands, trusted: window.qa.trustedInputs }));
    check(qa.commands.includes('qa command'), 'the terminal got the command');
    check(qa.trusted.includes('terminalInput'), 'the terminal got real input');

    console.log(`\n== browser targets ==\n${JSON.stringify(notes, null, 2)}`);
    if (failures.length) {
      console.error(`\n${failures.length} failures:`);
      for (const failure of failures) console.error(` - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\nall checks passed');
    }
  } finally {
    await panel?.close().catch(() => {});
    await context.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
