import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { speechHome, speechOperation, commitInstallation } from '../native/speech.mjs';
import {
  NEMOTRON_ASSET,
  NEMOTRON_LANGUAGE,
  NEMOTRON_MODEL_ID,
  NEMOTRON_STREAM_FAMILY,
  assertCanStream,
  nemotronInstall,
  nemotronStatus,
} from '../native/nemotron.mjs';
import { MINIMUM_VCPP, VCPP_INSTRUCTION, checkRuntime, versionIsEnough } from '../native/runtime-check.mjs';

function assetBuffer(text = 'nemotron-fixture-bytes') {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, size: bytes.length };
}

function fakeFetcher(body, { status = 200 } = {}) {
  return async () => new Response(body, { status });
}

async function withTempHome(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-nemotron-'));
  const home = path.join(root, 'speech');
  await fs.mkdir(home, { recursive: true });
  try {
    return await run(home);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('nemotron and whisper statuses are independent and Nemotron reports protocol 1', async () => {
  await withTempHome(async (home) => {
    const nemotron = await speechOperation({ type: 'speech-status', modelId: NEMOTRON_MODEL_ID }, { home, supported: true });
    assert.deepEqual(nemotron, { modelId: NEMOTRON_MODEL_ID, installed: false, supported: true, protocol: 1 });

    const unsupported = await nemotronStatus({ home, supported: false });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.protocol, 1);

    const whisper = await speechOperation({ type: 'speech-status', modelId: 'local-whisper' });
    assert.equal(typeof whisper.installed, 'boolean');
    assert.equal(Object.hasOwn(whisper, 'protocol'), false);
  });
});

test('nemotron install rejects digest and length mismatches before publication', async () => {
  await withTempHome(async (home) => {
    const good = assetBuffer('correct-bytes');
    const bad = assetBuffer('wrong-bytes');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: good.size, sha256: bad.sha256, url: 'https://example.invalid/model.gguf' };
    await assert.rejects(
      nemotronInstall({ home, supported: true, asset, fetcher: fakeFetcher(good.bytes), loadModel: async () => ({ dispose() {} }) }),
      /SHA-256/i,
    );
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, false);
  });

  await withTempHome(async (home) => {
    const bytes = Buffer.from('abc');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: 2, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/model.gguf' };
    await assert.rejects(
      nemotronInstall({ home, supported: true, asset, fetcher: fakeFetcher(bytes) }),
      /size/i,
    );
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, false);
  });
});

test('nemotron install cancel before publication leaves no installed model', async () => {
  await withTempHome(async (home) => {
    const fixture = assetBuffer('cancel-me');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: fixture.size, sha256: fixture.sha256, url: 'https://example.invalid/model.gguf' };
    const controller = new AbortController();
    await assert.rejects(
      nemotronInstall({
        home,
        supported: true,
        asset,
        signal: controller.signal,
        fetcher: fakeFetcher(fixture.bytes),
        loadModel: async () => {
          controller.abort();
          return { dispose() {} };
        },
      }),
    );
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, false);
  });
});

test('nemotron install concurrent commit winner is respected', async () => {
  await withTempHome(async (home) => {
    const fixture = assetBuffer('winner-bytes');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: fixture.size, sha256: fixture.sha256, url: 'https://example.invalid/model.gguf' };
    const destination = path.join(home, 'nemotron-3.5-q8_0-53ce288f');
    let winnerPublished = false;
    await nemotronInstall({
      home,
      supported: true,
      asset,
      fetcher: fakeFetcher(fixture.bytes),
      loadModel: async () => {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, asset.name), fixture.bytes);
        winnerPublished = true;
        return { dispose() {} };
      },
    });
    assert.equal(winnerPublished, true);
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, true);
    const installed = await fs.readFile(path.join(destination, asset.name));
    assert.deepEqual(installed, fixture.bytes);
  });
});

