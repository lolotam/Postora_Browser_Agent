import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { translateFor } from '../src/sidepanel/i18n.js';

const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');

test('folded chat log summary has a live status span', () => {
  assert.match(html, /<summary id="chatLogSummary">[\s\S]*?<span id="chatLogStatus" class="chat-log-status" dir="auto"><\/span><\/summary>/);
});

test('updateChatLogStatus renders step n of max, active tool, short model name, and tokens while running, and clears when stopped', () => {
  const fnSource = source.slice(
    source.indexOf('function updateChatLogStatus('),
    source.indexOf('\n/** Under the final report: the whole task\'s time and tokens. */\nfunction updateContextBar('),
  );
  const statusNode = { textContent: '' };
  const logClasses = new Set(['live']);
  const t = (key, vars) => translateFor('en', key, vars);
  const context = vm.createContext({
    ui: {
      running: true,
      liveStatus: { step: 3, tool: 'click', model: 'OpenRouter · nvidia/nemotron-3-super' },
      context: { input: 1200, model: 'nvidia/nemotron-3-super' },
      stats: { input: 1200, output: 350 },
    },
    settings: { maxSteps: 25 },
    t,
    number: (n) => n.toLocaleString('en-US'),
    $: (id) => {
      if (id === 'chatLogStatus') return statusNode;
      if (id === 'chatLog') return { classList: { contains: (c) => logClasses.has(c) } };
      return null;
    },
  });
  vm.runInContext(fnSource, context);
  context.updateChatLogStatus();
  assert.equal(statusNode.textContent, 'Step 3 of 25 · click · nemotron-3-super · 1,200 in · 350 out');

  context.ui.running = false;
  logClasses.delete('live');
  context.updateChatLogStatus();
  assert.equal(statusNode.textContent, '');
});
