// End-to-end check: loads the unpacked extension into Chromium, points it at
// scripted mock models, and verifies the agent really acts on a local page.
//
// Scenario "llm":  an OpenAI-compatible mock LLM drives every step (types,
//                  selects, clicks, screenshots, reads, reports).
// Scenario "fast": a mock Jev (TypeSafe System One) fast layer types and clicks
//                  on its own; the LLM is called once, only to write the report.
//
//   npm install && npm run e2e
//   CHROMIUM_PATH=/path/to/chrome npm run e2e   (if Playwright's browser is not installed)
//   E2E_SCREENSHOTS=out E2E_COLOR_SCHEME=dark npm run e2e   (save the panel after each scenario for visual review)
//   E2E_EXTENSION_DIR=<unpacked store zip> npm run e2e        (run the scenarios on the store build)

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// The sign-in scenario mocks OpenAI for the service worker's own requests,
// which Playwright routes only with this switch on.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

// E2E_EXTENSION_DIR runs the same scenarios on another copy, such as the unpacked store build.
const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGE = `<!doctype html><html><body>
<h1>Agent test page</h1>
<input id="q" name="q" placeholder="Search">
<select id="color"><option>Red</option><option>Blue</option></select>
<button id="go" onclick="document.getElementById('out').textContent = 'Result: ' + q.value + ' / ' + color.value">Go</button>
<div id="out"></div>
<!-- Like GitHub releases: the shown date lives in a shadow root, and two releases read the same. -->
<section><h2><a href="#r2">v9.1.0</a></h2><relative-time datetime="2026-10-08T10:00:00Z"></relative-time></section>
<section><h2><a href="#r1">v9.0.0</a></h2><relative-time datetime="2026-10-08T09:00:00Z"></relative-time></section>
<!-- A title that repeats the date's words keeps them. -->
<h2>Yesterday's update <time datetime="2026-10-03T00:00:00Z">Yesterday</time></h2>
<!-- A date-only link inside the heading that names it. -->
<h2>Launch day <a href="#launch"><time datetime="2026-10-05T00:00:00Z">Last week</time></a></h2>
<!-- The mobile layout's copy of v9.1.0's date: one release, one line. -->
<section><h2><a href="#r2">v9.1.0</a></h2><time datetime="2026-10-08T10:00:00Z">Oct 8</time></section>
<!-- Valid, though its UTC instant falls on the day before. -->
<section><h2>v8.9.0</h2><time datetime="2026-10-10T00:30:00+02:00">Oct 10</time></section>
<script>customElements.define('relative-time', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).textContent = '2 days ago'; } });</script>
</body></html>`;

// Two suggestion widgets on one page. Subject: chips, its list inside the widget and
// left open after a choice (so the City step must not use it). City: a combobox whose
// list is a portal at the end of <body>, filled 700 ms after typing; a "Recent" list
// beside the field is not the one it names, so its "Pune" must never be clicked.
const WIDGETS = `<!doctype html><html><body>
<h1>Widgets</h1>
<form onsubmit="return false">
<div class="subject"><span id="chips"></span><input id="subject" placeholder="Subject" autocomplete="off"></div>
<div class="city"><input id="city" role="combobox" aria-controls="city-list" aria-expanded="false" placeholder="City" autocomplete="off">
<div role="listbox" aria-label="Recent"><div role="option">Pune</div></div></div>
<button id="go" onclick="document.getElementById('out').textContent = 'Result: ' + [...document.querySelectorAll('#chips span')].map((c) => c.textContent).join('+') + ' / ' + city.value">Go</button>
</form>
<div id="out"></div>
<ul id="city-list" role="listbox" hidden></ul>
<script>
const subjectBox = document.querySelector('.subject');
subject.addEventListener('input', () => {
  subjectBox.querySelector('[role=listbox]')?.remove();
  const list = document.createElement('div');
  list.setAttribute('role', 'listbox');
  for (const name of ['Maths', 'Math History', 'Physics'].filter((n) => n.toLowerCase().includes(subject.value.toLowerCase()))) {
    const o = document.createElement('div');
    o.setAttribute('role', 'option');
    o.textContent = name;
    o.onclick = () => { const chip = document.createElement('span'); chip.textContent = name; chips.append(chip); subject.value = ''; };
    list.append(o);
  }
  subjectBox.append(list);
});
let cityTimer = 0;
city.addEventListener('input', () => {
  clearTimeout(cityTimer);
  const list = document.getElementById('city-list');
  list.hidden = true;
  cityTimer = setTimeout(() => {
    list.replaceChildren(...['Delhi', 'New Delhi', 'Mumbai'].filter((n) => n.toLowerCase().includes(city.value.toLowerCase())).map((name) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = name;
      li.onclick = () => { city.value = name; list.hidden = true; city.setAttribute('aria-expanded', 'false'); };
      return li;
    }));
    list.hidden = false;
    city.setAttribute('aria-expanded', 'true');
  }, 700);
});
</script>
</body></html>`;

const find = (text, re) => {
  const m = text.match(re);
  if (!m) throw new Error(`mock could not find ${re} in:\n${text}`);
  return m[1];
};

