import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MESSAGES } from '../src/sidepanel/messages.js';

const source = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
function fixture(language = 'en') {
  const status = { textContent: '', dataset: {} };
  const context = vm.createContext({ $: () => status, currentLanguage: () => language,
    t: (key, values = {}) => MESSAGES[language][key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? ''),
  });
  vm.runInContext(source.slice(source.indexOf('function setAccountStatus('), source.indexOf('\nfunction toggleAccountMenu(')), context);
  vm.runInContext(source.slice(source.indexOf('async function driveAction('), source.indexOf('\nlet driveState =')), context);
  return { context, status };
}

test('manual Drive success stays visible with a timestamp in both languages', async () => {
  for (const language of ['en', 'ar']) {
    const { context, status } = fixture(language);
    await context.driveAction(async () => ({ at: Date.UTC(2026, 9, 28), error: null }));
    assert.equal(status.dataset.tone, 'success');
    assert.ok(status.textContent.startsWith('✓ '));
    assert.ok(status.textContent.includes(MESSAGES[language]['drive.saved'].split('{time}')[0]));
  }
});

test('returned Drive failures and thrown session errors show the real error, not old success', async () => {
  const { context, status } = fixture();
  for (const fail of [async () => ({ at: 1, error: 'Google Drive: Permission denied' }),
    async () => { throw new Error('Google needs you to sign in again (session expired).'); }]) {
    await context.driveAction(async () => ({ at: 1 }));
    await context.driveAction(fail);
    assert.equal(status.dataset.tone, 'error');
    assert.match(status.textContent, /^✗ (Google Drive: Permission denied|Google needs you to sign in again)/);
  }
});

test('a retry clears error styling while working and shows success only after completion', async () => {
  const { context, status } = fixture();
  await context.driveAction(async () => ({ error: 'failed' }));
  let finish;
  const pending = context.driveAction(() => new Promise((resolve) => { finish = resolve; }));
  assert.equal(status.dataset.tone, '');
  assert.equal(status.textContent, MESSAGES.en['drive.working']);
  finish({ at: 1234 });
  await pending;
  assert.equal(status.dataset.tone, 'success');
});

test('the shared action does not erase restore success feedback', async () => {
  const { context, status } = fixture();
  await context.driveAction(async () => context.setAccountStatus(MESSAGES.en['drive.restored'], 'success'));
  assert.equal(status.textContent, MESSAGES.en['drive.restored']);
  assert.equal(status.dataset.tone, 'success');
});
