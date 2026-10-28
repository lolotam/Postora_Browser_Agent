import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPATIBLE_PRESETS, mergeSettings, modelListRoute, settingsProblem, slotSettings } from '../src/lib/settings.js';
import { createKeyStore } from '../src/sidepanel/key-store.js';
import { createProviderForm } from '../src/sidepanel/provider-form.js';
import { AnthropicSession } from '../src/providers/anthropic.js';
import { GrokAccountSession } from '../src/providers/responses.js';
import { createModelSession } from '../src/agent/model-session.js';

// The little DOM the provider form needs: a value, a hidden flag and listeners.
function fakeElement() {
  const listeners = new Map();
  return {
    value: '',
    hidden: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type) {
      (listeners.get(type) ?? []).forEach((fn) => fn({ type, target: this }));
    },
    focus() {},
  };
}

// The fields each frame really has. A query for a field the frame does not
// have finds nothing, so the form cannot lean on one that is not there.
const MODEL_FIELDS = ['modelSearch', 'modelSelect', 'modelInput', 'modelInfo', 'refresh', 'effort', 'test', 'testResult'];
const NAMED_FIELDS = ['geminiSection', 'geminiApiKey', 'kimiSection', 'kimiAuth', 'kimiApiKey', 'kimiKeyField', 'kimiAccount'];
const MAIN_FIELDS = ['provider', 'preset', 'baseUrl', 'apiKey', 'chatgptSection', 'claudeSection', 'grokSection', 'compatibleSection', 'claudeAuth', 'claudeApiKey', ...MODEL_FIELDS, ...NAMED_FIELDS];
const BACKUP_FIELDS = ['provider', 'preset', 'baseUrl', 'apiKey', 'accountNote', 'fallbackAuth', 'claudeSection', 'compatibleSection', 'claudeAuth', 'claudeApiKey', ...MODEL_FIELDS, ...NAMED_FIELDS];

/** A form root: its fields are found by data-field, and only the ones it has. */
function fakeRoot(fields) {
  const elements = new Map();
  const root = {
    querySelector(selector) {
      const name = selector.match(/\[data-field="([^"]+)"\]/)?.[1];
      if (!name || !fields.includes(name)) return null;
      if (!elements.has(name)) elements.set(name, fakeElement());
      return elements.get(name);
    },
    addEventListener() {},
  };
  return { root, el: (name) => root.querySelector(`[data-field="${name}"]`) };
}

const formFor = (root) => createProviderForm(root, {
  request: async (type) => type === 'list-models' ? [] : ({}),
  getPresets: () => COMPATIBLE_PRESETS,
  keyStore: createKeyStore(),
});

test('a new install has a Claude and a Grok slot, in the main settings and in the backup', () => {
  const settings = mergeSettings({});
  assert.deepEqual(settings.claude, { auth: 'account', apiKey: '', model: '', effort: '' });
  assert.deepEqual(settings.grok, { model: '', effort: '' });
  assert.deepEqual(settings.fallback.claude, { auth: 'account', apiKey: '', model: '', effort: '' });
  assert.deepEqual(settings.fallback.grok, { model: '', effort: '' });
});

test('the factory builds the session of the provider the slot names', () => {
  const claude = createModelSession(mergeSettings({ provider: 'claude', claude: { model: 'claude-sonnet-4-6' } }), {});
  assert.ok(claude.active instanceof AnthropicSession, 'a Claude slot speaks the Anthropic Messages API');
  const grok = createModelSession(mergeSettings({ provider: 'grok', grok: { model: 'grok-4' } }), {});
  assert.ok(grok.active instanceof GrokAccountSession, 'a Grok slot speaks the Responses API');
});

