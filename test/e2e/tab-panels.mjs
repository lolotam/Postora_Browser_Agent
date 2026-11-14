import assert from 'node:assert/strict';

export async function runTabPanelsScenario(context, extensionId) {
  const control = await context.newPage();
  const a = await context.newPage();
  const b = await context.newPage();
  try {
    await a.goto('data:text/html,<title>Panel owner A</title>');
    await b.goto('data:text/html,<title>Panel owner B</title>');
    await control.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    const ids = await control.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return { a: tabs.find((tab) => tab.title === 'Panel owner A').id, b: tabs.find((tab) => tab.title === 'Panel owner B').id };
    });
    await control.evaluate(async () => {
      window.__panelOpened = [];
      chrome.sidePanel.onOpened?.addListener((info) => window.__panelOpened.push(info.tabId));
      const { openTabPanel } = await import(chrome.runtime.getURL('src/background/tab-panels.js'));
      const button = document.createElement('button');
      button.id = 'testOpenTabPanel'; button.textContent = 'Open tab panel';
      button.addEventListener('click', async () => {
        try { await openTabPanel(window.__targetTab); window.__panelResult = 'opened'; }
        catch (error) { window.__panelResult = error.message; }
      });
      document.body.append(button);
    });
    for (const id of [ids.a, ids.b]) {
      await control.evaluate((id) => { window.__targetTab = id; window.__panelResult = null; }, id);
      await control.click('#testOpenTabPanel');
      await control.waitForFunction(() => window.__panelResult !== null);
      assert.equal(await control.evaluate(() => window.__panelResult), 'opened', 'real gesture can open a tab-specific panel');
      const options = await control.evaluate(async (ids) => ({
        default: await chrome.sidePanel.getOptions({}),
        a: await chrome.sidePanel.getOptions({ tabId: ids.a }),
        b: await chrome.sidePanel.getOptions({ tabId: ids.b }),
      }), ids);
      assert.equal(options.default.enabled, false);
      assert.equal(options.a.path, `src/sidepanel/index.html?tabId=${ids.a}`);
      assert.equal(options.b.path, `src/sidepanel/index.html?tabId=${ids.b}`);
      if (id === ids.a) {
        await b.bringToFront();
        await control.bringToFront();
        assert.equal(await control.evaluate((other) => window.__panelOpened.includes(other), ids.b), false, 'visiting prepared B must not open its panel');
      }
    }
    // Even when rendered as a test tab, an explicit panel owner must bind the
    // conversation to its owner, not the active tab or the panel's own tab.
    await control.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html?tabId=${ids.a}`);
    await control.waitForFunction(() => document.querySelector('#sessionTitle')?.textContent.trim());
    const sessions = await control.evaluate(async (ids) => {
      const ask = async (tabId) => (await chrome.runtime.sendMessage({ type: 'tab-session', tabId })).result;
      return { a: await ask(ids.a), b: await ask(ids.b), own: await ask((await chrome.tabs.getCurrent()).id) };
    }, ids);
    assert.notEqual(sessions.a, sessions.b);
    assert.notEqual(sessions.a, sessions.own);
    await control.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'session-rename', id, title: 'Owner A chat' }), sessions.a);
    await control.reload();
    await control.waitForFunction(() => document.querySelector('#sessionTitle')?.textContent === 'Owner A chat');
    if (await control.locator('#settingsView').isVisible()) await control.click('#cancelSettingsBtn');
    await control.selectOption('#accessSelect', 'full-access');
    await control.waitForSelector('#accessWarning[open]');
    await control.check('#accessAcknowledge');
    await control.click('#accessConfirm');
    await control.waitForSelector('#accessSelect.risk');
    assert.equal(await control.inputValue('#accessSelect'), 'full-access');
    await control.selectOption('#accessSelect', 'ask-first');
    await control.waitForFunction(() => !document.querySelector('#accessSelect').classList.contains('risk'));
    await b.bringToFront();
    await control.bringToFront();
    assert.equal(await control.locator('#sessionTitle').textContent(), 'Owner A chat');
    console.log('TAB PANELS PASSED: real gesture, per-tab options, no global panel, independent sessions.');
    return [];
  } catch (error) { return [`Tab panels: ${error.stack ?? error}`]; }
  finally { await Promise.all([control.close(), a.close(), b.close()]); }
}
