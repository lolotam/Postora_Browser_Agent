// E2E verification for A5:
// - A page opening `confirm` and `prompt` is answered before timeout via the `dialog` tool.
// - An `alert` dialog is dismissed via the `dialog` tool.
// - Pressing Stop while a task/dialog is active dismisses the dialog and returns the panel to idle within 2 s.

import http from 'node:http';

const DIALOG_PAGE = `<!doctype html><html><body>
<h1>Dialog test page</h1>
<button id="btn-confirm" onclick="setTimeout(() => { window.__confirmResult = confirm('Confirm order #42?'); document.getElementById('out').textContent = 'confirm=' + window.__confirmResult; }, 10)">Open confirm</button>
<button id="btn-prompt" onclick="setTimeout(() => { window.__promptResult = prompt('Enter coupon code:', 'NONE'); document.getElementById('out').textContent += ' prompt=' + window.__promptResult; }, 10)">Open prompt</button>
<button id="btn-alert" onclick="setTimeout(() => { alert('Order saved!'); document.getElementById('out').textContent += ' alert=closed'; }, 10)">Open alert</button>
<button id="btn-hang" onclick="setTimeout(() => { window.__stuckConfirmOpened = true; window.__stuckConfirmResult = confirm('Stuck confirm?'); window.__stuckConfirmDismissed = (window.__stuckConfirmResult === false); }, 10)">Open stuck dialog</button>
<div id="out">ready</div>
</body></html>`;

function findIndex(text, label) {
  const m = text.match(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`));
  if (!m) throw new Error(`Could not find button "${label}" in:\n${text}`);
  return Number(m[1]);
}

function startDialogServer() {
  let turn = 0;
  let mode = 'answer-all';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        if (req.url === '/dialogs') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DIALOG_PAGE);
          return;
        }
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          const body = JSON.parse(raw);
          const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
          let scripted;
          if (mode === 'stop-test') {
            if (turn === 0) scripted = ['read_page', {}];
            else if (turn === 1) scripted = ['click', { index: findIndex(lastTool, 'Open stuck dialog') }];
            else {
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 10000);
                req.once('close', () => {
                  clearTimeout(timer);
                  resolve();
                });
              });
              scripted = ['done', { success: true, report: 'should have been stopped' }];
            }
            turn += 1;
          } else {
            if (turn === 0) scripted = ['read_page', {}];
            else if (turn === 1) scripted = ['click', { index: findIndex(lastTool, 'Open confirm') }];
            else if (turn === 2) scripted = ['dialog', { accept: true }];
            else if (turn === 3) scripted = ['click', { index: findIndex(lastTool, 'Open prompt') }];
            else if (turn === 4) scripted = ['dialog', { accept: true, prompt_text: 'SAVE20' }];
            else if (turn === 5) scripted = ['click', { index: findIndex(lastTool, 'Open alert') }];
            else if (turn === 6) scripted = ['dialog', { accept: false }];
            else scripted = ['done', { success: true, report: `## Dialogs Done\n- ${lastTool.match(/confirm=[^\n]*/)?.[0] ?? 'missing'}` }];
            turn += 1;
          }
          const [name, args] = scripted;
          const id = `call_dlg_${turn}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
            { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500).end(err.message);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    setMode(nextMode) {
      mode = nextMode;
      turn = 0;
    },
  })));
}

async function enableFullAccess(panel) {
  await panel.bringToFront();
  await panel.waitForFunction(() => document.getElementById('accessState')?.textContent?.trim(), { timeout: 15000 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await panel.evaluate(() => document.getElementById('accessSelect')?.value === 'full-access')) return true;
    await panel.selectOption('#accessSelect', 'full-access');
    if (await panel.evaluate(() => document.getElementById('accessSelect')?.value === 'full-access')) return true;
    const opened = await panel.waitForSelector('#accessWarning[open]', { timeout: 15000 }).then(() => true, () => false);
    if (!opened) continue;
    await panel.check('#accessAcknowledge', { timeout: 15000 });
    await panel.click('#accessConfirm', { timeout: 15000 });
    const confirmed = await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 15000 })
      .then(() => true, () => false);
    if (confirmed) return true;
  }
  return false;
}

export async function runDialogsAndStopScenario(context, extensionId) {
  const { server, base, setMode } = await startDialogServer();
  const panel = await context.newPage();
  let target = null;
  const failures = [];
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        transcription: { mode: 'browser' },
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('modelQuickLabel')?.textContent?.includes('mock-model'), { timeout: 15000 });
    await panel.waitForSelector('#chatView:not([hidden])', { timeout: 15000 });
    await panel.click('#newChatBtn');
    if (!(await enableFullAccess(panel))) failures.push('could not enable Full access for dialogs scenario');

    target = await context.newPage();
    target.on('dialog', () => {});
    await target.goto(`${base}/dialogs`);
    await target.bringToFront();

    await panel.fill('#input', 'Answer the confirm, prompt, and alert dialogs');
    await panel.evaluate(() => document.getElementById('sendBtn').click());

    const final = await panel.waitForSelector('.msg.final', { timeout: 25000 });
    const report = await final.innerText();
    const outText = await target.textContent('#out');
    if (!outText.includes('confirm=true') || !outText.includes('prompt=SAVE20') || !outText.includes('alert=closed')) {
      failures.push(`dialog results mismatch on page: "${outText}" (report: "${report}")`);
    }

    // Now test pressing Stop while a dialog-opening task is running: panel must return to idle within 2 s,
    // and the open dialog on the page must be dismissed before cleanup.
    setMode('stop-test');
    let resolveStuckDialog;
    const stuckDialogOpened = new Promise((resolve) => { resolveStuckDialog = resolve; });
    target.on('dialog', (dlg) => {
      if (dlg.message() === 'Stuck confirm?') resolveStuckDialog();
    });
    await target.bringToFront();
    await panel.fill('#input', 'Open stuck dialog and wait');
    await panel.evaluate(() => document.getElementById('sendBtn').click());
    await panel.waitForSelector('#stopBtn:not([hidden])', { timeout: 15000 });
    await stuckDialogOpened;
    const stopStarted = Date.now();
    await panel.evaluate(() => document.getElementById('stopBtn').click());
    await panel.waitForSelector('#stopBtn[hidden]', { state: 'attached', timeout: 2000 });
    await target.waitForFunction(() => window.__stuckConfirmDismissed === true, { timeout: 2000 });
    const stopElapsed = Date.now() - stopStarted;
    if (stopElapsed > 2000) {
      failures.push(`pressing Stop took ${stopElapsed}ms (> 2000ms) to return panel to idle and dismiss the dialog`);
    }
    return failures;
  } finally {
    await panel.evaluate(() => chrome.storage.local.remove('accessPreference')).catch(() => {});
    await target?.close().catch(() => {});
    await panel.close().catch(() => {});
    server.closeAllConnections?.();
    server.close();
  }
}