test('a Claude or Grok slot is saved with its own model, not the compatible one', () => {
  const claude = mergeSettings({ provider: 'claude', claude: { model: 'claude-sonnet-4-6' }, compatible: { model: '' } });
  assert.equal(slotSettings(claude).model, 'claude-sonnet-4-6', 'the save check finds the model of the Claude slot');
  assert.equal(settingsProblem(claude), null, 'a Claude slot is saved while the compatible one has no model');
  const grok = mergeSettings({ provider: 'grok', grok: { model: 'grok-4' }, compatible: { model: '' } });
  assert.equal(slotSettings(grok).model, 'grok-4', 'the save check finds the model of the Grok slot');
  assert.equal(settingsProblem(grok), null, 'a Grok slot is saved while the compatible one has no model');
  const withoutModel = mergeSettings({ provider: 'claude', claude: { model: '' }, compatible: { model: '' } });
  assert.equal(settingsProblem(withoutModel), 'err.pickModel', 'a slot without a model of its own is still refused');
});

test('the model list of a slot follows the provider it names', () => {
  assert.equal(modelListRoute({ provider: 'chatgpt' }), 'chatgpt');
  assert.equal(modelListRoute({ provider: 'claude' }), 'claude');
  assert.equal(modelListRoute({ provider: 'grok' }), 'grok');
  assert.equal(modelListRoute({ provider: 'compatible' }), 'compatible');
});

test('the Anthropic key is one key for the main slot and its backup', () => {
  const settings = mergeSettings({ claude: { apiKey: 'sk-ant-key' } });
  assert.equal(settings.keys.anthropic, 'sk-ant-key');
  assert.equal(settings.fallback.claude.apiKey, 'sk-ant-key', 'the backup of the Claude slot uses the same key');
  assert.equal(mergeSettings(settings).fallback.claude.apiKey, 'sk-ant-key', 'and it survives a save');
});

test('typing an Anthropic key in one slot fills the other', () => {
  const keyStore = createKeyStore();
  const main = fakeRoot(MAIN_FIELDS);
  const backup = fakeRoot(BACKUP_FIELDS);
  const options = { request: async () => ({}), getPresets: () => COMPATIBLE_PRESETS, keyStore };
  createProviderForm(main.root, options).fill(mergeSettings({ provider: 'claude' }));
  createProviderForm(backup.root, options).fill(mergeSettings({}).fallback);

  main.el('claudeApiKey').value = 'sk-ant-key';
  main.el('claudeApiKey').dispatch('input');

  assert.equal(backup.el('claudeApiKey').value, 'sk-ant-key');
  assert.deepEqual(keyStore.snapshot(), { anthropic: 'sk-ant-key' });
});

test('the form shows the section of the provider it is set to', () => {
  const { root, el } = fakeRoot(MAIN_FIELDS);
  const form = formFor(root);

  form.fill(mergeSettings({ provider: 'claude', claude: { model: 'claude-sonnet-4-6', effort: 'high' }, compatible: { model: '' } }));
  assert.equal(el('claudeSection').hidden, false);
  assert.equal(el('chatgptSection').hidden, true);
  assert.equal(el('grokSection').hidden, true);
  assert.equal(el('compatibleSection').hidden, true);

  // The model of the slot is the one its provider uses, not the compatible one.
  const draft = form.read();
  assert.equal(draft.provider, 'claude');
  assert.equal(draft.claude.model, 'claude-sonnet-4-6');
  assert.equal(draft.claude.effort, 'high');
  assert.equal(draft.compatible.model, '', 'a Claude slot is saved while the compatible one has no model');

  el('provider').value = 'grok';
  el('provider').dispatch('change');
  assert.equal(el('grokSection').hidden, false);
  assert.equal(el('claudeSection').hidden, true);
});

test('the backup frame has no sign-in sections of its own', () => {
  const { root, el } = fakeRoot(BACKUP_FIELDS);
  const form = formFor(root);

  form.fill(mergeSettings({}).fallback);
  assert.equal(el('chatgptSection'), null, 'the backup frame has no ChatGPT section');
  assert.equal(el('grokSection'), null, 'and no Grok one');
  assert.equal(el('compatibleSection').hidden, false, 'a compatible backup shows its own fields');
  assert.equal(form.read().provider, 'compatible');
});

