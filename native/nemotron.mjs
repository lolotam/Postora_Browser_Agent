import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { speechHome, downloadAsset, commitInstallation } from './speech.mjs';

export const NEMOTRON_ASSET = Object.freeze({
  name: 'nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
  size: 751094240,
  sha256: 'b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c',
  url: 'https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/53ce288f69326b415aeef030cfcb02a08a8096dd/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
});

export const NEMOTRON_MODEL_ID = 'local-nemotron';
export const WHISPER_MODEL_ID = 'local-whisper';

/**
 * How the pinned runtime serves this model.
 *
 * The model is a Nemotron ASR streaming checkpoint with an RNN-T head, and the
 * pinned runtime serves it through its parakeet stream slot: the upstream
 * conversion drops the auxiliary CTC head and keeps the RNN-T path. The
 * language is detected by the model itself.
 */
export const NEMOTRON_STREAM_FAMILY = Object.freeze({ kind: 'parakeet' });
export const NEMOTRON_LANGUAGE = 'auto';

/**
 * Refuses a model the pinned runtime cannot stream.
 *
 * A wrong answer is worse than none: the model is only used when the runtime
 * says it serves this stream slot.
 */
export function assertCanStream(model) {
  if (model && typeof model.accepts === 'function' && !model.accepts(NEMOTRON_STREAM_FAMILY)) {
    throw new Error('The installed local speech runtime cannot stream this model: it does not accept the parakeet stream slot. Reinstall the private build with its pinned runtime.');
  }
  return model;
}

/**
 * Loads the Nemotron model for streaming.
 *
 * The binding is imported here and nowhere else, so a build without the
 * private runtime never loads it.
 */
export async function loadNemotronModel({ path: modelPath = nemotronModelPath(), ...options } = {}) {
  const { TranscribeModel } = await import('transcribe-cpp');
  const model = await TranscribeModel.load(modelPath, options);
  try {
    return assertCanStream(model);
  } catch (error) {
    try { await model.dispose?.(); } catch {}
    throw error;
  }
}

const nemotronHome = (home = speechHome()) => path.join(home, 'nemotron-3.5-q8_0-53ce288f');
const nemotronModelPath = (home) => path.join(nemotronHome(home), NEMOTRON_ASSET.name);

export function isNemotronSupported() {
  const [major] = process.versions.node.split('.').map(Number);
  return process.platform === 'win32' && process.arch === 'x64' && major >= 22;
}

export async function nemotronStatus({ home = speechHome(), supported = isNemotronSupported(), asset = NEMOTRON_ASSET } = {}) {
  const installed = await fileReady(path.join(nemotronHome(home), asset.name), asset.size).catch(() => false);
  return { modelId: NEMOTRON_MODEL_ID, installed, supported, protocol: 1 };
}

async function fileReady(file, size) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size === size;
  } catch {
    return false;
  }
}

export async function nemotronInstall({
  home = speechHome(),
  signal,
  onProgress,
  fetcher = fetch,
  loadModel,
  asset = NEMOTRON_ASSET,
  supported = isNemotronSupported(),
} = {}) {
  if (!supported) {
    throw new Error('Nemotron Streaming 3.5 requires Windows x64 and Node.js 22 or newer with a supported native runtime.');
  }
  const destination = nemotronHome(home);
  const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
  const modelFile = path.join(staging, asset.name);
  await fs.mkdir(staging, { recursive: true });
  let loaded;
  try {
    // The envelope of native/speech.mjs: the client takes a reply without
    // `type: 'progress'` for the final answer and rejects it.
    let received = 0;
    await downloadAsset(asset, modelFile, {
      fetcher,
      signal,
      onBytes(bytes) {
        received += bytes;
        onProgress?.({ type: 'progress', phase: 'download', received, total: asset.size, percent: Math.min(99, Math.floor(received * 100 / asset.size)) });
      },
    });
    onProgress?.({ type: 'progress', phase: 'install', received: asset.size, total: asset.size, percent: 99 });
    if (typeof loadModel === 'function') {
      loaded = await loadModel(modelFile);
      if (loaded && typeof loaded.dispose === 'function') await loaded.dispose?.();
      else if (loaded && typeof loaded[Symbol.dispose] === 'function') loaded[Symbol.dispose]();
    }
    signal?.throwIfAborted();
    const valid = async () => fileReady(path.join(destination, asset.name), asset.size);
    await commitInstallation(staging, destination, valid, signal);
  } finally {
    // A commit that found a valid model already in place moves nothing: the
    // download must not stay behind. After a real commit the folder is gone.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return nemotronStatus({ home, supported, asset });
}

export async function nemotronOperation(message, options = {}) {
  if (message.modelId && message.modelId !== NEMOTRON_MODEL_ID) throw new Error(`Unknown local speech model: ${message.modelId}`);
  if (message.type === 'speech-status') return nemotronStatus(options);
  if (message.type === 'speech-install') return nemotronInstall(options);
  throw new Error(`Unsupported Nemotron operation: ${message.type}`);
}

export function nemotronModelFile(home = speechHome()) {
  return nemotronModelPath(home);
}
