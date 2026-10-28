// Stop a worker while an observational session-list request is in flight.
// The cached list must remain intact; a later explicit refresh must recover.
export async function runSessionRefreshRestartScenario(context, extensionId) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.addInitScript(() => {
    window.__failedRequests = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message, ...args) => {
      try { return await send(message, ...args); }
      catch (error) { window.__failedRequests.push(message?.type); throw error; }
    };
  });
  let worker;
  let patched = false;
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate(() => chrome.storage.local.set({ settings: {
      provider: 'compatible', compatible: { preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'mock-model' }, fast: { enabled: false }, uiLanguage: 'en',
    } }));
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent === 'mock-model' && document.getElementById('sessionTitle').textContent);
    await panel.click('#sessionBtn');
    await panel.waitForSelector('#sessionList .session-item');
    const before = await panel.textContent('#sessionList');
    await panel.click('#sessionBtn');
    worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${extensionId}/`));
    await worker.evaluate(() => {
      const original = chrome.storage.local.get;
      globalThis.__sessionsOriginalGet = original;
      globalThis.__sessionListBlocked = false;
      chrome.storage.local.get = (key, ...args) => {
        if (key !== 'sessions') return original(key, ...args);
        globalThis.__sessionListBlocked = true;
        return new Promise(() => {});
      };
    });
    patched = true;
    await panel.click('#sessionBtn');
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100 && !globalThis.__sessionListBlocked; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!globalThis.__sessionListBlocked) throw new Error('The session-list read was not held');
    });
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    patched = false;
    await panel.waitForFunction(() => window.__failedRequests.includes('sessions-list'));
    const failures = [];
    if (errors.length) failures.push(`session refresh restart: ${errors.join(' | ')} (requests: ${JSON.stringify(await panel.evaluate(() => window.__failedRequests))})`);
    if (await panel.textContent('#sessionList') !== before) failures.push('a failed session refresh discarded the cached list');
    const status = panel.locator('#sessionListStatus');
    if (!await status.isVisible()) failures.push('a failed session refresh has no recovery status');
    await panel.click('#sessionBtn');
    await panel.click('#sessionBtn');
    await panel.waitForSelector('#sessionList .session-item');
    if (await status.count()) await status.waitFor({ state: 'hidden', timeout: 10000 });
    console.log(`\n== scenario: session-refresh-restart ==\n${failures.length ? failures.join('\n') : 'interrupted read preserved the list and recovered on explicit refresh'}`);
    return failures;
  } finally {
    if (patched) await worker?.evaluate(() => { chrome.storage.local.get = globalThis.__sessionsOriginalGet; }).catch(() => {});
    await panel.close();
  }
}
