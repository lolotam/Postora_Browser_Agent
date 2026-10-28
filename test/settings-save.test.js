import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsSaver, settingsEdits } from '../src/sidepanel/settings-save.js';

test('overlapping mutations and a form save rebase on the latest successful reply', async () => {
  let current = { uiLanguage: 'en', maxSteps: 40, compatible: { model: 'old', effort: 'high' } };
  const base = structuredClone(current);
  const writes = [];
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const save = createSettingsSaver({
    getSettings: () => current, onSaved: (value) => { current = value; },
    save: async (next) => {
      writes.push(structuredClone(next));
      if (writes.length === 1) await new Promise((done) => { release = done; markStarted(); });
      return structuredClone(next);
    },
  });
  const model = save((settings) => ({ ...settings, compatible: { ...settings.compatible, model: 'new' } }));
  const language = save((settings) => ({ ...settings, uiLanguage: 'ar' }));
  const form = save(settingsEdits(base, { ...base, maxSteps: 77 }));
  await started;
  assert.equal(writes.length, 1);
  release();
  await Promise.all([model, language, form]);
  assert.deepEqual(current, { uiLanguage: 'ar', maxSteps: 77, compatible: { model: 'new', effort: 'high' } });
  assert.equal(writes.length, 3);
  assert.equal(base.compatible.model, 'old', 'capturing edits did not mutate the draft baseline');
});

test('a failed save does not poison the queue or become its source of truth', async () => {
  let current = { maxSteps: 40, uiLanguage: 'en' };
  const save = createSettingsSaver({
    getSettings: () => current, onSaved: (value) => { current = value; },
    save: async (next) => { if (next.maxSteps === 99) throw new Error('storage failed'); return next; },
  });
  const failed = save((settings) => ({ ...settings, maxSteps: 99 }));
  const language = save((settings) => ({ ...settings, uiLanguage: 'ar' }));
  await assert.rejects(failed, /storage failed/);
  await language;
  assert.deepEqual(current, { maxSteps: 40, uiLanguage: 'ar' });
});

test('unchanged mutations are no-ops and do not write storage', async () => {
  const current = { uiLanguage: 'en' };
  const save = createSettingsSaver({ getSettings: () => current, onSaved: () => assert.fail('unexpected update'), save: () => assert.fail('unexpected write') });
  assert.equal(await save(settingsEdits(current, structuredClone(current))), current);
});

test('nested draft edits preserve unrelated saved fields and capture values immediately', () => {
  const base = { compatible: { model: 'old', effort: 'high' }, keys: { custom: 'a' } };
  const draft = structuredClone(base);
  draft.compatible.model = 'new';
  const apply = settingsEdits(base, draft);
  draft.compatible.model = 'later typing';
  const current = { compatible: { model: 'old', effort: 'low' }, keys: { custom: 'b' } };
  assert.deepEqual(apply(current), { compatible: { model: 'new', effort: 'low' }, keys: { custom: 'b' } });
  assert.equal(current.compatible.model, 'old');
});

test('explicit key removal is not lost when rebasing a form save', () => {
  const apply = settingsEdits({ keys: { typesafe: 'old-key' }, fast: { apiKey: 'old-key' } }, { keys: {}, fast: { apiKey: '' } });
  assert.deepEqual(apply({ keys: { typesafe: 'old-key', anthropic: 'other-key' }, fast: { apiKey: 'old-key' }, uiLanguage: 'ar' }), {
    keys: { anthropic: 'other-key' }, fast: { apiKey: '' }, uiLanguage: 'ar',
  });
});
