// E2E verification for A6:
// After the fast layer re-indexes the page (`__agentElements`), a model call
// with an old index (or stale generation) is refused with the fresh page state
// and nothing is clicked; on the next turn the model clicks the updated index.

import http from 'node:http';

const REINDEX_PAGE = `<!doctype html><html><body>
<h1>Snapshot Generation Test</h1>
<div id="controls">
  <button id="btn-save" onclick="document.getElementById('out').textContent = 'saved'">Save</button>
</div>
<div id="out">ready</div>
<script>
window.insertDeleteBeforeSave = () => {
  const controls = document.getElementById('controls');
  if (document.getElementById('btn-delete')) return;
  const del = document.createElement('button');
  del.id = 'btn-delete';
  del.textContent = 'Delete';
  del.onclick = () => { document.getElementById('out').textContent = 'DELETED'; };
  controls.insertBefore(del, controls.firstChild);
};
</script>
</body></html>`;

function startGenerationServer({ onBeforeSecondFastStep }) {
  let llmTurn = 0;
  let jevTurn = 0;
  const seenToolOutputs = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        if (req.url === '/reindex') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(REINDEX_PAGE);
          return;
        }
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
          return;
        }
        if (req.url === '/v1/systemone') {
          jevTurn += 1;
          const choice = (picked) => ({ type: 'choice', choice: picked, confidence: 0.95, probabilities: { [picked]: 0.95 } });
          const answers = {
            operation: choice('think'),
            goal_done: { type: 'noul', noul: 0.05 },
            risky: { type: 'noul', noul: 0.05 },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            model: 'jev-mock',
            answers,
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          const body = JSON.parse(raw);
          const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
          if (lastTool) seenToolOutputs.push(lastTool);
          let scripted;
          if (llmTurn === 0) {
            // Turn 0: the initial fast-layer escalation showed generation 1 where [0] is "Save".
            // Save a note, then mutate the DOM before Turn 1's fast-layer step so [0] becomes "Delete" and [1] becomes "Save".
            scripted = ['note', { text: 'Save was at index 0' }];
          } else if (llmTurn === 1) {
            // Turn 1: the fast layer just re-indexed the page (generation 2), and escalated with fastActions=[].
            // Attempt to click the old index 0 (which is now "Delete"!). It must be refused with the fresh state.
            scripted = ['click', { index: 0, generation: 1 }];
          } else if (llmTurn === 2) {
            // Turn 2: now that the refusal returned the fresh page state, click the updated index 1 ("Save").
            const m = lastTool.match(/\[(\d+)\]\s+button "Save"/);
            const saveIndex = m ? Number(m[1]) : 1;
            scripted = ['click', { index: saveIndex }];
          } else {
            scripted = ['done', { success: true, report: '## Generation Verified\n- stale click refused, fresh Save clicked' }];
          }
          llmTurn += 1;
          if (llmTurn === 1) {
            // Schedule DOM mutation right after the note tool finishes, before the second fast-layer snapshot.
            setTimeout(() => { void onBeforeSecondFastStep?.(); }, 30);
          }
          const [name, args] = scripted;
          const id = `call_gen_${llmTurn}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
            { choices: [], usage: { prompt_tokens: 40, completion_tokens: 10 } },
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
    seenToolOutputs,
  })));
}

async function enableFullAccess(panel) {
  await panel.waitForFunction(() => Boolean(document.getElementById('accessSelect')?.value), { timeout: 10000 });
  if ((await panel.inputValue('#accessSelect')) === 'full-access') return;
  await panel.selectOption('#accessSelect', 'full-access');
  await panel.waitForSelector('#accessWarning[open]', { timeout: 10000 });
  await panel.check('#accessAcknowledge');
  await panel.click('#accessConfirm');
  await panel.waitForFunction(() => document.getElementById('accessSelect')?.value === 'full-access', { timeout: 10000 });
}

export async function runSnapshotGenerationScenario(context, extensionId) {
  const failures = [];
  let target = null;
  const { server, base, seenToolOutputs } = await startGenerationServer({
    onBeforeSecondFastStep: async () => {
      await target?.evaluate(() => window.insertDeleteBeforeSave?.());
    },
  });
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: 'test-key', model: 'mock-model', effort: '' },
        fast: { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl },
        vision: false,
        allowJavascript: false,
        showCursor: false,
        maxSteps: 10,
      },
    }), base);
    await panel.reload();
    await panel.waitForFunction(() => (document.getElementById('sessionTitle')?.textContent ?? '') !== '', { timeout: 15000 });

    target = await context.newPage();
    await target.goto(`${base}/reindex`);
    await target.bringToFront();

    await enableFullAccess(panel);
    await target.bringToFront();

    await panel.fill('#input', 'Click the Save button safely');
    await panel.evaluate(() => document.getElementById('sendBtn').click());
    await panel.waitForSelector('.msg.final', { timeout: 45000 });

    const outText = await target.textContent('#out');
    if (outText !== 'saved') {
      failures.push(`expected target #out to be "saved" (never "DELETED"), got "${outText}"`);
    }
    const refusedFound = seenToolOutputs.some((text) => /stale snapshot generation/i.test(text) && /button "Delete"/.test(text));
    if (!refusedFound) {
      failures.push(`expected stale generation refusal with fresh page state in tool outputs, got: ${JSON.stringify(seenToolOutputs)}`);
    }
    if (pageErrors.length) {
      failures.push(`panel page errors: ${pageErrors.join('; ')}`);
    }
    console.log('\n== scenario: snapshot-generation ==\n', { outText, refusedFound });
  } finally {
    await panel.evaluate(async () => {
      const pref = (await chrome.runtime.sendMessage({ type: 'get-access-preference' }))?.result;
      if (pref && pref.mode === 'full-access') {
        await chrome.runtime.sendMessage({
          type: 'set-access-remember',
          remember: false,
          expectedProfileRevision: pref.profileRevision,
        });
      }
      await chrome.storage.local.remove('accessPreference');
    }).catch(() => {});
    await target?.close().catch(() => {});
    await panel.close().catch(() => {});
    server.close();
  }
  return failures;
}
