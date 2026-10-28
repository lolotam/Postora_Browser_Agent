// Named-provider integration against synthetic first-party HTTP responses.
// No live account, real key, or browser session cookies are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { extensionWorker } from './extension-worker.mjs';

export async function runNamedProvidersScenario(context, extensionId) {
  const server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Provider test page</h1>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  let target;
  let worker;
  let previousSettings;
  const verificationRoute = 'https://www.kimi.com/code/postora-test**';
  const verificationHandler = (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic authorization page</h1>' });
  await context.route(verificationRoute, verificationHandler);
  async function openSettings() {
    await panel.bringToFront();
    await panel.click('#settingsBtn');
    await panel.click('#settingsRowModels');
    await panel.click('#settingsRowMain');
  }
  async function pick(model) {
    // Device authorization opens another tab. Restore the panel's rendering
    // before interacting with its native buttons/dialog; never force a click.
    await panel.bringToFront();
    await panel.click('#modelBtnMain');
    await panel.click('#modelDialogRefresh');
    await panel.waitForSelector(`#modelDialogList [data-value="${model}"]`, { state: 'visible' });
    await panel.fill('#modelDialogSearch', model);
    await panel.press('#modelDialogSearch', 'Enter');
  }
  async function save() {
    await panel.bringToFront();
    await panel.click('#saveBtn');
    await panel.waitForSelector('#settingsView', { state: 'hidden' });
  }
  async function task(report) {
    await target.bringToFront();
    const before = await panel.locator('.msg.final').count();
    await panel.fill('#input', `Report ${report}`);
    await panel.click('#sendBtn');
    await panel.waitForFunction((count) => document.querySelectorAll('.msg.final').length > count, before, { timeout: 30000 });
    assert.match(await panel.locator('.msg.final').last().innerText(), new RegExp(report));
    await panel.waitForFunction(() => document.getElementById('stopBtn').hidden);
  }
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    previousSettings = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    worker = extensionWorker(context, panel, extensionId);
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.__namedOriginalFetch = original;
      globalThis.__namedCalls = [];
      globalThis.__kimiGrant = false;
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const named = ['https://generativelanguage.googleapis.com/', 'https://api.moonshot.ai/', 'https://api.kimi.com/', 'https://auth.kimi.com/'].some((origin) => url.startsWith(origin));
        if (!named) return original(input, init);
        const headers = new Headers(init.headers);
        globalThis.__namedCalls.push({ url, auth: headers.get('authorization') });
        if (url.endsWith('/device_authorization')) return Response.json({ device_code: 'SYNTHETIC-DEVICE', user_code: 'KIMI-TEST', verification_uri: 'https://www.kimi.com/code/postora-test', verification_uri_complete: 'https://www.kimi.com/code/postora-test?user_code=KIMI-TEST', interval: 1, expires_in: 60 });
        if (url.endsWith('/oauth/token')) return globalThis.__kimiGrant
          ? Response.json({ access_token: 'SYNTHETIC-CODE-ACCESS', refresh_token: 'SYNTHETIC-CODE-REFRESH', expires_in: 3600 })
          : Response.json({ error: 'authorization_pending' }, { status: 400 });
        const google = url.startsWith('https://generativelanguage.googleapis.com/');
        const code = url.startsWith('https://api.kimi.com/');
        const expected = google ? 'Bearer SYNTHETIC-GEMINI-KEY' : code ? 'Bearer SYNTHETIC-CODE-ACCESS' : 'Bearer SYNTHETIC-MOONSHOT-KEY';
        if (headers.get('authorization') !== expected) return Response.json({ error: { message: 'wrong credential scope' } }, { status: 401 });
        const model = google ? 'gemini-test' : code ? 'kimi-for-coding' : 'kimi-k3.1-pro';
        if (url.endsWith('/models')) return Response.json({ data: [{ id: model }] });
        const body = JSON.parse(init.body);
        const report = google ? 'GEMINI-EXECUTED' : code ? 'CODE-EXECUTED' : 'MOONSHOT-EXECUTED';
        const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `named-${Date.now()}`, function: { name: 'done', arguments: JSON.stringify({ success: true, report }) } }] }, finish_reason: 'tool_calls' }] };
        if (body.model !== model) return new Response('wrong model', { status: 400 });
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      };
    });
    await panel.evaluate(async () => {
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await chrome.storage.local.set({ settings: mergeSettings({ provider: 'gemini', gemini: { apiKey: 'SYNTHETIC-GEMINI-KEY', model: 'gemini-test' }, kimi: { apiKey: 'SYNTHETIC-MOONSHOT-KEY' }, fast: { enabled: false }, uiLanguage: 'en' }) });
    });
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('sessionTitle').textContent && document.getElementById('modelQuickLabel').textContent === 'gemini-test');
    target = await context.newPage();
    await target.goto(`http://127.0.0.1:${server.address().port}/`);
    await task('GEMINI-EXECUTED');
    await openSettings();
    assert.equal(await panel.inputValue('#provider'), 'gemini');
    await pick('gemini-test');
    await panel.selectOption('#provider', 'kimi');
    await panel.waitForSelector('#mainProvider [data-field="kimiSection"]:not([hidden])');
    assert.equal(await panel.inputValue('#mainProvider [data-field="kimiAuth"]'), 'apiKey');
    await pick('kimi-k3.1-pro');
    await save();
    await task('MOONSHOT-EXECUTED');

    await openSettings();
    await panel.selectOption('#mainProvider [data-field="kimiAuth"]', 'account');
    await panel.click('#mainProvider [data-provider="kimi"] [data-auth="login"]');
    await panel.waitForSelector('#mainProvider [data-provider="kimi"] [data-auth="device"]:not([hidden])');
    assert.equal(await panel.textContent('#mainProvider [data-provider="kimi"] [data-auth="deviceCode"]'), 'KIMI-TEST');
    await panel.bringToFront();
    await panel.click('#mainProvider [data-provider="kimi"] [data-auth="cancel"]');
    await panel.waitForSelector('#mainProvider [data-provider="kimi"] [data-auth="device"]', { state: 'hidden' });
    assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('accountAuth.kimi'))['accountAuth.kimi']?.credential ?? null), null);
    await worker.evaluate(() => { globalThis.__kimiGrant = true; });
    await panel.click('#mainProvider [data-provider="kimi"] [data-auth="login"]');
    await panel.waitForSelector('#mainProvider [data-provider="kimi"] [data-auth="logout"]:not([hidden])');
    await pick('kimi-for-coding');
    await save();
    await task('CODE-EXECUTED');

    // A different named provider can be the backup, using its own canonical key.
    await openSettings();
    await panel.click('#closeSettingsBtn');
    await panel.check('#fallbackEnabled');
    await panel.click('#settingsRowBackup');
    await panel.selectOption('#fallbackProvider [data-field="provider"]', 'gemini');
    await panel.click('#modelBtnBackup');
    await panel.click('#modelDialogRefresh');
    await panel.waitForSelector('#modelDialogList [data-value="gemini-test"]', { state: 'visible' });
    await panel.click('#modelDialogList [data-value="gemini-test"]');
    await save();
    const settings = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(settings.fallback.provider, 'gemini');
    assert.equal(settings.fallback.gemini.apiKey, 'SYNTHETIC-GEMINI-KEY');
    assert.equal(settings.kimi.auth, 'account');
    await openSettings();
    await panel.click('#mainProvider [data-provider="kimi"] [data-auth="logout"]');
    await panel.waitForSelector('#mainProvider [data-provider="kimi"] [data-auth="login"]:not([hidden])');
    assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('accountAuth.kimi'))['accountAuth.kimi'].credential), null);
    assert.deepEqual(errors, []);
    console.log('\n== scenario: named-providers ==\nGemini API, Moonshot API, Kimi Code sign-in/cancel/logout and backup configuration behaved (synthetic HTTP)');
    return [];
  } catch (error) {
    return [`named providers: ${error.stack ?? error.message}`];
  } finally {
    if (previousSettings) await panel.evaluate((settings) => chrome.storage.local.set({ settings }), previousSettings).catch(() => {});
    await worker?.evaluate(() => {
      if (globalThis.__namedOriginalFetch) globalThis.fetch = globalThis.__namedOriginalFetch;
      delete globalThis.__namedOriginalFetch;
      delete globalThis.__namedCalls;
    }).catch(() => {});
    await panel.close();
    await target?.close();
    for (const page of context.pages()) if (page.url().startsWith('https://www.kimi.com/code/postora-test')) await page.close();
    await context.unroute(verificationRoute, verificationHandler);
    await new Promise((resolve) => server.close(resolve));
  }
}
