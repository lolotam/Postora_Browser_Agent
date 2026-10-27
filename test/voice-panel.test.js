import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../src/sidepanel/messages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'src/sidepanel/index.html'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'src/sidepanel/panel.js'), 'utf8');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

test('no id is used twice on the panel', () => {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const twice = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(twice, [], 'an id that appears twice sends the updates to the wrong element');
});

test('the voice screen has the controls it needs', () => {
  for (const id of ['voiceView', 'voiceBackBtn', 'voiceMicBtn', 'voiceLive', 'voiceHandsfree', 'voiceSpeak', 'voiceTypedForm', 'voiceTypedInput', 'voiceApproval', 'voiceLog', 'voiceClearLog', 'voiceEngine']) {
    assert.ok(ids.includes(id), `${id} is missing from the panel`);
  }
});

test('the composer microphone opens the voice screen, and there is only one microphone', () => {
  assert.ok(html.includes('id="voiceToggle"'), 'the composer keeps its microphone button');
  assert.ok(!ids.includes('micBtn'), 'the composer has no second microphone');
  assert.ok(!ids.includes('voiceStage'), 'the composer has no second transcript');
});

test('every element the panel looks up is on the page', () => {
  const wanted = [...panel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(wanted)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});

test('every translated string of the page is translated in both languages', () => {
  const keys = [...html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)].map((match) => match[1]);
  for (const language of Object.keys(MESSAGES)) {
    const missing = [...new Set(keys)].filter((key) => !(key in MESSAGES[language]));
    assert.deepEqual(missing, [], `${language} is missing a translation`);
  }
});

test('the voice strings are translated in both languages', () => {
  const voice = Object.keys(MESSAGES.en).filter((key) => key.startsWith('voice.'));
  assert.ok(voice.length > 10, 'the voice screen has its own strings');
  for (const language of Object.keys(MESSAGES)) {
    for (const key of voice) assert.ok(key in MESSAGES[language], `${language} is missing ${key}`);
  }
});

test('the voice screen shows a question that is waiting for an answer', () => {
  for (const id of ['voicePending', 'voicePendingText', 'voicePendingBtn']) {
    assert.ok(ids.includes(id), `${id} is missing from the voice screen`);
  }
  // The question is shown with its own words, never hidden behind the screen.
  assert.ok(panel.includes('showPendingQuestion(ui.question)'), 'the voice screen shows the question that waits');
  assert.ok(panel.includes('function showPendingQuestion('), 'the question is shown by the panel');
  assert.ok(panel.includes("$('voicePendingBtn').addEventListener('click', () => showChat())"), 'the user can answer it in the chat');
});
