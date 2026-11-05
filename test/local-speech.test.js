import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pcmWav } from '../src/voice/local-transcription.js';
import { validateWav, downloadAsset } from '../native/speech.mjs';

test('local audio is mono PCM with a bounded duration and no executable payload', () => {
  const bytes = pcmWav(new Float32Array([0, -1, 1]));
  const wav = validateWav(Buffer.from(bytes).toString('base64'));
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readInt16LE(46), -32768);
  assert.equal(wav.readInt16LE(48), 32767);
  assert.throws(() => validateWav(Buffer.from('bad WAV').toString('base64')), /Expected/);
  assert.throws(() => validateWav('A'.repeat(1400001)), /Invalid/);
});

test('download reports actual received bytes and rejects a mismatched digest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-download-test-'));
  const data = Buffer.from('fixture-model');
  const asset = { url: 'https://fixture.invalid/model', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const fetcher = async () => ({ ok: true, body: [data.subarray(0, 3), data.subarray(3)] });
  const progress = [];
  try {
    await downloadAsset(asset, path.join(dir, 'good'), { fetcher, onBytes: (bytes) => progress.push(bytes) });
    assert.deepEqual(progress, [3, data.length - 3]);
    assert.deepEqual(await fs.readFile(path.join(dir, 'good')), data);
    await assert.rejects(downloadAsset({ ...asset, sha256: 'bad' }, path.join(dir, 'bad'), { fetcher }), /SHA-256/);
    await assert.rejects(downloadAsset({ ...asset, size: 2 }, path.join(dir, 'large'), { fetcher }), /exceeds/);
  } finally { for (const name of await fs.readdir(dir)) await fs.unlink(path.join(dir, name)); await fs.rmdir(dir); }
});
