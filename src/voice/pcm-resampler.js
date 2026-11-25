const TAPS = 32;
const HALF_TAPS = TAPS / 2;
const OUT_RATE = 16000;

function clampSample(value) {
  if (!Number.isFinite(value)) {
    if (value === Infinity) return 1;
    if (value === -Infinity) return -1;
    return 0;
  }
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

function toMono(channels) {
  if (!channels || channels.length === 0) return new Float32Array(0);
  const len = channels[0]?.length ?? 0;
  if (channels.length === 1) {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = clampSample(channels[0][i]);
    return out;
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      sum += clampSample(channels[c][i]);
    }
    out[i] = sum / channels.length;
  }
  return out;
}

function sinc(x) {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

function hann(i, n) {
  if (n <= 1) return 1;
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

export function createPcmResampler(inputRate) {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('inputRate must be a positive number.');
  const cutoff = 0.45 * Math.min(1, OUT_RATE / inputRate);
  const step = inputRate / OUT_RATE;
  let history = new Float32Array(0);
  let historyStart = 0; // absolute index of history[0] in input stream
  let totalInput = 0;
  let nextPos = 0; // absolute source position for next output sample

  function sampleAt(pos) {
    const base = Math.floor(pos);
    const frac = pos - base;
    let sum = 0;
    let wsum = 0;
    // taps: offsets such that we cover HALF_TAPS on each side
    for (let j = 0; j < TAPS; j++) {
      const offset = j - (HALF_TAPS - 1); // -15..16
      const idx = base + offset;
      const x = offset - frac;
      const s = sinc(x * cutoff) * cutoff;
      const w = hann(j, TAPS);
      const coeff = s * w;
      const local = idx - historyStart;
      const sample = local >= 0 && local < history.length ? history[local] : 0;
      sum += sample * coeff;
      wsum += coeff;
    }
    if (wsum !== 0) sum /= wsum;
    return clampSample(sum);
  }

  function push(channels) {
    const mono = toMono(channels);
    if (mono.length === 0) return new Float32Array(0);
    // append mono to history
    const prev = history;
    const combined = new Float32Array(prev.length + mono.length);
    combined.set(prev, 0);
    combined.set(mono, prev.length);
    history = combined;
    totalInput += mono.length;

    const out = [];
    // Need enough samples on the right: base + HALF_TAPS < totalInput => pos < totalInput - HALF_TAPS
    // and on the left: base - (HALF_TAPS - 1) >= historyStart
    while (true) {
      const base = Math.floor(nextPos);
      const leftIdx = base - (HALF_TAPS - 1);
      const rightIdx = base + HALF_TAPS;
      if (rightIdx >= totalInput) break;
      if (leftIdx < historyStart) { nextPos += step; continue; }
      out.push(sampleAt(nextPos));
      nextPos += step;
    }

    // Trim history: keep enough for future left edge
    const minNeeded = Math.floor(nextPos) - (HALF_TAPS - 1);
    const drop = Math.max(0, minNeeded - historyStart - 64);
    if (drop > 0 && drop < history.length) {
      history = history.slice(drop);
      historyStart += drop;
    } else if (drop >= history.length) {
      history = new Float32Array(0);
      historyStart = totalInput;
    }

    return Float32Array.from(out);
  }

  function reset() {
    history = new Float32Array(0);
    historyStart = 0;
    totalInput = 0;
    nextPos = 0;
  }

  return { push, reset };
}
