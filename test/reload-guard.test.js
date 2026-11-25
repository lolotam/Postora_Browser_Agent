import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MESSAGES } from '../src/sidepanel/messages.js';

const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');

/** The reload guard, with the worker and the panel around it under our control. */
function fixture({ running = false, sessions = [], fail = null } = {}) {
  const errors = [];
  let reloaded = false;
  const context = vm.createContext({
    ui: { running },
    t: (key) => MESSAGES.en[key],
    showSettingsError: (message) => errors.push(message),
    request: async (type) => {
      if (type !== 'sessions-list') throw new Error(`unexpected request ${type}`);
      if (fail) throw fail;
      return sessions;
    },
    chrome: { runtime: { reload: () => { reloaded = true; } } },
  });
  vm.runInContext(source.slice(source.indexOf('async function reloadExtension('), source.indexOf("$('reloadExtension').addEventListener")), context);
  return { context, errors, reloaded: () => reloaded };
}

test('the reload waits while another session is running a task', async () => {
  const { context, errors, reloaded } = fixture({ sessions: [{ id: 'a', running: false }, { id: 'b', running: true }] });
  await context.reloadExtension();
  assert.equal(reloaded(), false, 'the extension was not reloaded');
  assert.deepEqual(errors, [MESSAGES.en['connection.stopBeforeReload']]);
});

test('the reload goes ahead when no session is running a task', async () => {
  const { context, errors, reloaded } = fixture({ sessions: [{ id: 'a', running: false }, { id: 'b', running: false }] });
  await context.reloadExtension();
  assert.equal(reloaded(), true);
  assert.deepEqual(errors, []);
});

test('this session running is enough to refuse the reload', async () => {
  const { context, errors, reloaded } = fixture({ running: true, sessions: [] });
  await context.reloadExtension();
  assert.equal(reloaded(), false);
  assert.deepEqual(errors, [MESSAGES.en['connection.stopBeforeReload']]);
});

test('a worker that cannot answer does not end a task that may be running', async () => {
  const { context, errors, reloaded } = fixture({ fail: new Error('the worker did not answer') });
  await context.reloadExtension();
  assert.equal(reloaded(), false, 'the extension was not reloaded');
  assert.deepEqual(errors, ['the worker did not answer']);
});