test('reselecting the same model preserves effort; a changed model clears the old test result', () => {
  const { root, el } = fakeRoot(MAIN_FIELDS);
  const form = formFor(root);
  form.fill(mergeSettings({ provider: 'compatible', compatible: { preset: 'custom', model: 'manual-model', effort: 'high' } }));
  el('test').dataset.state = 'ok';
  el('testResult').textContent = 'manual-model tested';
  form.chooseModel('manual-model');
  assert.equal(form.read().compatible.effort, 'high');
  assert.equal(el('testResult').textContent, 'manual-model tested');
  form.chooseModel('different-model');
  assert.equal(el('testResult').textContent, '');
  assert.equal(el('test').dataset.state, '');
});

test('Gemini and Kimi provider fields keep separate keys and switch account mode explicitly', () => {
  const { root, el } = fakeRoot(MAIN_FIELDS);
  const form = formFor(root);
  form.fill(mergeSettings({ provider: 'gemini', gemini: { apiKey: 'GOOGLE-KEY', model: 'gemini-test', effort: 'medium' }, kimi: { apiKey: 'MOONSHOT-KEY', model: 'kimi-test' } }));
  assert.equal(el('geminiSection').hidden, false);
  assert.equal(el('kimiSection').hidden, true);
  assert.equal(form.read().gemini.effort, 'medium');
  el('provider').value = 'kimi';
  el('provider').dispatch('change');
  assert.equal(form.read().kimi.apiKey, 'MOONSHOT-KEY');
  assert.equal(el('modelInput').value, 'kimi-test');
  assert.equal(el('kimiAccount').hidden, true);
  el('kimiAuth').value = 'account';
  el('kimiAuth').dispatch('change');
  assert.equal(el('kimiAccount').hidden, false);
  assert.equal(el('kimiKeyField').hidden, true);
  assert.equal(el('modelInput').value, '', 'different products must not inherit each other\'s model');
  assert.equal(form.read().gemini.apiKey, 'GOOGLE-KEY');
});

test('every sign-in failure the worker can send has a message in every language', async () => {
  const { SIGN_IN_FAILURES } = await import('../src/background/account-login.js');
  const { ACCOUNT_ERROR_CODES } = await import('../src/providers/account-auth.js');
  const { MESSAGES } = await import('../src/sidepanel/messages.js');
  const codes = [...Object.keys(SIGN_IN_FAILURES), ...Object.keys(ACCOUNT_ERROR_CODES)];
  for (const code of codes) {
    for (const language of Object.keys(MESSAGES)) {
      assert.ok(MESSAGES[language][`auth.error.${code}`], `${language} has no message for the ${code} failure`);
    }
  }
});

test('a Claude slot set to an API key is not saved without one', () => {
  const main = mergeSettings({ provider: 'claude', claude: { auth: 'apiKey', apiKey: '  ', model: 'claude-sonnet-4-6' } });
  assert.equal(settingsProblem(main), 'err.anthropicKey');
  main.claude.apiKey = 'sk-ant-api03-key';
  assert.equal(settingsProblem(main), null);

  const account = mergeSettings({ provider: 'claude', claude: { auth: 'account', apiKey: '', model: 'claude-sonnet-4-6' } });
  assert.equal(settingsProblem(account), null, 'a Claude account needs no key');

  const backup = mergeSettings({
    provider: 'chatgpt', chatgpt: { model: 'gpt-5' },
    fallback: { enabled: true, provider: 'claude', claude: { auth: 'apiKey', apiKey: '', model: 'claude-sonnet-4-6' } },
  });
  assert.equal(settingsProblem(backup), 'err.fallbackAnthropicKey');
  backup.fallback.enabled = false;
  assert.equal(settingsProblem(backup), null, 'a backup that is off is not checked');
});
