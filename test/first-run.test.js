import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMPATIBLE_PRESETS, mergeSettings } from '../src/lib/settings.js';
import { createKeyStore } from '../src/sidepanel/key-store.js';
import { createProviderForm } from '../src/sidepanel/provider-form.js';

const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const workspaceCss = fs.readFileSync(new URL('../src/sidepanel/workspace.css', import.meta.url), 'utf8');
const panelSource = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');

test('emptyState renders a three-step first-run card using empty.title, empty.body, and empty.ex1..ex3', () => {
  assert.match(html, /id="emptyState"[\s\S]*?data-i18n="empty\.title"/);
  assert.match(html, /id="emptyState"[\s\S]*?data-i18n="empty\.body"/);
  assert.match(html, /data-example="empty\.ex1"[\s\S]*?data-i18n="empty\.ex1"/);
  assert.match(html, /data-example="empty\.ex2"[\s\S]*?data-i18n="empty\.ex2"/);
  assert.match(html, /data-example="empty\.ex3"[\s\S]*?data-i18n="empty\.ex3"/);
  assert.doesNotMatch(workspaceCss, /\.empty\s*\{\s*display:\s*none;\s*\}/);
});

test('first run without an active model lands on the models overview page', () => {
  assert.match(panelSource, /if\s*\(!activeModel\(\)\)\s*toggleSettings\(true,\s*'models'\);/);
});

test('provider form notifies onModels with autoPicked and signedIn when first sign-in loads a catalog', async () => {
  const fields = ['provider', 'preset', 'baseUrl', 'apiKey', 'chatgptSection', 'claudeSection', 'grokSection', 'compatibleSection', 'claudeAuth', 'claudeApiKey', 'modelInput', 'modelInfo', 'effort', 'test', 'testResult', 'geminiSection', 'geminiApiKey', 'kimiSection', 'kimiAuth', 'kimiApiKey', 'kimiKeyField', 'kimiAccount'];
  const elements = new Map();
  const root = {
    querySelector(selector) {
      const name = selector.match(/\[data-field="([^"]+)"\]/)?.[1];
      if (!name || !fields.includes(name)) return null;
      if (!elements.has(name)) {
        elements.set(name, { value: '', hidden: false, innerHTML: '', textContent: '', dataset: {}, addEventListener() {}, focus() {} });
      }
      return elements.get(name);
    },
    addEventListener() {},
  };
  const events = [];
  const form = createProviderForm(root, {
    keyStore: createKeyStore(),
    getPresets: () => COMPATIBLE_PRESETS,
    onModels: (info) => { if (info) events.push(info); },
    request: async (type) => {
      if (type === 'auth-status') return { connected: true, provider: 'chatgpt' };
      if (type === 'list-models') return [{ id: 'gpt-5.4', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] }];
      return {};
    },
  });
  form.fill(mergeSettings({ provider: 'chatgpt', chatgpt: { model: '' } }));
  await form.loadModels();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { autoPicked: true, signedIn: true, id: 'gpt-5.4', effort: 'medium' });
});
