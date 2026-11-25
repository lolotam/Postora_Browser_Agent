import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AgentOverlay } from '../src/browser/overlay.js';

const panelSource = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');

test('requestStopTask disables Stop, shows Stopping…, and resets when setRunning(false) arrives', async () => {
  const start = panelSource.indexOf('function setRunning(');
  const end = panelSource.indexOf('const STICK_THRESHOLD_PX');
  const snippet = panelSource.slice(start, end);

  const sent = [];
  const els = {
    statusDot: { classList: { toggle() {} } },
    stopBtn: { hidden: false, disabled: false },
    voiceToggle: { hidden: true },
    workspaceStopBtn: { hidden: false, disabled: false },
    settingsView: { hidden: true },
    voiceView: { hidden: true },
    sendBtn: { hidden: false },
    hint: { textContent: '' },
    chatLog: { classList: { remove() {} } },
  };
  const ctx = vm.createContext({
    ui: { running: true, stopping: false, question: null },
    closeThread() {},
    updateChatLogStatus() {},
    showPendingQuestion() {},
    t: (k) => k,
    send: async (msg) => { sent.push(msg); },
    $: (id) => els[id],
  });
  vm.runInContext(snippet, ctx);

  ctx.requestStopTask();
  assert.equal(ctx.ui.stopping, true);
  assert.equal(els.stopBtn.disabled, true);
  assert.equal(els.workspaceStopBtn.disabled, true);
  assert.equal(els.hint.textContent, 'status.stopping');
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'stop' }]);

  // A second request while already stopping is ignored
  ctx.requestStopTask();
  assert.equal(sent.length, 1);

  // When status: { running: false } arrives, stopping state and buttons reset
  ctx.setRunning(false);
  assert.equal(ctx.ui.running, false);
  assert.equal(ctx.ui.stopping, false);
  assert.equal(els.stopBtn.hidden, true);
  assert.equal(els.stopBtn.disabled, false);
  assert.equal(els.hint.textContent, '');
});

test('AgentOverlay renders the on-page Stop bar even when showCursor (enabled) is false', async () => {
  const calls = [];
  const overlay = new AgentOverlay({ tabId: 42 });
  overlay.send = async (cmd, tabId) => { calls.push({ cmd, tabId }); };

  overlay.begin({ enabled: false, uiLanguage: 'en' });
  await overlay.frame();
  await overlay.pointTo({ x: 100, y: 200 }, ['click', { label: 'Go' }]);

  assert.equal(calls.length, 1, 'frame() sends the Stop bar while pointTo() is skipped when cursor is off');
  assert.equal(calls[0].tabId, 42);
  assert.equal(calls[0].cmd.op, 'frame');
  assert.equal(calls[0].cmd.showFrame, false);

  await overlay.end();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cmd.op, 'remove');
});
