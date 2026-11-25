import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stampProviderSlots } from '../src/sidepanel/provider-slot-template.js';

const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');

test('index.html defines a single #providerSlotTemplate and empty #mainProvider / #fallbackProvider containers', () => {
  assert.match(html, /<template id="providerSlotTemplate">/);
  assert.equal((html.match(/data-field="compatibleSection"/g) ?? []).length, 1, 'provider slot markup appears once inside the template');
  assert.match(html, /<div id="mainProvider" class="fields"><\/div>/);
  assert.match(html, /<div id="fallbackProvider" class="fields"><\/div>/);
});

test('stampProviderSlots clones template content and assigns slot-specific element IDs', () => {
  const makeSlotFragment = () => {
    const bySelector = new Map([
      ['[data-field="provider"]', {}],
      ['[data-field="chatgptSection"]', {}],
      ['[data-field="authJson"]', {}],
      ['[data-field="importBtn"]', {}],
      ['[data-field="claudeSection"]', {}],
      ['[data-field="grokSection"]', {}],
      ['[data-field="compatibleSection"]', {}],
      ['[data-field="preset"]', {}],
      ['[data-field="baseUrl"]', {}],
      ['[data-field="apiKey"]', {}],
      ['[data-field="modelBtn"]', {}],
      ['[data-field="modelLabel"]', {}],
      ['[data-field="modelInput"]', {}],
      ['[data-field="modelInfo"]', {}],
      ['[data-field="effort"]', {}],
    ]);
    return {
      bySelector,
      querySelector(sel) { return bySelector.get(sel) ?? null; },
    };
  };

  const mainContainer = { children: [], appended: null, append(frag) { this.appended = frag; this.children.push(frag); } };
  const backupContainer = { children: [], appended: null, append(frag) { this.appended = frag; this.children.push(frag); } };
  const template = {
    content: {
      cloneNode() {
        return makeSlotFragment();
      },
    },
  };
  const root = {
    getElementById(id) {
      if (id === 'providerSlotTemplate') return template;
      if (id === 'mainProvider') return mainContainer;
      if (id === 'fallbackProvider') return backupContainer;
      return null;
    },
  };

  assert.equal(stampProviderSlots(root), true);
  assert.equal(mainContainer.appended.querySelector('[data-field="provider"]').id, 'provider');
  assert.equal(mainContainer.appended.querySelector('[data-field="modelBtn"]').id, 'modelBtnMain');
  assert.equal(mainContainer.appended.querySelector('[data-field="authJson"]').id, 'authJson');
  assert.equal(backupContainer.appended.querySelector('[data-field="modelBtn"]').id, 'modelBtnBackup');
  assert.equal(backupContainer.appended.querySelector('[data-field="authJson"]').id, 'backupAuthJson');
  assert.equal(backupContainer.appended.querySelector('[data-field="provider"]').id, undefined);
});
