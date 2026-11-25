import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPcmResampler } from '../src/voice/pcm-resampler.js';

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

function sine(rate, freq, seconds, amp = 1) {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return out;
}

function concat(chunks) {
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function pushChunks(resampler, mono, chunkSize) {
  const chunks = [];
  for (let i = 0; i < mono.length; i += chunkSize) {
    const block = mono.subarray(i, Math.min(i + chunkSize, mono.length));
    const out = resampler.push([block]);
    if (out.length) chunks.push(out);
  }
  return concat(chunks);
}

function assertFiniteClamped(samples) {
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Number.isFinite(samples[i]), `sample ${i} not finite`);
    assert.ok(samples[i] >= -1 && samples[i] <= 1, `sample ${i} out of range: ${samples[i]}`);
  }
}

test('16 kHz mono silence produces near-zero output within filter startup convention', () => {
  const r = createPcmResampler(16000);
  const silence = r.push([new Float32Array(1600)]);
  assert.ok(silence.length >= 1600 - 40 && silence.length <= 1600, `got ${silence.length}`);
  assertFiniteClamped(silence);
  assert.ok(rms(silence) < 1e-7);
});

test('stereo channels are averaged before resampling', () => {
  const r = createPcmResampler(16000);
  const n = 256;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 40; i < 120; i++) { left[i] = 1; right[i] = 1; }
  for (let i = 120; i < 200; i++) { left[i] = -1; right[i] = 1; }
  const out = r.push([left, right]);
  assert.ok(out.length >= n - 40 && out.length <= n, `got ${out.length}`);
  assertFiniteClamped(out);
  // Check interior region after filter startup: averaged values 1 and 0
  assert.ok(Math.abs(out[60] - 1) < 1e-4, `expected ~1 got ${out[60]}`);
  assert.ok(Math.abs(out[160] - 0) < 1e-4, `expected ~0 got ${out[160]}`);
});

test('clipped/nonfinite input is treated as finite and output is clamped to [-1,1]', () => {
  const r = createPcmResampler(16000);
  const n = 512;
  const bad = new Float32Array(n).fill(0);
  for (let i = 80; i < 200; i++) bad[i] = 5;
  for (let i = 220; i < 340; i++) bad[i] = -5;
  bad[360] = Infinity; bad[361] = -Infinity; bad[362] = NaN;
  for (let i = 363; i < 420; i++) bad[i] = 0.25;
  const out = r.push([bad]);
  assert.ok(out.length >= n - 40 && out.length <= n, `got ${out.length}`);
  assertFiniteClamped(out);
  const high = out.subarray(120, 180);
  const low = out.subarray(260, 320);
  assert.ok(rms(high) > 0.8, `expected saturated high region, got rms ${rms(high)}`);
  assert.ok(rms(low) > 0.8, `expected saturated low region, got rms ${rms(low)}`);
});

for (const rate of [48000, 44100, 16000]) {
  test(`${rate} Hz: one second of silence yields ~16000 samples within filter startup convention`, () => {
    const r = createPcmResampler(rate);
    const input = new Float32Array(rate);
    const out = pushChunks(r, input, 128);
    // Startup/filter delay may drop a small number of samples; must be close to 1s at 16k.
    assert.ok(out.length >= 16000 - 64 && out.length <= 16000, `got ${out.length} samples for ${rate}Hz`);
    assert.ok(rms(out) < 1e-7);
  });
}

test('48 kHz split render blocks match a single continuous input (stateful across blocks)', () => {
  const input = sine(48000, 440, 0.2);
  const whole = pushChunks(createPcmResampler(48000), input, input.length);
  const split = pushChunks(createPcmResampler(48000), input, 128);
  assert.equal(split.length, whole.length);
  for (let i = 0; i < whole.length; i++) {
    assert.ok(Math.abs(split[i] - whole[i]) < 1e-6, `mismatch at ${i}: ${split[i]} vs ${whole[i]}`);
  }
});

test('44.1 kHz split render blocks match a single continuous input', () => {
  const input = sine(44100, 330, 0.2);
  const whole = pushChunks(createPcmResampler(44100), input, input.length);
  const split = pushChunks(createPcmResampler(44100), input, 127);
  assert.equal(split.length, whole.length);
  for (let i = 0; i < whole.length; i++) {
    assert.ok(Math.abs(split[i] - whole[i]) < 1e-6, `mismatch at ${i}: ${split[i]} vs ${whole[i]}`);
  }
});

test('downsampling attenuates energy above output Nyquist (12 kHz tone from 48 kHz)', () => {
  const hi = sine(48000, 12000, 0.25);
  const low = sine(48000, 1000, 0.25);
  const hiOut = pushChunks(createPcmResampler(48000), hi, 256);
  const lowOut = pushChunks(createPcmResampler(48000), low, 256);
  // Skip startup transient
  const skip = 200;
  assert.ok(rms(hiOut.subarray(skip)) < rms(lowOut.subarray(skip)) * 0.15, `hi ${rms(hiOut.subarray(skip))} not attenuated vs low ${rms(lowOut.subarray(skip))}`);
});

test('reset clears state so new stream is independent', () => {
  const r = createPcmResampler(48000);
  const a = sine(48000, 440, 0.05);
  pushChunks(r, a, 128);
  r.reset();
  const b = sine(48000, 440, 0.05);
  const fresh = pushChunks(createPcmResampler(48000), b, 128);
  const after = pushChunks(r, b, 128);
  assert.equal(after.length, fresh.length);
  for (let i = 0; i < fresh.length; i++) assert.ok(Math.abs(after[i] - fresh[i]) < 1e-6, `mismatch at ${i}`);
});
