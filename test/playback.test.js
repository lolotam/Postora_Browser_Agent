import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playReply } from '../src/voice/playback.js';

class Utterance { constructor(text) { this.text = text; } }
test('an absent Arabic voice reports the reason and releases the microphone', async () => {
  const codes = []; let ended = 0;
  await playReply('مرحبًا', { Utterance, synth: { getVoices: () => [{ lang: 'en-US' }], speak() { assert.fail('No English fallback'); } }, onStatus: (c) => codes.push(c), onEnd: () => ended++ });
  assert.deepEqual(codes, ['noArabicVoice']); assert.equal(ended, 1);
});
test('paused playback resumes and browser rejection is visible, completing once', async () => {
  const codes = []; let ended = 0, resumed = false;
  await playReply('Hello', { Utterance, synth: { getVoices: () => [{ lang: 'en-US' }], resume() { resumed = true; }, speak(u) { u.onerror({ error: 'not-allowed' }); u.onend(); } }, onStatus: (c) => codes.push(c), onEnd: () => ended++ });
  assert.ok(resumed); assert.equal(codes[0], 'blocked'); assert.equal(ended, 1);
});
