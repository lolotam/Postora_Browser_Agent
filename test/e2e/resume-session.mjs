import assert from 'node:assert/strict';
import http from 'node:http';

export async function runResumeSessionScenario(context, extensionId) {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      let data = ''; for await (const chunk of req) data += chunk;
      requestBody = JSON.parse(data);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'done-1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ report: 'Resumed successfully', success: true }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Resume fixture</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = await context.newPage();
  const panel = await context.newPage();
  let previous;
  let session;
  try {
    await target.goto(origin);
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    const setup = await panel.evaluate(async (origin) => {
      const previous = (await chrome.storage.local.get('settings')).settings;
      const { mergeSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      const store = await import(chrome.runtime.getURL('src/sessions/store.js'));
      await chrome.storage.local.set({ settings: mergeSettings({ provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${origin}/v1`, model: 'fixture' }, fast: { enabled: false }, uiLanguage: 'en' }) });
      const meta = await store.createStoredSession('Resume fixture');
      const transcript = Array.from({ length: 60 }, (_, i) => ({ type: i % 2 ? 'assistant-text' : 'user', text: `HISTORY-MARKER-${i}` }));
      transcript.push({ type: 'user', text: 'Finish the test task' }, { type: 'stopped' });
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`);
      await store.saveSession(meta.id, { transcript, log: { task: 'Finish the test task', notes: [], steps: [], last: null }, continuation: { task: 'Finish the test task', tabId: tab.id } });
      await chrome.runtime.sendMessage({ type: 'bind-tab', tabId: tab.id, sessionId: meta.id });
      return { previous, session: meta.id, tabId: tab.id };
    }, origin);
    previous = setup.previous; session = setup.session;
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html?tabId=${setup.tabId}`);
    await panel.waitForSelector('#resumeRow:not([hidden])');
    await panel.click('#resumeBtn');
    await panel.waitForFunction(() => document.querySelector('.msg.final')?.textContent.includes('Resumed successfully'));
    await panel.waitForSelector('#resumeRow', { state: 'hidden' });
    for (let i = 0; i < 60; i++) assert.ok(JSON.stringify(requestBody).includes(`HISTORY-MARKER-${i}`), `missing prior message ${i}`);
    const saved = await panel.evaluate(async (id) => {
      await chrome.runtime.sendMessage({ type: 'backup-export' });
      return (await chrome.storage.local.get(`session:${id}`))[`session:${id}`];
    }, session);
    assert.equal(saved.transcript.filter((e) => e.type === 'user').length, 31, 'resume must not insert a user chat message');
    assert.equal(saved.continuation, null);
    await panel.reload();
    await panel.waitForFunction(() => document.querySelector('.msg.final')?.textContent.includes('Resumed successfully'));
    assert.equal(await panel.locator('#resumeRow').isVisible(), false);
    console.log('RESUME PASSED: checkpoint button, all 60 prior messages, no fabricated chat message, no resume after report.');
    return [];
  } catch (error) { return [`Resume: ${error.stack ?? error}`]; }
  finally {
    if (session) await panel.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'session-delete', id }), session).catch(() => {});
    if (previous) await panel.evaluate((settings) => chrome.storage.local.set({ settings }), previous).catch(() => {});
    await Promise.all([panel.close(), target.close()]);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
