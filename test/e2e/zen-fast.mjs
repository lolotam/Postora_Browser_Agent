// Settings and connection-test routing with synthetic first-party Zen HTTP.
import assert from 'node:assert/strict';
import { extensionWorker } from './extension-worker.mjs';

export async function runZenFastScenario(context, extensionId) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  let worker;
  let previous;
  async function choose(button, model) {
    await panel.click(button);
    await panel.waitForSelector(`#modelDialogList [data-value="${model}"]`);
    await panel.click(`#modelDialogList [data-value="${model}"]`);
  }
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    previous = await panel.evaluate(() => chrome.storage.local.get('settings'));
    worker = extensionWorker(context, panel, extensionId);
    await worker.evaluate(() => {
      globalThis.__zenOriginalFetch = globalThis.fetch;
      globalThis.__zenCalls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (!url.startsWith('https://opencode.ai/')) return globalThis.__zenOriginalFetch(input, init);
        globalThis.__zenCalls.push(url);
        if (url.endsWith('/models')) return Response.json({ data: [
          { id: 'glm-5.3-flash' }, { id: 'jev-1.13' }, { id: 'glm-5.3-flash-free' }, { id: 'claude-haiku-5-5' },
        ] });
        const headers = new Headers(init.headers);
        if (headers.get('Authorization') !== 'Bearer SYNTHETIC-ZEN-KEY') throw new Error('Wrong synthetic Zen credential');
        if (url.endsWith('/systemone')) return Response.json({ error: { message: 'Upstream request failed: Model access is disabled' } }, { status: 403 });
        if (!url.endsWith('/chat/completions')) throw new Error('Wrong Zen API route');
        const body = JSON.parse(init.body);
        if (body.model !== 'glm-5.3-flash' || !headers.get('x-opencode-session')) throw new Error('Missing Zen chat model/session');
        return Response.json({ model: body.model, choices: [{ message: { content: '{"greeting":1}' } }] });
      };
    });
    await panel.evaluate(async () => {
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await chrome.storage.local.set({ settings: mergeSettings({ provider: 'compatible', compatible: { preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'mock-model' },
        keys: { opencode: 'SYNTHETIC-ZEN-KEY' }, fast: { enabled: true }, uiLanguage: 'en' }) });
    });
    await panel.reload();
    await panel.bringToFront();
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent === 'mock-model');
    await panel.click('#settingsBtn');
    await panel.click('#settingsRowFast');
    await panel.selectOption('#fastProvider', 'opencode-zen');
    assert.equal(await panel.inputValue('#fastModel'), 'glm-5.3-flash');
    assert.equal(await panel.inputValue('#fastBaseUrl'), 'https://opencode.ai/inference/openai/v1');
    await panel.click('#modelBtnFast');
    await panel.waitForSelector('#modelDialogList [data-value="glm-5.3-flash"]');
    assert.equal(await panel.locator('#modelDialogList [data-value="glm-5.3-flash-free"]').count(), 0);
    await panel.click('#modelDialogList [data-value="glm-5.3-flash"]');
    await panel.click('#fastTestBtn');
    await panel.waitForSelector('#fastTestResult[data-state="ok"]');
    await choose('#modelBtnFast', 'jev-1.13');
    await panel.click('#fastTestBtn');
    await panel.waitForSelector('#fastTestResult[data-state="fail"]');
    assert.match(await panel.textContent('#fastTestResult'), /HTTP 403.*Model access is disabled/);
    await choose('#modelBtnFast', 'glm-5.3-flash');
    assert.equal(await panel.textContent('#fastTestResult'), '', 'choosing an accessible model clears the stale Jev error');
    await panel.click('#fastTestBtn');
    await panel.waitForSelector('#fastTestResult[data-state="ok"]');
    await panel.check('#fastFallbackEnabled');
    await panel.selectOption('#fastFallbackProvider', 'opencode-zen');
    await choose('#modelBtnFastBackup', 'glm-5.3-flash');
    await panel.click('#fastFallbackTestBtn');
    await panel.waitForSelector('#fastFallbackTestResult[data-state="ok"]');
    await panel.click('#saveBtn');
    await panel.waitForSelector('#settingsView', { state: 'hidden' });
    const settings = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(settings.fast.decision, false);
    assert.equal(settings.fast.fallback.decision, false);
    const calls = await worker.evaluate(() => globalThis.__zenCalls);
    assert.ok(calls.includes('https://opencode.ai/inference/v1/models'));
    assert.equal(calls.filter((url) => url.endsWith('/systemone')).length, 1);
    assert.ok(calls.filter((url) => url.endsWith('/chat/completions')).length >= 3);
    assert.deepEqual(errors, []);
    console.log('\n== scenario: zen-fast ==\nchat/Jev catalog, paid default, primary/backup tests and stale-error recovery behaved (synthetic Zen)');
    return [];
  } catch (error) {
    return [`Zen fast layer: ${error.stack ?? error.message}`];
  } finally {
    await panel.evaluate(async (previous) => {
      if (previous?.settings) await chrome.storage.local.set(previous);
      else await chrome.storage.local.remove('settings');
    }, previous).catch(() => {});
    await worker?.evaluate(() => {
      if (globalThis.__zenOriginalFetch) globalThis.fetch = globalThis.__zenOriginalFetch;
      delete globalThis.__zenOriginalFetch;
      delete globalThis.__zenCalls;
    }).catch(() => {});
    await panel.close();
  }
}
