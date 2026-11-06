import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pcmWav } from '../src/voice/local-transcription.js';
import { validateWav, downloadAsset, commitInstallation } from '../native/speech.mjs';

test('repair replaces an invalid installation, preserves it, and respects a valid concurrent winner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-install-test-'));
  const destination = path.join(root, 'installed');
  const staging = path.join(root, 'staging');
  try {
    await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'model'), 'corrupt');
    await fs.mkdir(staging); await fs.writeFile(path.join(staging, 'model'), 'verified');
    const valid = async () => { try { return await fs.readFile(path.join(destination, 'model'), 'utf8') === 'verified'; } catch { return false; } };
    await commitInstallation(staging, destination, valid);
    assert.equal(await valid(), true);
    const backup = (await fs.readdir(root)).find((name) => name.startsWith('installed.previous-'));
    assert.equal(await fs.readFile(path.join(root, backup, 'model'), 'utf8'), 'corrupt');
    await fs.mkdir(staging); await fs.writeFile(path.join(staging, 'model'), 'loser');
    await commitInstallation(staging, destination, valid);
    assert.equal(await fs.readFile(path.join(destination, 'model'), 'utf8'), 'verified');
    assert.equal(await fs.readFile(path.join(staging, 'model'), 'utf8'), 'loser');
    await fs.writeFile(`${destination}.install.lock`, 'other installer');
    await assert.rejects(commitInstallation(staging, destination, async () => false), /Another local model/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
