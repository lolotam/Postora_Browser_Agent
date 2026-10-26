import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heardText, isMicRelay, micListenTarget, speechLang, voiceErrorKey } from '../src/sidepanel/voice.js';

const phrase = (transcript, isFinal = true) => Object.assign([{ transcript }], { isFinal });

test('Arabic listens in Egyptian Arabic, anything else in English', () => {
  assert.equal(speechLang('ar'), 'ar-EG');
  assert.equal(speechLang('en'), 'en-US');
  assert.equal(speechLang('auto'), 'en-US');
});

test('heard words keep the latest unfinished phrase', () => {
  assert.equal(heardText([phrase('open amazon'), phrase(' and find laptops', false)]), 'open amazon and find laptops');
  assert.equal(heardText([phrase('  ')]), '');
  assert.equal(heardText([phrase(undefined)]), '');
});

test('the side panel listens only after this extension itself may use the microphone', () => {
  assert.equal(micListenTarget('granted'), 'panel');
  assert.equal(micListenTarget('prompt'), 'window');
  assert.equal(micListenTarget('denied'), 'window');
  assert.equal(micListenTarget('unknown'), 'window');
});

test('microphone window messages are not worker requests', () => {
  assert.equal(isMicRelay({ source: 'mic-window', kind: 'partial' }), true);
  assert.equal(isMicRelay({ source: 'sidepanel-mic', kind: 'stop' }), true);
  assert.equal(isMicRelay({ type: 'run' }), false);
  assert.equal(isMicRelay(null), false);
});

test('a blocked microphone and a dead service are named, silence stays quiet', () => {
  assert.equal(voiceErrorKey('not-allowed'), 'composer.micBlocked');
  assert.equal(voiceErrorKey('audio-capture'), 'composer.micBlocked');
  assert.equal(voiceErrorKey('network'), 'composer.micNetwork');
  assert.equal(voiceErrorKey('no-speech'), null);
  assert.equal(voiceErrorKey('aborted'), null);
  assert.equal(voiceErrorKey('something-else'), 'composer.micFailed');
});
