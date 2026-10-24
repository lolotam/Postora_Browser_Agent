import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareKeys } from '../src/lib/keys.js';
import { mergeSettings } from '../src/lib/settings.js';
import { createKeyStore, keyFieldState, maskKey } from '../src/sidepanel/key-store.js';

test('settings saved before keys were shared give their keys to every slot of the same provider', () => {
  const settings = mergeSettings({
    compatible: { preset: 'openrouter', apiKey: 'or-key', model: 'm' },
    fallback: { enabled: true, provider: 'compatible', compatible: { preset: 'opencode-go', apiKey: '', model: 'm' } },
    fast: { enabled: true, provider: 'opencode-zen', apiKey: 'oc-key', fallback: { enabled: true, provider: 'openrouter', apiKey: '' } },
  });
  assert.deepEqual(settings.keys, { openrouter: 'or-key', opencode: 'oc-key' });
  assert.equal(settings.fast.fallback.apiKey, 'or-key');
  assert.equal(settings.fallback.compatible.apiKey, 'oc-key');
});

test('a slot keeps its own key and a custom endpoint key stays in its slot', () => {
  const settings = shareKeys({
    keys: { openrouter: 'shared' },
    compatible: { preset: 'openrouter', apiKey: 'typed-here' },
    fallback: { compatible: { preset: 'custom', apiKey: 'local' } },
    fast: { provider: 'typesafe', apiKey: '', fallback: { provider: 'openrouter', apiKey: '' } },
  });
  assert.equal(settings.compatible.apiKey, 'typed-here');
  assert.equal(settings.fast.fallback.apiKey, 'shared');
  assert.equal(settings.fast.apiKey, '');
  assert.equal(settings.keys.custom, undefined);
});

function fakeInput() {
  const listeners = [];
  return {
    value: '',
    addEventListener: (type, fn) => listeners.push(fn),
    type(text) {
      this.value = text;
      listeners.forEach((fn) => fn());
    },
  };
}

test('typing a key in one field fills every field showing the same provider', () => {
  const store = createKeyStore();
  const main = fakeInput();
  const fastBackup = fakeInput();
  const fast = fakeInput();
  const provider = { main: 'openrouter', fastBackup: 'openrouter', fast: 'typesafe' };
  store.register(main, () => provider.main);
  store.register(fastBackup, () => provider.fastBackup);
  store.register(fast, () => provider.fast);

  main.type('or-key ');
  assert.equal(fastBackup.value, 'or-key');
  assert.equal(fast.value, '', 'another provider keeps its own key');

  provider.fast = 'openrouter';
  store.show(fast, provider.fast);
  assert.equal(fast.value, 'or-key', 'switching a field to the provider shows its key');
  assert.deepEqual(store.snapshot(), { openrouter: 'or-key' });

  fastBackup.type('');
  assert.equal(main.value, '');
  assert.deepEqual(store.snapshot(), {});
});

test('a saved key is shown hidden with its last characters, and stays editable while it is being typed', () => {
  assert.equal(maskKey('sk-ant-api03-wxyz'), '••••••••wxyz');
  assert.equal(maskKey('abcd'), '••••••••', 'a key of four characters or fewer stays fully hidden');
  assert.deepEqual(keyFieldState('sk-live-1234', false), { locked: true, mask: '••••••••1234' });
  assert.deepEqual(keyFieldState('sk-live-1234', true), { locked: false, mask: '' }, 'typing keeps the field open');
  assert.deepEqual(keyFieldState('  ', false), { locked: false, mask: '' });
});

test('switching to a custom endpoint shows that slot\'s own key, not a shared one', () => {
  const store = createKeyStore();
  store.load({ openrouter: 'or-key' });
  const input = fakeInput();
  store.show(input, 'custom', 'local-key');
  assert.equal(input.value, 'local-key');
});

test('the recommended setup fills main and backup, keeps stored keys, and changes nothing else', async () => {
  const { DEFAULT_SETTINGS, recommendedSlots, RECOMMENDED_SETUP } = await import('../src/lib/settings.js');
  const draft = { ...structuredClone(DEFAULT_SETTINGS), keys: { openrouter: 'or-key' }, maxSteps: 77 };
  const { main, fallback } = recommendedSlots(draft);
  assert.equal(main.provider, 'compatible');
  assert.equal(main.compatible.preset, 'nvidia');
  assert.equal(main.compatible.model, RECOMMENDED_SETUP.main.model);
  assert.equal(main.compatible.apiKey, ''); // still to be pasted
  assert.equal(main.maxSteps, 77);
  assert.equal(fallback.enabled, true);
  assert.equal(fallback.compatible.preset, 'openrouter');
  assert.equal(fallback.compatible.model, 'apodex/apodex-1.1-mini:free');
  assert.equal(fallback.compatible.apiKey, 'or-key');
  assert.equal(draft.compatible.preset, DEFAULT_SETTINGS.compatible.preset); // the draft itself is untouched
});