// The page the voice scenario acts on: a button to click, a field to type in,
// and two fields that hold a secret and must never be read or written.
const VOICE_PAGE = `<!doctype html><html><body>
<h1>Voice test page</h1>
<button id="go">Go</button>
<input id="search" placeholder="Search">
<input id="pw" type="password" placeholder="Password">
<input id="code" autocomplete="one-time-code" placeholder="Code">
<div id="out" data-n="0"></div>
<script>
document.getElementById('go').addEventListener('click', () => {
  const out = document.getElementById('out');
  const n = Number(out.dataset.n || 0) + 1;
  out.dataset.n = String(n);
  out.textContent = 'clicked ' + n;
});
</script>
</body></html>`;

/** Mock LLM for the "llm" scenario: drives the whole task itself. */
/** With askFirst the run starts by asking the user, so it stays running until a test answers. */
function scriptedLlm({ askFirst = false } = {}) {
  let sawImage = false;
  let sawDates = false;
  const steps = [
    ...(askFirst ? [() => ['ask_user', { question: 'Shall I start?' }]] : []),
    () => ['read_page', {}],
    (last) => ['type_text', { index: Number(find(last, /\[(\d+)\] input[^\n]*placeholder="Search"/)), text: 'hello world' }],
    (last) => ['select_option', { index: Number(find(last, /\[(\d+)\] select/)), option: 'Blue' }],
    (last) => ['click', { index: Number(find(last, /\[(\d+)\] button "Go"/)) }],
    () => ['screenshot', {}],
    () => ['get_text', {}],
    (last) => ['done', { success: true, report: `## Done\n- ${last.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- screenshot seen: ${sawImage}\n- dates seen: ${sawDates}` }],
  ];
  let turn = 0;
  return (body) => {
    const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    const lastUser = body.messages.at(-1);
    if (Array.isArray(lastUser.content) && lastUser.content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg'))) sawImage = true;
    // Both releases read "2 days ago": each date must come with its own release name.
    if (/v9\.1\.0 · 2 days ago — 2026-10-08T10:00:00Z/.test(lastTool) && /v9\.0\.0 · 2 days ago — 2026-10-08T09:00:00Z/.test(lastTool)
      && /v8\.9\.0 · Oct 10 — 2026-10-10T00:30:00\+02:00/.test(lastTool)
      && !/Oct 8 — 2026-10-08T10:00:00Z/.test(lastTool)
      && lastTool.includes('Launch day · Last week — 2026-10-05T00:00:00Z')
      && lastTool.includes("Yesterday's update · Yesterday — 2026-10-03T00:00:00Z")) sawDates = true;
    return steps[Math.min(turn++, steps.length - 1)](lastTool);
  };
}

/** Mock LLM for the "suggestions" scenario: autocomplete widgets through choose_suggestion. */
function suggestionLlm() {
  const seen = [];
  const field = (last, placeholder) => Number(find(last, new RegExp(String.raw`\[(\d+)\] input[^\n]*placeholder="${placeholder}"`)));
  const steps = [
    () => ['read_page', {}],
    (last) => ['choose_suggestion', { index: field(last, 'Subject'), text: 'Math', option: 'Maths' }],
    (last) => {
      seen.push(/Chose "Maths"/.test(last) ? 'subject ok' : 'subject FAILED');
      return ['choose_suggestion', { index: field(last, 'City'), text: 'Del', option: 'Pune' }];
    },
    (last) => {
      // Only the City list is offered, never the Subject list still open beside it.
      const offered = last.match(/^Not chosen: No option reads exactly "Pune".*Options shown: (.*?)\. Call again/)?.[1];
      seen.push(offered === '"Delhi", "New Delhi"' ? 'refusal ok' : `refusal FAILED (${offered})`);
      return ['choose_suggestion', { index: field(last, 'City'), text: 'Del', option: 'Delhi' }];
    },
    (last) => {
      seen.push(/Chose "Delhi"/.test(last) ? 'city ok' : 'city FAILED');
      return ['click', { index: Number(find(last, /\[(\d+)\] button "Go"/)) }];
    },
    (last) => ['done', { success: true, report: `## Done\n- ${last.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- checks: ${seen.join(', ')}` }],
  ];
  let turn = 0;
  return (body) => {
    const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    return steps[Math.min(turn++, steps.length - 1)](lastTool);
  };
}

/** Mock LLM for the "steer" scenario: thinks slowly once, so the test can message it mid-task. */
function slowThinkerLlm() {
  let turn = 0;
  return async (body) => {
    turn += 1;
    if (turn === 1) {
      await new Promise((r) => setTimeout(r, 2500));
      return ['read_page', {}];
    }
    const steered = body.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && /Message from the user while you work[\s\S]*use blue/.test(m.content));
    return ['done', { success: true, report: `## Done
- steer seen: ${steered}` }];
  };
}

/** Mock LLM for the "fast" scenario: only reads the hand-over note and reports. */
function reportingLlm() {
  return (body) => {
    const handover = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return ['done', { success: true, report: `## Done\n- ${handover.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- handover mentions fast steps: ${/executed automatically/.test(handover)}` }];
  };
}

/** Mock Jev: confident type → click, then "goal done". */
function scriptedJev() {
  let turn = 0;
  const choice = (picked) => ({ type: 'choice', choice: picked, confidence: 0.95, probabilities: { [picked]: 0.97 } });
  return (body) => {
    const els = body.state.INTERACTIVE_ELEMENTS;
    const answers = { risky: { type: 'noul', noul: 0.02 }, goal_done: { type: 'noul', noul: 0.05 } };
    if (turn === 0) {
      Object.assign(answers, { operation: choice('type'), target: choice(find(els, /^(e\d+): input[^\n]*placeholder="Search"/m)), text: choice('t0') });
    } else if (turn === 1) {
      Object.assign(answers, { operation: choice('click'), target: choice(find(els, /^(e\d+): button "Go"/m)) });
    } else {
      Object.assign(answers, { operation: choice('done'), goal_done: { type: 'noul', noul: 0.96 } });
    }
    turn += 1;
    return { model: 'jev-mock', answers, usage: { input_tokens: 1, output_tokens: 1 } };
  };
}

