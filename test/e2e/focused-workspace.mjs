// Real settings/draft/model-dialog regressions. Providers, keys and failures
// are synthetic; no account sign-in or physical microphone is used.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function runFocusedWorkspaceScenario(context, extensionId) {
  let releaseSlow = () => {};
  let slowRequested;
  const slowArrival = new Promise((resolve) => { slowRequested = resolve; });
  const server = http.createServer((req, res) => {
    const respond = () => {
      if (res.destroyed) return;
      if (req.url.startsWith('/fail/')) {
        res.writeHead(503).end('Synthetic model-list failure');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        data: req.url.startsWith('/other/') ? [{ id: 'draft-provider-model' }]
          : [{ id: 'mock-current' }, { id: 'mock-alternative' }],
      }));
    };
    if (req.url.startsWith('/slow/')) { releaseSlow = respond; slowRequested(); }
    else respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  let patchedWorker;
  const slot = { provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${base}/v1`, apiKey: '', model: 'mock-current', effort: '' } };

  const saved = () => panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  async function reset(overrides = {}) {
    await panel.evaluate(async (settings) => {
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await chrome.storage.local.set({ settings: mergeSettings(settings) });
    }, { ...slot, fallback: { ...slot, enabled: false }, fast: { enabled: false }, maxSteps: 40, uiLanguage: 'en', ...overrides });
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel')?.textContent === 'mock-current');
    await panel.waitForFunction(() => document.getElementById('sessionTitle')?.textContent.trim());
  }
  async function page(section) {
    if (await panel.isHidden('#settingsView')) await panel.click('#settingsBtn');
    for (let n = 0; n < 3 && await panel.isHidden('#settingsIndex'); n++) await panel.click('#closeSettingsBtn');
    await panel.click(`#settingsRow${section}`);
  }
  async function chat() {
    for (let n = 0; n < 4 && !await panel.isHidden('#settingsView'); n++) await panel.click('#closeSettingsBtn');
    await panel.waitForSelector('#chatView:not([hidden])');
  }
  async function choose(button, model) {
    await panel.click(button);
    await panel.waitForSelector(`#modelDialogList [data-value="${model}"]`, { state: 'visible' });
    await panel.fill('#modelDialogSearch', model);
    await panel.press('#modelDialogSearch', 'Enter');
    await panel.waitForSelector('#modelDialog', { state: 'hidden' });
  }

  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await reset();
    assert.equal(await panel.isVisible('#modelDialog'), false, 'a closed dialog must not intercept clicks');

    await page('Account');
    await panel.click('#accountRowBtn');
    await panel.waitForSelector('#accountMenu:not([hidden])');
    await panel.keyboard.press('Escape');
    assert.equal(await panel.isVisible('#page-account'), true, 'one Escape dismisses only the popup');
    assert.equal(await panel.evaluate(() => document.activeElement.id), 'accountRowBtn');
    await panel.click('#overflowBtn');
    await panel.click('#accountBtn');
    await panel.waitForSelector('#accountMenu:not([hidden])');
    await panel.keyboard.press('Escape');
    assert.equal(await panel.evaluate(() => document.activeElement.id), 'overflowBtn');

    await page('Behavior');
    await panel.fill('#maxSteps', '99');
    await panel.click('#closeSettingsBtn');
    assert.equal(await panel.isVisible('#settingsFooter'), true, 'index keeps draft Save/Cancel reachable');
    await panel.click('#settingsRowLanguage');
    await panel.check('#replyLangEnabled'); // deliberately incomplete unrelated draft
    await panel.selectOption('#uiLanguage', 'en'); // explicit en must replace saved auto if selected
    await chat();
    await choose('#modelQuickBtn', 'mock-alternative');
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent === 'mock-alternative');
    let settings = await saved();
    assert.equal(settings.maxSteps, 40, 'quick selection must not commit unrelated behavior');
    assert.equal(settings.replyLanguage.enabled, false, 'unrelated invalid draft must not block or leak into quick save');
    await page('Behavior');
    assert.equal(await panel.inputValue('#maxSteps'), '99', 'the unrelated draft is retained');
    await panel.click('#closeSettingsBtn');
    await panel.click('#saveBtn');
    await panel.waitForSelector('#page-language:not([hidden])');
    assert.equal(await panel.isVisible('#settingsError'), true, 'validation routes to the owning page');
    await panel.click('#cancelSettingsBtn');
    settings = await saved();
    assert.equal(settings.compatible.model, 'mock-alternative', 'Cancel cannot undo the earlier successful quick save');
    await page('Models');
    await panel.click('#settingsRowMain');
    assert.equal(await panel.textContent('#modelMainLabel'), 'mock-alternative', 'later form Save cannot resurrect the old model');
    await panel.click('#cancelSettingsBtn');

    // Different endpoints still share provider='compatible'. The quick catalog
    // must use the saved endpoint, never the unsaved form's catalog.
    await reset();
    await page('Models');
    await panel.click('#settingsRowMain');
    await panel.fill('#baseUrl', `${base}/other`);
    await panel.click('#modelBtnMain');
    await panel.click('#modelDialogRefresh');
    await panel.waitForSelector('#modelDialogList [data-value="draft-provider-model"]');
    await panel.click('#modelDialogClose');
    await chat();
    await panel.click('#modelQuickBtn');
    await panel.waitForSelector('#modelDialogList [data-value="mock-alternative"]');
    assert.equal(await panel.locator('#modelDialogList [data-value="draft-provider-model"]').count(), 0);
    await panel.click('#modelDialogClose');
    await page('Models');
    await panel.click('#settingsRowMain');
    assert.equal(await panel.inputValue('#baseUrl'), `${base}/other`);
    await panel.click('#cancelSettingsBtn');

    // Both provider slots and both fast slots are actual fields, not demo picks.
    await reset();
    await page('Models');
    await panel.check('#fallbackEnabled');
    await panel.click('#settingsRowBackup');
    await choose('#modelBtnBackup', 'mock-alternative');
    await page('Fast');
    await panel.check('#fastEnabled');
    await panel.fill('#fastApiKey', 'SYNTHETIC-FAST-KEY');
    await panel.click('#modelBtnFast');
    assert.equal(await panel.inputValue('#modelDialogManualInput'), 'jev-latest');
    assert.equal(await panel.isVisible('#modelDialogClose'), true, 'manual-only dialog keeps a visible close action');
    assert.equal(await panel.isVisible('#modelDialogRefresh'), false);
    await panel.fill('#modelDialogManualInput', 'SYNTHETIC-CANCELLED-ID');
    await panel.click('#modelDialogClose');
    await panel.click('#modelBtnFast');
    assert.equal(await panel.inputValue('#modelDialogManualInput'), 'jev-latest', 'cancelled manual text is not retained');
    await panel.fill('#modelDialogManualInput', 'fast-manual');
    await panel.click('#modelDialogManualSave');
    await panel.check('#fastFallbackEnabled');
    await panel.click('#modelBtnFastBackup');
    assert.equal(await panel.inputValue('#modelDialogManualInput'), 'jev-latest', 'a new slot never inherits another slot\'s manual text');
    await panel.fill('#modelDialogManualInput', 'backup-manual');
    await panel.click('#modelDialogManualSave');
    await panel.click('#saveBtn');
    await panel.waitForSelector('#settingsView', { state: 'hidden' });
    settings = await saved();
    assert.equal(settings.compatible.model, 'mock-current');
    assert.equal(settings.fallback.compatible.model, 'mock-alternative');
    assert.equal(settings.fast.model, 'fast-manual');
    assert.equal(settings.fast.fallback.model, 'backup-manual');

    // A delayed list updates an already open dialog; a failed refresh remains
    // readable there. Escape closes only the dialog, not the provider page.
    await reset();
    await page('Models');
    await panel.click('#settingsRowMain');
    await panel.fill('#baseUrl', `${base}/slow/v1`);
    await panel.click('#modelBtnMain');
    await panel.click('#modelDialogRefresh');
    await panel.waitForSelector('#modelDialogStatus:not([hidden])');
    await panel.waitForFunction(() => document.getElementById('modelDialogRefresh').disabled);
    await slowArrival;
    releaseSlow();
    await panel.waitForSelector('#modelDialogList [data-value="mock-alternative"]', { state: 'visible' });
    await panel.keyboard.press('Escape');
    assert.equal(await panel.isVisible('#page-provider-main'), true);
    await panel.fill('#baseUrl', `${base}/fail/v1`);
    await panel.click('#modelBtnMain');
    await panel.click('#modelDialogRefresh');
    await panel.waitForSelector('#modelDialogStatus.error');
    assert.match(await panel.textContent('#modelDialogStatus'), /HTTP 503/);
    await panel.click('#modelDialogClose');
    await panel.click('#cancelSettingsBtn');

    // Storage rejection must preserve the saved model and unsaved form, with
    // an actionable error instead of an unhandled promise rejection.
    await reset({ uiLanguage: 'auto' });
    await page('Language');
    await panel.selectOption('#uiLanguage', 'en');
    await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.uiLanguage === 'en');
    await chat();
    patchedWorker = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`));
    await patchedWorker.evaluate(() => {
      globalThis.__focusedStorageSet = chrome.storage.local.set;
      chrome.storage.local.set = (values, ...args) => values.settings
        ? Promise.reject(new Error('SYNTHETIC-SAVE-FAILURE')) : globalThis.__focusedStorageSet(values, ...args);
    });
    await choose('#modelQuickBtn', 'mock-alternative');
    await panel.waitForSelector('#settingsError:not([hidden])');
    assert.equal((await saved()).compatible.model, 'mock-current');
    await page('Behavior');
    await panel.fill('#maxSteps', '88');
    await panel.click('#saveBtn');
    await panel.waitForSelector('#settingsError:not([hidden])');
    assert.equal(await panel.inputValue('#maxSteps'), '88');
    assert.equal((await saved()).maxSteps, 40);
    assert.equal(await panel.isEnabled('#saveBtn'), true);
    assert.deepEqual(errors, []);
    console.log('\n== scenario: focused-workspace ==\ndrafts, all model slots, callbacks, loading and save failures behaved');
    return [];
  } catch (error) {
    const view = await panel.evaluate(() => ({
      settingsHidden: document.getElementById('settingsView').hidden,
      title: document.getElementById('settingsTitle').textContent,
      pages: [...document.querySelectorAll('.settings-page')].filter((node) => !node.hidden).map((node) => node.id),
    })).catch(() => null);
    return [`focused workspace: ${error.stack ?? error.message}\nView: ${JSON.stringify(view)}`];
  } finally {
    await patchedWorker?.evaluate(() => {
      if (globalThis.__focusedStorageSet) chrome.storage.local.set = globalThis.__focusedStorageSet;
      delete globalThis.__focusedStorageSet;
    }).catch(() => {});
    releaseSlow();
    await panel.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
