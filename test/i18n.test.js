import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES } from '../src/sidepanel/messages.js';
import { resolveLanguage, t, translateFor } from '../src/sidepanel/i18n.js';

test('spoken replies can use Arabic without changing an English interface', () => {
  assert.equal(translateFor('ar', 'voice.doneSpoken'), MESSAGES.ar['voice.doneSpoken']);
  assert.equal(translateFor('en', 'voice.doneSpoken'), MESSAGES.en['voice.doneSpoken']);
  assert.notEqual(translateFor('ar', 'voice.doneSpoken'), translateFor('en', 'voice.doneSpoken'));
});

test('every language translates every key with the same placeholders', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const [base, ...others] = Object.keys(MESSAGES);
  for (const language of others) {
    assert.deepEqual(Object.keys(MESSAGES[language]).sort(), Object.keys(MESSAGES[base]).sort(), `${language} keys differ from ${base}`);
    for (const key of Object.keys(MESSAGES[base])) {
      assert.deepEqual(placeholders(MESSAGES[language][key]), placeholders(MESSAGES[base][key]), `${language} ${key}`);
    }
  }
});

test('an explicit language wins; auto follows the browser and falls back to English', () => {
  assert.equal(resolveLanguage('ar', 'en-US'), 'ar');
  assert.equal(resolveLanguage('auto', 'ar-EG'), 'ar');
  assert.equal(resolveLanguage('auto', 'fr-FR'), 'en');
});

test('t fills placeholders', () => {
  assert.equal(t('model.pickCount', { n: 3 }), '— 3 models —');
});
