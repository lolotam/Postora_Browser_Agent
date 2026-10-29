// The real composer, including native select sizing and textarea layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function runComposerScenario(context, extensionId) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  let previous;
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    previous = await panel.evaluate(() => chrome.storage.local.get('settings'));
    await panel.evaluate(async () => {
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await chrome.storage.local.set({ settings: mergeSettings({ provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'a-deliberately-long-model-name-with-reasoning-high' },
        fast: { enabled: false }, uiLanguage: 'en' }) });
    });
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent.startsWith('a-deliberately'));
    await panel.waitForSelector('#chatView:not([hidden])');
    assert.deepEqual(await panel.locator('#emptyState > *').evaluateAll((nodes) => nodes.map((node) => node.tagName)), ['IMG']);
    assert.equal(await panel.locator('.examples li').count(), 0);

    // Exercise the real Full access consent path, not a locally forged mode.
    await panel.selectOption('#accessSelect', 'full-access');
    await panel.waitForSelector('#accessWarning[open]');
    await panel.check('#accessAcknowledge');
    await panel.click('#accessConfirm');
    await panel.waitForSelector('#accessSelect.risk');
    for (const language of ['en', 'ar']) {
      await panel.evaluate(async (language) => {
        const { setLanguage } = await import(chrome.runtime.getURL('src/sidepanel/i18n.js'));
        setLanguage(language);
      }, language);
      for (const theme of ['light', 'dark']) {
        await panel.emulateMedia({ colorScheme: theme });
        for (const width of [320, 360, 400]) {
          await panel.setViewportSize({ width, height: 640 });
          const geometry = await panel.evaluate(() => {
            const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
            const ids = ['modelQuickBtn', 'accessSelect', 'attachBtn', 'voiceToggle', 'sendBtn'];
            return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
              box: rect('composerBox'), input: rect('input'), items: ids.map(rect),
              nested: ids.every((id) => document.getElementById('composerBox').contains(document.getElementById(id))),
              radius: getComputedStyle(document.getElementById('sendBtn')).borderRadius,
              rtl: document.documentElement.dir === 'rtl' };
          });
          const state = `${language}/${theme}/${width}`;
          assert.ok(geometry.nested, `${state}: a control escaped the composer`);
          assert.ok(geometry.sw <= geometry.cw + 1, `${state}: horizontal overflow`);
          assert.equal(geometry.radius, '50%');
          const [model, access, attach, voice, send] = geometry.items;
          for (const item of geometry.items) {
            assert.ok(item.width > 0 && item.left >= geometry.box.left && item.right <= geometry.box.right, `${state}: clipped control`);
            assert.ok(Math.abs(item.top - send.top) <= 1, `${state}: toolbar wrapped`);
            assert.ok(item.top >= geometry.input.bottom, `${state}: toolbar overlaps draft`);
          }
          const ordered = [...geometry.items].sort((a, b) => a.left - b.left);
          assert.ok(ordered.every((item, index) => !index || item.left >= ordered[index - 1].right), `${state}: overlapping controls`);
          assert.ok(geometry.rtl ? model.left > access.left && attach.left > voice.left && voice.left > send.left
            : model.left < access.left && attach.left < voice.left && voice.left < send.left, `${state}: wrong logical order`);
          if (process.env.E2E_SCREENSHOTS) {
            fs.mkdirSync(process.env.E2E_SCREENSHOTS, { recursive: true });
            await panel.bringToFront();
            await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `composer-${language}-${theme}-${width}.png`), animations: 'disabled' });
          }
        }
      }
    }
    // The keyboard description may overlay the draft, but must never eat the
    // click that moves focus back there (especially at the narrowest width).
    await panel.setViewportSize({ width: 320, height: 640 });
    await panel.focus('#accessSelect');
    await panel.keyboard.press('Tab');
    await panel.keyboard.press('Shift+Tab');
    assert.ok(await panel.locator('#accessRisk').evaluate((risk) => risk.getBoundingClientRect().width > 1));
    await panel.click('#input');
    assert.equal(await panel.evaluate(() => document.activeElement.id), 'input');
    await panel.selectOption('#accessSelect', 'ask-first');
    await panel.waitForFunction(() => !document.getElementById('accessSelect').classList.contains('risk'));
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await panel.locator('#input').evaluate((input) => getComputedStyle(input).transitionDuration), '0s');
    const short = await panel.locator('#input').evaluate((input) => input.getBoundingClientRect().height);
    await panel.fill('#input', Array.from({ length: 30 }, (_, index) => `Draft line ${index}`).join('\n'));
    const tall = await panel.locator('#input').evaluate((input) => ({ height: input.getBoundingClientRect().height, scroll: input.scrollHeight, client: input.clientHeight }));
    assert.ok(tall.height > short && tall.height <= 200 && tall.scroll > tall.client, 'long drafts expand, then scroll');
    await panel.fill('#input', 'short draft');
    assert.equal(await panel.locator('#input').evaluate((input) => input.getBoundingClientRect().height), short);
    await panel.press('#input', 'Shift+Enter');
    assert.equal(await panel.inputValue('#input'), 'short draft\n');
    // Native select Enter must never submit the surrounding form.
    await panel.evaluate(() => {
      window.__composerSubmits = 0;
      document.getElementById('composer').addEventListener('submit', (event) => {
        window.__composerSubmits++;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    });
    await panel.focus('#accessSelect');
    await panel.keyboard.press('Enter');
    await panel.keyboard.press('Escape');
    assert.equal(await panel.evaluate(() => window.__composerSubmits), 0);
    await panel.press('#input', 'Enter');
    assert.equal(await panel.evaluate(() => window.__composerSubmits), 1);
    await panel.setInputFiles('#fileInput', { name: 'a-long-attachment-file-name-for-the-composer.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    await panel.waitForSelector('#fileChips li');
    assert.ok(await panel.isVisible('#fileChips'));
    await panel.click('#fileChips button');
    await panel.waitForSelector('#fileChips', { state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('\n== scenario: composer ==\nlogo-only empty state, inline controls, Full access, RTL/themes at 320/360/400px, sizing, shortcuts and attachments passed');
    return [];
  } catch (error) {
    return [`Composer: ${error.stack ?? error.message}`];
  } finally {
    await panel.evaluate(async (previous) => {
      if (previous?.settings) await chrome.storage.local.set(previous);
      else await chrome.storage.local.remove('settings');
    }, previous).catch(() => {});
    await panel.close();
  }
}