/** Mock chat-model fast layer: answers like scriptedJev, in the chat judge's JSON shape. */
function scriptedJudge() {
  const jev = scriptedJev();
  return (body) => {
    const { answers } = jev({ state: JSON.parse(body.messages.at(-1).content) });
    return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul' ? a.noul : { probabilities: a.probabilities }]));
  };
}

/** Mock Jev for the voice screen: it clicks or types, depending on the command. */
function scriptedVoiceJev() {
  return (body) => {
    const command = String(body.state?.spoken_command ?? '');
    const wanted = command.includes('type') ? 'type_text' : 'click';
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        const pick = keys.includes(wanted) ? wanted : (keys.find((k) => k !== 'none') ?? 'none');
        answers[name] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: { [pick]: 0.95 } };
      } else {
        answers[name] = { type: 'noul', noul: 0.05 };
      }
    }
    return { model: 'jev-mock', answers };
  };
}

/** Mock Vercel decision API: answers like scriptedJev, in the gateway's answer shape. */
function scriptedGatewayJev() {
  const jev = scriptedJev();
  return (body) => {
    const { answers } = jev({ state: body.state });
    return {
      model: 'typesafe-ai/jev',
      answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul'
        ? { type: 'boolean', probability: a.noul }
        : { type: 'choice', choice: a.choice, probabilities: a.probabilities }])),
    };
  };
}

function startServer(handlers) {
  const counts = { llm: 0, jev: 0, judge: 0, decision: 0, backup: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        if (req.url === '/widgets') {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(WIDGETS);
        } else if (req.url === '/voice') {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(VOICE_PAGE);
        } else if (req.url === '/page' || req.url.startsWith('/page?')) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
        } else if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        } else if (req.url === '/v1/chat/completions' || req.url === '/b1/chat/completions') {
          const body = JSON.parse(raw);
          const isBackup = req.url.startsWith('/b1/');
          if (body.response_format) {
            counts.judge += 1;
            if (req.headers.authorization !== 'Bearer judge-key') throw new Error('missing judge key');
            const content = JSON.stringify(handlers.judge(body));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'mock-judge', choices: [{ message: { role: 'assistant', content } }] }));
            return;
          }
          if (isBackup) counts.backup += 1;
          else counts.llm += 1;
          const scripted = await (isBackup ? handlers.backup : handlers.llm)(body); // a script may take its time
          if (scripted === 'quota') {
            // OpenAI's own body for a used-up quota: a limit that will not clear, so no retry.
            res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}');
            return;
          }
          const [name, args] = scripted;
          const id = `call_${isBackup ? 'b' : ''}${counts.llm + counts.backup}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else if (req.url === '/v4/ai/decision-model') {
          counts.decision += 1;
          if (req.headers.authorization !== 'Bearer vercel-key' || req.headers['ai-model-id'] !== 'typesafe-ai/jev') throw new Error('bad decision request headers');
          const body = JSON.parse(raw);
          if (Object.values(body.questions).some((q) => q.type === 'noul')) throw new Error('noul must be sent as boolean');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handlers.decision(body)));
        } else if (req.url === '/v1/systemone') {
          counts.jev += 1;
          if (req.headers.authorization !== 'Bearer jev-key') throw new Error('missing Jev key');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handlers.jev(JSON.parse(raw))));
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        console.error(err.message);
        res.writeHead(500).end(err.message);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` })));
}