test('nemotron install failed repair preserves old directory', async () => {
  await withTempHome(async (home) => {
    const good = assetBuffer('good-model-bytes');
    const bad = assetBuffer('bad-model');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: good.size, sha256: good.sha256, url: 'https://example.invalid/model.gguf' };
    const destination = path.join(home, 'nemotron-3.5-q8_0-53ce288f');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, asset.name), bad.bytes);
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, false);

    const staging = `${destination}.staging-manual`;
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, asset.name), good.bytes);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      commitInstallation(staging, destination, async () => {
        try { const s = await fs.stat(path.join(destination, asset.name)); return s.size === good.size; } catch { return false; }
      }, controller.signal),
    );
    const restored = await fs.readFile(path.join(destination, asset.name));
    assert.deepEqual(restored, bad.bytes);
    await fs.rm(staging, { recursive: true, force: true });
  });
});

test('nemotron operation rejects unknown local speech model ids', async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      speechOperation({ type: 'speech-status', modelId: 'local-unknown-model' }, { home, supported: true }),
      /Unknown local speech model/i,
    );
  });
});

test('nemotron installed status is true only when file size matches', async () => {
  await withTempHome(async (home) => {
    const fixture = assetBuffer('installed-model');
    const asset = { ...NEMOTRON_ASSET, name: 'nemotron.gguf', size: fixture.size, sha256: fixture.sha256, url: 'https://example.invalid/model.gguf' };
    const destination = path.join(home, 'nemotron-3.5-q8_0-53ce288f');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, asset.name), fixture.bytes);
    const installed = await nemotronStatus({ home, supported: true, asset });
    assert.equal(installed.installed, true);
    assert.equal(installed.protocol, 1);
    assert.equal(installed.modelId, NEMOTRON_MODEL_ID);

    await fs.writeFile(path.join(destination, asset.name), Buffer.from('short'));
    assert.equal((await nemotronStatus({ home, supported: true, asset })).installed, false);
  });
});

test('speechHome is exported for Nemotron paths', () => {
  assert.equal(typeof speechHome, 'function');
  assert.ok(speechHome().toLowerCase().includes('speech'));
});

test('the model is streamed through the parakeet slot the pinned runtime serves it with', () => {
  assert.deepEqual(NEMOTRON_STREAM_FAMILY, { kind: 'parakeet' });
  assert.equal(NEMOTRON_LANGUAGE, 'auto');
});

test('a model the pinned runtime cannot stream is refused with an explanation', () => {
  const refusing = { accepts: () => false, dispose() {} };
  assert.throws(() => assertCanStream(refusing), /cannot stream this model/i);
  const serving = { accepts: (family) => family.kind === 'parakeet' };
  assert.equal(assertCanStream(serving), serving);
});

test('the Visual C++ runtime version is compared with the minimum this build needs', () => {
  assert.equal(MINIMUM_VCPP, '14.40');
  assert.equal(versionIsEnough('14.40.33810.0'), true);
  assert.equal(versionIsEnough('14.40'), true);
  assert.equal(versionIsEnough('14.41.1.2'), true);
  assert.equal(versionIsEnough('14.39.99999.0'), false);
  assert.equal(versionIsEnough(null), false);
  assert.ok(VCPP_INSTRUCTION.includes('vc_redist'), 'the instruction says what to install');
});

test('the runtime check reads the answer of a child, and a child that dies is a result', async () => {
  const ready = await checkRuntime({ execFile: async () => ({ stdout: JSON.stringify({ ok: true, version: '14.40.1', reason: null }), stderr: '' }) });
  assert.equal(ready.ok, true);
  assert.equal(ready.version, '14.40.1');
  assert.equal(ready.instruction, null);

  const tooOld = await checkRuntime({ execFile: async () => {
    const error = new Error('exited with code 1');
    error.stdout = JSON.stringify({ ok: false, version: '14.39', reason: 'too old' });
    throw error;
  } });
  assert.equal(tooOld.ok, false);
  assert.equal(tooOld.reason, 'too old');
  assert.equal(tooOld.instruction, VCPP_INSTRUCTION);

  const crashed = await checkRuntime({ execFile: async () => { throw new Error('the child died'); } });
  assert.equal(crashed.ok, false);
  assert.ok(crashed.instruction, 'a child that dies still gets an instruction');
});
