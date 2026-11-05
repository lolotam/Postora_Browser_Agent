import { nativeRequest } from '../native/client.js';

export function pcmWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)), true));
  return new Uint8Array(buffer);
}

export async function transcribeLocal(blob, { signal } = {}) {
  signal?.throwIfAborted();
  const context = new AudioContext();
  let decoded;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
  finally { await context.close(); }
  if (decoded.duration > 32) throw new Error('Local transcription supports recordings up to 32 seconds.');
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
  const rendered = await offline.startRendering();
  signal?.throwIfAborted();
  const wav = pcmWav(rendered.getChannelData(0));
  let binary = '';
  for (let i = 0; i < wav.length; i += 8192) binary += String.fromCharCode(...wav.subarray(i, i + 8192));
  const result = await nativeRequest({ type: 'speech-transcribe', audio: btoa(binary) }, { signal });
  return result.result.text;
}