async function runScenario(context, extensionId, { name, task, handlers, fast, expectReport, check, stopWorker = false, sendEarly = false, pagePath = '/page', during = null }) {
  const { server, counts, base } = await startServer(handlers);
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    if (name === 'llm') {
      // Settings UI: switching to the compatible provider lists the mock server's models.
      // Settings open by themselves only while no model is saved, which depends on scenario order.
      // The preset list is filled by init(), so this waits until the form is ready.
      await panel.waitForFunction(() => document.querySelectorAll('#preset option').length > 0);
      if (await panel.isHidden('#settingsView')) await panel.click('#settingsBtn');
      await panel.selectOption('#provider', 'compatible');
      await panel.selectOption('#preset', 'custom');
      await panel.fill('#baseUrl', `${base}/v1`);
      await panel.click('#refreshModelsBtn');
      await panel.waitForFunction(() => [...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'mock-model'));
    }
    await panel.evaluate(([baseUrl, fastConfig, fallback]) => chrome.storage.local.set({
      settings: {
        ...(fallback ? { fallback: { enabled: true, provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${baseUrl}/b1`, apiKey: '', model: 'mock-backup', effort: '' } } } : {}),
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: fastConfig ?? { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), [base, fast?.(base), Boolean(handlers.backup)]);
    await panel.reload();
    await panel.click('#newChatBtn');

    const target = await context.newPage();
    await target.goto(`${base}${pagePath}`);
    await target.bringToFront();
    if (stopWorker) {
      // Chrome stops an idle worker while the panel stays open; the panel's first task must still arrive.
      const cdp = await context.newCDPSession(panel);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await panel.waitForTimeout(500);
    }

    if (sendEarly) {
      // A task sent as the panel opens, before it has picked its session, must still arrive.
      await panel.addInitScript((text) => addEventListener('load', () => {
        document.getElementById('input').value = text;
        document.getElementById('composer').requestSubmit();
      }), task);
      await panel.reload();
    } else {
      await panel.fill('#input', task);
      await panel.click('#sendBtn');
    }
    const duringResult = during ? await during(panel) : null;
    const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
    const report = await final.innerText();
    if (process.env.E2E_SCREENSHOTS) {
      await panel.setViewportSize({ width: 400, height: 720 });
      await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `${name}-${process.env.E2E_COLOR_SCHEME ?? 'light'}.png`) });
    }
    // textContent: steps inside a closed thread are hidden, and innerText of hidden text is empty.
    const steps = await panel.$$eval('.step', (rows) => rows.map((r) => `${r.classList.contains('fast') ? '⚡' : ' '} ${r.textContent.replace(/\s+/g, ' ')}`));
    const threads = await panel.$$eval('.thread', (rows) => rows.map((r) => ({ open: r.open, title: r.querySelector('summary .title').textContent, meta: r.querySelector('summary .meta').textContent })));
    console.log(`\n== scenario: ${name} ==\n${steps.join('\n')}\n--- report ---\n${report}\n(LLM calls: ${counts.llm}, Jev calls: ${counts.jev}, judge calls: ${counts.judge}, decision calls: ${counts.decision})`);

    const failures = [];
    const pageResult = await target.textContent('#out');
    if (!report.includes(expectReport)) failures.push(`report missing "${expectReport}" (page shows "${pageResult}")`);
    if (steps.some((s) => s.includes('✗'))) failures.push('a tool step failed');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    const notices = await panel.$$eval('.notice.error', (rows) => rows.map((r) => r.innerText));
    if (notices.length) console.log(`notices: ${notices.join(' | ')}`);
    failures.push(...check({ counts, steps, report, notices, threads, duringResult, panel }));
    await target.close();
    return failures;
  } finally {
    await panel.close();
    server.close();
  }
}

/** Primary model that answers once, then reports its quota as exhausted. */
function quotaAfterFirstTurn() {
  let turn = 0;
  return () => (turn++ === 0 ? ['read_page', {}] : 'quota');
}

/** Shared by both fast scenarios: two fast steps, then exactly one LLM call for the report. */
function fastChecks({ counts, steps, report }) {
  return [
    ...(counts.llm === 1 ? [] : [`expected 1 LLM call, got ${counts.llm}`]),
    ...(steps.filter((s) => s.startsWith('⚡')).length === 2 ? [] : ['expected 2 fast steps']),
    ...(report.includes('handover mentions fast steps: true') ? [] : ['LLM was not told about fast steps']),
  ];
}

/** One scripted LLM per conversation, keyed by its first user message, so parallel sessions stay apart. */
function perTask(makeScript) {
  const scripts = new Map();
  return (body) => {
    const first = body.messages.find((m) => m.role === 'user');
    const key = typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
    if (!scripts.has(key)) scripts.set(key, makeScript(key));
    return scripts.get(key)(body);
  };
}

/**
 * Two sessions run tasks at the same time on two tabs. Each must finish its own
 * task, and each tab must end up in its own session's tab group.
 */
async function runParallelScenario(context, extensionId) {
  const { server, counts, base } = await startServer({ llm: perTask((task) => scriptedLlm({ askFirst: task.includes('session A') })) });
  const pages = [];
  const pageErrors = [];
  try {
    const openPanel = async () => {
      const panel = await context.newPage();
      panel.on('pageerror', (err) => pageErrors.push(err.message));
      pages.push(panel);
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
      return panel;
    };
    const panelA = await openPanel();
    await panelA.evaluate((baseUrl) => chrome.storage.local.set({
      settings: { provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' }, fast: { enabled: false }, vision: true, maxSteps: 12 },
    }), base);
    await panelA.reload();
    await panelA.click('#newChatBtn');
    const panelB = await openPanel();
    await panelB.click('#newChatBtn');

    const targetA = await context.newPage();
    await targetA.goto(`${base}/page?s=a`);
    const targetB = await context.newPage();
    await targetB.goto(`${base}/page?s=b`);
    pages.push(targetA, targetB);

    await targetA.bringToFront();
    await panelA.fill('#input', 'Fill the form and report the result (session A)');
    await panelA.click('#sendBtn');
    // A has claimed tab A and now waits on its question, so it is running for as long as the test needs.
    await panelA.waitForSelector('.msg.ask', { timeout: 30000 });
    // While A runs, the other panel must list it (with its running dot) so another tab can open it.
    await panelB.click('#sessionBtn');
    const runningListedInB = await panelB.waitForSelector('.session-item .dot.running', { timeout: 5000 }).then(() => true, () => false);
    await panelB.click('#sessionBtn');
    await targetB.bringToFront();
    await panelB.fill('#input', 'Fill the form and report the result (session B)');
    await panelB.click('#sendBtn');
    await panelB.waitForSelector('.step', { state: 'attached', timeout: 30000 }); // B has claimed tab B (its step may sit in a closed thread)
    await panelA.fill('#input', 'Yes, start');
    await panelA.click('#sendBtn');

    const [reportA, reportB] = await Promise.all([panelA, panelB].map(async (panel) => (await panel.waitForSelector('.msg.final', { timeout: 90000 })).innerText()));
    const groups = await panelA.evaluate(async () => Object.fromEntries((await chrome.tabs.query({})).filter((t) => t.url.includes('/page')).map((t) => [new URL(t.url).search, t.groupId])));
    const sessions = await panelA.evaluate(() => chrome.runtime.sendMessage({ type: 'sessions-list' }));
    console.log(`\n== scenario: parallel ==\nA: ${reportA.replace(/\s+/g, ' ')}\nB: ${reportB.replace(/\s+/g, ' ')}\ngroups ${JSON.stringify(groups)}, sessions ${sessions.result.length}, LLM calls ${counts.llm}`);

    const failures = [];
    for (const [name, report] of [['A', reportA], ['B', reportB]]) {
      if (!report.includes('Result: hello world / Blue')) failures.push(`session ${name} report is wrong: ${report}`);
    }
    if (!(groups['?s=a'] >= 0 && groups['?s=b'] >= 0 && groups['?s=a'] !== groups['?s=b'])) failures.push(`each tab should be in its own session group, got ${JSON.stringify(groups)}`);
    if (sessions.result.filter((s) => /session [AB]\)?/.test(s.title) || s.title.startsWith('Fill the form')).length < 2) failures.push('both sessions should be listed with titles from their tasks');
    if (!runningListedInB) failures.push('a running session was missing from the session list of the other panel');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    return failures;
  } finally {
    for (const page of pages) await page.close();
    server.close();
  }
}

/**
 * A ChatGPT sign-in started after the worker stopped while the panel stayed
 * open, as it does after a sign-out and a pause. OpenAI is mocked: the device
 * code is handed out, then the poll fails. The panel must say so instead of
 * showing the code forever, as it did for a ChatGPT re-sign-in reported on
 * 2026-10-24.
 */
async function runSignInAfterRestartScenario(context, extensionId) {
  let polls = 0;
  const routes = {
    'https://auth.openai.com/api/accounts/deviceauth/usercode': (route) => route.fulfill({ json: { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '1' } }),
    // Pending once, then a failure the flow cannot recover from.
    'https://auth.openai.com/api/accounts/deviceauth/token': (route) => { polls += 1; return route.fulfill(polls < 2 ? { status: 403, body: '' } : { status: 500, body: 'boom' }); },
    'https://auth.openai.com/codex/device': (route) => route.fulfill({ body: 'device page' }),
  };
  for (const [url, handler] of Object.entries(routes)) await context.route(url, handler);
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.waitForFunction(() => document.querySelectorAll('#preset option').length > 0);
    if (await panel.isHidden('#settingsView')) await panel.click('#settingsBtn');
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    // The panel learns of the closed port a moment later, as runScenario's restart does.
    await panel.waitForTimeout(500);
    await panel.selectOption('#provider', 'chatgpt');
    await panel.click('#chatgptSection [data-auth="login"]');
    const message = await panel.waitForSelector('#chatgptSection [data-auth="message"]:not([hidden])', { timeout: 15000 })
      .then((node) => node.innerText(), () => null);
    const codeStillShown = await panel.isVisible('#chatgptSection [data-auth="device"]');
    console.log(`\n== scenario: sign-in-after-restart ==\npolls ${polls}, message ${JSON.stringify(message)}, code still shown ${codeStillShown}`);
    const failures = [];
    // Two polls: the device code was handed out and polled, so the failure is the poll's, not an earlier one.
    if (polls < 2) failures.push(`expected the sign-in to poll OpenAI twice, it polled ${polls} times`);
    if (!message) failures.push('a sign-in that failed after a worker restart never told the panel');
    if (codeStillShown) failures.push('the device code stayed on screen after the sign-in failed');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    return failures;
  } finally {
    for (const url of Object.keys(routes)) await context.unroute(url);
    await panel.close();
  }
}

/** Waits for the approval the fast layer asks for, and says what happened when it does not come. */
async function waitForApproval(panel, pageErrors) {
  try {
    await panel.waitForSelector('#voiceApproval:not([hidden])', { timeout: 20000 });
  } catch (err) {
    console.log('DIAG', await panel.evaluate(async () => ({
      entries: [...document.querySelectorAll('#voiceLog .voice-entry')].map((n) => n.textContent),
      state: document.getElementById('voiceState').textContent,
      active: (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((t) => t.url),
    })));
    console.log('PAGE ERRORS', pageErrors);
    throw err;
  }
}

/**
 * The voice screen: the composer microphone opens it, the words it hears reach
 * the transcript that is on screen, the fast layer asks before it acts, and a
 * field that holds a secret is left alone.
 */
async function runVoiceScenario(context, extensionId) {
  const { server, counts, base } = await startServer({ jev: scriptedVoiceJev() });
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  let target = null;
  // Chrome has no recognizer in a test: the panel gets one that says what the
  // test tells it to, and the microphone permission is granted.
  await panel.addInitScript(() => {
    class MockRecognition {
      constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.started = false; }
      start() { this.started = true; window.__recognition = this; }
      stop() { this.started = false; this.onend?.(); }
      abort() { this.started = false; this.onend?.(); }
    }
    window.SpeechRecognition = MockRecognition;
    window.webkitSpeechRecognition = MockRecognition;
    window.__say = (text) => window.__recognition?.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async (descriptor) => ({ state: descriptor?.name === 'microphone' ? 'granted' : 'prompt', onchange: null }) },
    });
  });
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: baseUrl },
        voiceEngine: 'fast_only',
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();

    target = await context.newPage();
    await target.goto(`${base}/voice`);
    await target.bringToFront();

    const failures = [];

    // The composer microphone opens the voice screen.
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    const screen = await panel.evaluate(() => ({
      count: document.querySelectorAll('#voiceLive').length,
      inView: Boolean(document.getElementById('voiceLive').closest('#voiceView')),
      chatHidden: document.getElementById('chatView').hidden,
    }));
    if (screen.count !== 1) failures.push(`the panel has ${screen.count} transcripts`);
    if (!screen.inView) failures.push('the transcript is not the one in the voice screen');
    if (!screen.chatHidden) failures.push('the chat is still shown behind the voice screen');

    // The microphone icon fills the button, and the empty log says so in the
    // panel's language.
    const drawn = await panel.evaluate(() => {
      const svg = document.querySelector('#voiceMicBtn svg');
      const box = svg.getBoundingClientRect();
      const empty = getComputedStyle(document.getElementById('voiceLog'), '::before').content;
      return { w: Math.round(box.width), h: Math.round(box.height), empty };
    });
    if (drawn.w < 30 || drawn.h < 30) failures.push(`the microphone icon is ${drawn.w}x${drawn.h}`);
    if (!drawn.empty || drawn.empty === 'none' || !drawn.empty.includes('No activity')) failures.push(`the empty log says nothing: ${drawn.empty}`);

    // A narrow panel and reduced motion are both allowed.
    await panel.setViewportSize({ width: 320, height: 640 });
    const narrow = await panel.evaluate(() => {
      const view = document.getElementById('voiceView');
      return view.scrollWidth > view.clientWidth + 1;
    });
    if (narrow) failures.push('the voice screen overflows a narrow panel');
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    const motion = await panel.evaluate(() => getComputedStyle(document.getElementById('voiceMicBtn')).animationName);
    if (motion !== 'none') failures.push(`the microphone still animates with reduced motion (${motion})`);
    await panel.emulateMedia({ reducedMotion: 'no-preference' });
    await panel.setViewportSize({ width: 400, height: 720 });

    // The words reach the transcript that is on screen.
    await panel.evaluate(() => window.__say('click go'));
    await panel.waitForFunction(() => document.getElementById('voiceLive').textContent.includes('click go'), { timeout: 10000 });

    // The fast layer asks before it clicks, and the question can be refused.
    await waitForApproval(panel, pageErrors);
    const asked = await panel.textContent('#voiceApproval');
    if (!/Go/.test(asked)) failures.push(`the approval does not name the element: ${asked}`);
    const focused = await panel.evaluate(() => document.activeElement?.textContent);
    if (!focused || !/Approve|موافقة/.test(focused)) failures.push(`the approval does not take the keyboard (${focused})`);
    await panel.click('#voiceApproval button.ghost');
    await panel.waitForFunction(() => document.getElementById('voiceApproval').hidden, { timeout: 10000 });
    if ((await target.textContent('#out')) !== '') failures.push('the page was clicked although the answer was no');

    // The same command, approved this time.
    await panel.evaluate(() => window.__say('click go'));
    await waitForApproval(panel, pageErrors);
    await panel.click('#voiceApproval button.primary');
    await target.waitForFunction(() => document.getElementById('out')?.textContent === 'clicked 1', { timeout: 10000 }).catch(() => {});
    if ((await target.textContent('#out')) !== 'clicked 1') failures.push('the approved click did not happen');

    // The activity log holds the command and how it ended.
    await panel.waitForFunction(() => document.querySelector('#voiceLog .voice-entry.ok'), { timeout: 20000 }).catch(() => {});
    const entries = await panel.$$eval('#voiceLog .voice-entry', (rows) => rows.map((row) => row.className));
    if (entries.length !== 2) failures.push(`expected two commands in the log, got ${entries.length}`);
    if (!entries.some((name) => name.includes('err'))) failures.push('the refused command is not marked as failed');
    if (!entries.some((name) => name.includes('ok'))) failures.push('the approved command is not marked as done');

    // A field that holds a secret is left alone.
    await panel.evaluate(() => window.__say('type secret'));
    await waitForApproval(panel, pageErrors);
    await panel.click('#voiceApproval button.primary');
    await target.waitForFunction(() => document.getElementById('search')?.value !== '', { timeout: 10000 }).catch(() => {});
    const fields = await target.evaluate(() => ({
      search: document.getElementById('search').value,
      password: document.getElementById('pw').value,
      code: document.getElementById('code').value,
    }));
    if (!fields.search) failures.push('the text was not typed into the field');
    if (fields.password) failures.push('a password field was written into');
    if (fields.code) failures.push('a one-time code field was written into');

    // The fast layer ran the command: the main model was never asked.
    if (counts.llm !== 0) failures.push(`the main model was asked ${counts.llm} times`);
    if (counts.jev < 3) failures.push(`the fast layer was asked ${counts.jev} times`);

    // The switch is remembered.
    await panel.check('#voiceSpeak');
    await panel.bringToFront(); // a background tab is not reloaded in time
    await panel.reload();
    await target.bringToFront(); // the panel is a page in a tab here; the user's tab leads
    await panel.click('#voiceToggle');
    await panel.waitForFunction(() => document.getElementById('voiceSpeak')?.checked === true, { timeout: 10000 });
    const remembered = await panel.evaluate(() => chrome.storage.local.get('voiceSpeak'));
    if (remembered.voiceSpeak !== true) failures.push('the spoken replies switch was not remembered');

    // Back to the chat: the microphone stops.
    await panel.click('#voiceBackBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    const stopped = await panel.evaluate(() => window.__recognition?.started === false);
    if (!stopped) failures.push('the microphone is still running after Back');

    // A session change stops the command that was running: the approval is
    // withdrawn and the page of the old session is left alone.
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    await panel.evaluate(() => window.__say('click go'));
    await waitForApproval(panel, pageErrors);
    await panel.click('#newChatBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    const withdrawn = await panel.evaluate(() => document.getElementById('voiceApproval').hidden);
    if (!withdrawn) failures.push('the approval was not withdrawn when the session changed');
    await panel.waitForTimeout(1000);
    if ((await target.textContent('#out')) !== 'clicked 1') failures.push('the page was clicked after the session changed');

    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    console.log(`\n== scenario: voice ==\nfast calls: ${counts.jev}, main model calls: ${counts.llm}`);
    return failures;
  } finally {
    await target.close();
    await panel.close();
    server.close();
  }
}

/**
 * The side panel may not ask Chrome for the microphone, so the voice screen
 * opens a real window for it. That window takes the focus: it must not become
 * the tab the command acts on.
 */
async function runVoiceWindowScenario(context, extensionId) {
  const { server, counts, base } = await startServer({ jev: scriptedVoiceJev() });
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  await panel.addInitScript(() => {
    class MockRecognition {
      constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.started = false; }
      start() { this.started = true; window.__recognition = this; }
      stop() { this.started = false; this.onend?.(); }
      abort() { this.started = false; this.onend?.(); }
    }
    window.SpeechRecognition = MockRecognition;
    window.webkitSpeechRecognition = MockRecognition;
    // The panel cannot ask for the microphone: the real window does.
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => ({ state: 'prompt', onchange: null }) },
    });
  });
  const failures = [];
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: baseUrl },
        voiceEngine: 'fast_only',
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();

    const target = await context.newPage();
    await target.goto(`${base}/voice`);
    await target.bringToFront();

    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    // The microphone window opened, with the epoch that makes it this panel's.
    await panel.waitForFunction(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.some((t) => (t.url ?? '').includes('mic.html'));
    }, { timeout: 15000 }).catch(() => {});
    const micUrls = await panel.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url ?? '').filter((url) => url.includes('mic.html')));
    if (!micUrls.length) failures.push('the microphone window did not open');
    else if (!/epoch=\d+/.test(micUrls[0])) failures.push(`the microphone window has no epoch: ${micUrls[0]}`);

    // The command acts on the page the user was on, not on the window.
    await panel.fill('#voiceTypedInput', 'click go');
    await panel.press('#voiceTypedInput', 'Enter');
    await waitForApproval(panel, pageErrors);
    await panel.click('#voiceApproval button.primary');
    await target.waitForFunction(() => document.getElementById('out')?.textContent === 'clicked 1', { timeout: 10000 }).catch(() => {});
    if ((await target.textContent('#out')) !== 'clicked 1') failures.push('the command did not act on the page the user was on');
    if (counts.llm !== 0) failures.push(`the main model was asked ${counts.llm} times`);

    // Back closes the microphone window.
    await panel.click('#voiceBackBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    await panel.waitForTimeout(500);
    const left = await panel.evaluate(async () => (await chrome.tabs.query({})).some((t) => (t.url ?? '').includes('mic.html')));
    if (left) failures.push('the microphone window stayed open after Back');

    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    console.log(`\n== scenario: voice-window ==\nfast calls: ${counts.jev}`);
    return failures;
  } finally {
    await panel.close();
    server.close();
  }
}

/**
 * The history the worker replays is not a live event: a question from it does
 * not close the voice screen, and it starts no task.
 */
async function runVoiceReplayScenario(context, extensionId) {
  let asked = false;
  const first = scriptedLlm({ askFirst: true });
  const rest = scriptedLlm();
  const llm = (body) => {
    if (!asked) {
      asked = true;
      return first(body);
    }
    return rest(body);
  };
  const { server, counts, base } = await startServer({ llm });
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  let target = null;
  const failures = [];
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), base);
    await panel.reload();

    target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();

    // A task that asks a question: the transcript keeps the question.
    await panel.fill('#input', 'Fill the form and report the result');
    await panel.click('#sendBtn');
    await panel.waitForSelector('.msg.ask', { timeout: 30000 });
    await panel.fill('#input', 'Yes, start');
    await panel.click('#sendBtn');
    await panel.waitForSelector('.msg.final', { timeout: 60000 });
    const before = counts.llm;

    // The voice screen is open when the worker is restarted: the history that
    // comes back must not close it.
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.waitForTimeout(800);
    await panel.fill('#voiceTypedInput', 'hello');
    await panel.press('#voiceTypedInput', 'Enter');
    await panel.waitForTimeout(5000);
    const stillOpen = await panel.evaluate(() => !document.getElementById('voiceView').hidden);
    if (!stillOpen) failures.push('the replayed question closed the voice screen');
    const questions = await panel.evaluate(() => document.querySelectorAll('.msg.ask').length);
    if (questions !== 1) failures.push(`the replayed question was shown again (${questions} questions)`);
    const waiting = await panel.evaluate(() => document.getElementById('hint').textContent);
    if (/wait/i.test(waiting)) failures.push('the replayed question is waiting for an answer');

    // The task the voice command started is stopped, so it does not work on
    // the page of the next scenario.
    await panel.click('#voiceBackBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    await panel.click('#stopBtn').catch(() => {});
    await panel.waitForTimeout(500);

    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    console.log(`\n== scenario: voice-replay ==\nmodel calls before ${before}, after ${counts.llm}`);
    return failures;
  } finally {
    await target?.close();
    await panel.close();
    server.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    colorScheme: process.env.E2E_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // The default headless shell cannot load extensions; full Chromium in new headless mode can.
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const failures = [
      ...(await runSignInAfterRestartScenario(context, extensionId)),
      ...(await runParallelScenario(context, extensionId)),
      ...(await runVoiceScenario(context, extensionId)),
      ...(await runVoiceWindowScenario(context, extensionId)),
      ...(await runVoiceReplayScenario(context, extensionId)),
      ...(await runScenario(context, extensionId, {
        name: 'llm',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        expectReport: 'Result: hello world / Blue',
        check: ({ report, threads }) => [
          ...(report.includes('screenshot seen: true') ? [] : ['screenshot never reached the model']),
          ...(report.includes('dates seen: true') ? [] : ['shadow-DOM release dates never reached the model']),
          // One closed thread per model turn, named by its tools, with its time and tokens on the line.
          ...(threads.length === 7 && threads.every((th) => !th.open && /100 in · 10 out/.test(th.meta)) && threads[1].title === 'type_text' ? [] : [`expected 7 closed threads with time and tokens, got ${JSON.stringify(threads.slice(0, 2))}`]),
          // Seven model turns of 100 + 10 tokens, and a time for the whole task.
          ...(/Took \d+\.\ds · 700 tokens in · 70 out/.test(report) ? [] : [`expected task totals under the report, got: ${report.split('\n').at(-1)}`]),
        ],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'suggestions',
        task: 'Pick Maths and Delhi and press Go',
        handlers: { llm: suggestionLlm() },
        pagePath: '/widgets',
        expectReport: 'Result: Maths / Delhi',
        check: ({ report }) => (/checks: subject ok, refusal ok, city ok/.test(report) ? [] : [`choose_suggestion checks failed: ${report.match(/checks: .*/)?.[0]}`]),
      })),
      ...(await runScenario(context, extensionId, {
        name: 'steer',
        task: 'Fill the form and report the result',
        handlers: { llm: slowThinkerLlm() },
        // While the model thinks, send a message: it waits as pending, then is read.
        during: async (panel) => {
          await panel.waitForSelector('#stopBtn:not([hidden])');
          await panel.fill('#input', 'use blue');
          await panel.click('#sendBtn');
          await panel.waitForSelector('#pending li', { timeout: 5000 });
          return panel.$eval('#pending li .chip', (n) => n.textContent);
        },
        expectReport: 'steer seen: true',
        check: ({ duringResult }) => (duringResult === 'after this step' ? [] : [`expected a pending "after this step" message, got ${duringResult}`]),
      })),
      ...(await runScenario(context, extensionId, {
        name: 'worker-restart',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        stopWorker: true,
        expectReport: 'Result: hello world / Blue',
        check: () => [],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'early-send',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        sendEarly: true,
        expectReport: 'Result: hello world / Blue',
        check: () => [],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'fallback',
        task: 'Fill the form and report the result',
        handlers: { llm: quotaAfterFirstTurn(), backup: scriptedLlm() },
        expectReport: 'Result: hello world / Blue',
        check: ({ counts, notices }) => [
          ...(counts.llm === 2 && counts.backup >= 6 ? [] : [`expected 2 primary calls then the backup (primary ${counts.llm}, backup ${counts.backup})`]),
          ...(notices.length === 1 && /mock-backup/.test(notices[0]) ? [] : [`expected one red notice naming the backup, got ${JSON.stringify(notices)}`]),
        ],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'fast',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), jev: scriptedJev() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: base }),
        expectReport: 'Result: hello world / Red',
        check: fastChecks,
      })),
      ...(await runScenario(context, extensionId, {
        name: 'vercel-jev',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), decision: scriptedGatewayJev() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'vercel', decision: true, apiKey: 'vercel-key', model: 'typesafe-ai/jev', baseUrl: `${base}/v1`, minProb: 0.6 }),
        expectReport: 'Result: hello world / Red',
        check: (run) => [
          ...fastChecks(run),
          ...(run.counts.decision >= 2 && run.counts.judge === 0 ? [] : [`expected the decision API (decision ${run.counts.decision}, judge ${run.counts.judge})`]),
        ],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'chat-fast',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), judge: scriptedJudge() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'custom', apiKey: 'judge-key', model: 'mock-judge', baseUrl: `${base}/v1`, minProb: 0.75 }),
        expectReport: 'Result: hello world / Red',
        check: (run) => [
          ...fastChecks(run),
          ...(run.counts.judge >= 2 && run.counts.jev === 0 ? [] : [`expected the chat judge, not Jev (judge ${run.counts.judge}, jev ${run.counts.jev})`]),
        ],
      })),
    ];
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nE2E PASSED');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});
