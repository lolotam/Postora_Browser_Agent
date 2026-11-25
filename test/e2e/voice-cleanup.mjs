import assert from 'node:assert/strict';
import http from 'node:http';

export async function runVoiceCleanupScenario(context, extensionId) {
  const tasks = [];
  let releaseFirst;
  let announceFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Voice cleanup fixture</h1>');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const lastUserMsg = body.messages.filter((message) => message.role === 'user').at(-1);
    const first = lastUserMsg && String(lastUserMsg.content).includes('Voice command one');
    tasks.push(first ? 'one' : 'two');
    console.log(`Voice cleanup: model request ${tasks.at(-1)}`);
    if (first) {
      announceFirst();
      await firstGate;
    }
    const report = first ? 'First voice command finished' : 'Second voice command finished';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `done-${tasks.length}`, type: 'function', function: { name: 'done', arguments: JSON.stringify({ report, success: true }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const panel = await context.newPage();
  const target = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (error) => pageErrors.push(error.message));
  let previous;
  try {
    await target.goto(origin);
    await panel.addInitScript(() => {
      const connect = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = (...args) => {
        const port = connect(...args);
        if (!String(port.name).startsWith('panel:')) return port;
        const addListener = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = (listener) => addListener((event) => {
          if (event.type === 'status' && !event.running) {
            window.__voiceCleanupHeld = { listener, event };
            return;
          }
          listener(event);
        });
        return port;
      };
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
      });
    });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    previous = await panel.evaluate(() => chrome.storage.local.get('settings'));
    await panel.evaluate(async (origin) => {
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await chrome.storage.local.set({ settings: mergeSettings({
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${origin}/v1`, model: 'fixture', apiKey: '' },
        fast: { enabled: false }, voiceEngine: 'postora', uiLanguage: 'en',
      }) });
    }, origin);
    await panel.reload();
    await panel.waitForFunction(() => document.querySelector('#sessionTitle')?.textContent.trim());
    console.log('Voice cleanup: panel ready');
    await target.bringToFront();
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    await panel.fill('#voiceTypedInput', 'Voice command one');
    await panel.press('#voiceTypedInput', 'Enter');
    console.log('Voice cleanup: first submitted');
    let firstTimer;
    try {
      await Promise.race([firstStarted, new Promise((_, reject) => {
        firstTimer = setTimeout(() => reject(new Error('The first voice command did not reach the model')), 10000);
      })]);
    } finally { clearTimeout(firstTimer); }
    console.log('Voice cleanup: first model started');
    await panel.fill('#voiceTypedInput', 'Voice command while busy');
    await panel.press('#voiceTypedInput', 'Enter');
    console.log('Voice cleanup: busy command submitted');
    assert.equal(await panel.locator('#voiceLog .voice-entry').count(), 2);
    assert.equal(await panel.locator('#voiceLog .voice-entry.dropped').count(), 1, 'a command submitted while busy is dropped as heard, not run');
    releaseFirst();
    console.log('Voice cleanup: first released');
    await panel.waitForFunction(() => document.querySelector('.msg.final')?.textContent.includes('First voice command finished'));
    console.log('Voice cleanup: first final visible');
    await panel.waitForTimeout(200);
    // While post-final worker cleanup (`status: { running: false }`) is still held,
    // the session is still busy: an utterance during cleanup is also dropped.
    await panel.fill('#voiceTypedInput', 'Voice command during cleanup');
    await panel.press('#voiceTypedInput', 'Enter');
    const held = await panel.evaluate(() => ({
      errors: [...document.querySelectorAll('#voiceLog .voice-entry.err')].map((node) => node.textContent),
      dropped: document.querySelectorAll('#voiceLog .voice-entry.dropped').length,
      succeeded: document.querySelectorAll('#voiceLog .voice-entry.ok').length,
    }));
    assert.deepEqual(tasks, ['one'], 'no command starts while the task or its cleanup is still running');
    assert.deepEqual(held.errors, [], 'dropped commands are not marked as errors');
    assert.equal(held.dropped, 2);
    assert.equal(held.succeeded, 1);
    await panel.evaluate(() => {
      const held = window.__voiceCleanupHeld;
      held.listener(held.event);
      window.__voiceCleanupHeld = null;
    });
    await panel.fill('#voiceTypedInput', 'Voice command two');
    await panel.press('#voiceTypedInput', 'Enter');
    await panel.waitForFunction(() => document.querySelectorAll('#voiceLog .voice-entry.ok').length === 2, { timeout: 15000 });
    assert.deepEqual(tasks, ['one', 'two']);
    assert.equal(await panel.locator('#voiceLog .voice-entry.err').count(), 0);
    console.log('VOICE CLEANUP PASSED: phrases while busy or cleaning up are dropped; a command after idle runs once.');
    return [];
  } catch (error) {
    const state = await panel.evaluate(() => ({
      activity: [...document.querySelectorAll('#voiceLog .voice-entry')].map((node) => node.textContent),
      messages: [...document.querySelectorAll('#messages .msg.error')].map((node) => node.textContent),
      settingsError: document.querySelector('#settingsError')?.textContent,
    })).catch(() => null);
    return [`Voice cleanup: ${error.stack ?? error}; panel ${JSON.stringify(state)}; page errors ${JSON.stringify(pageErrors)}`];
  } finally {
    releaseFirst();
    await panel.click('#voiceBackBtn').catch(() => {});
    if (previous) await panel.evaluate((saved) => chrome.storage.local.set(saved), previous).catch(() => {});
    await Promise.all([panel.close(), target.close()]);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
