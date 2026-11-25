import { TRANSCRIPTION_SERVICES } from '../voice/transcription.js';
import { LOCAL_MODELS, isLocalProvider } from '../voice/local-models.js';
import { nativeRequest } from '../native/client.js';
import { t } from './i18n.js';

function readableSize(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MB`;
}

/**
 * The transcription settings of the panel.
 *
 * Every local model keeps its own record: its own download, its own progress
 * and its own error. Choosing another model never cancels the download of the
 * one before it, and the status of a model never lands on another one.
 */
export function createTranscriptionForm(root = document) {
  const el = (id) => root.getElementById(id);
  let provider = 'openai';
  let services = {};
  let generation = 0;
  const modelState = new Map();

  const stateFor = (id) => {
    if (!modelState.has(id)) modelState.set(id, { id, controller: null, generation: 0, installed: false, percent: 0, phase: '', error: '' });
    return modelState.get(id);
  };
  const fields = () => ({ endpoint: el('transcriptionEndpoint').value.trim(), model: el('transcriptionModel').value.trim(), apiKey: el('transcriptionKey').value.trim() });
  function show(config) {
    el('transcriptionEndpoint').value = config.endpoint ?? '';
    el('transcriptionModel').value = config.model ?? '';
    el('transcriptionKey').value = config.apiKey || '';
  }

  /** Shows the record of the model that is on the screen. */
  function renderLocal(record) {
    const busy = Boolean(record.controller);
    el('downloadLocalModel').hidden = record.installed || busy;
    el('downloadLocalModel').disabled = busy;
    el('cancelLocalModel').hidden = !busy;
    el('localModelProgress').hidden = !busy;
    el('localModelProgress').value = record.percent;
    if (record.error) el('localModelStatus').textContent = record.error;
    else if (record.installed) el('localModelStatus').textContent = t('voice.localReady');
    else if (busy) el('localModelStatus').textContent = record.phase === 'install' ? t('voice.installing') : `${record.percent}%`;
    else el('localModelStatus').textContent = '';
  }

  function renderSelected() {
    if (!isLocalProvider(provider)) return;
    const record = stateFor(provider);
    const model = LOCAL_MODELS[provider];
    el('localModelHelp').textContent = provider === 'local-nemotron' ? t('voice.localNemotronHelp') : t('voice.localWhisperHelp');
    el('localModelStatus').title = model ? t('voice.localSize', { size: readableSize(model.bytes), bytes: model.bytes }) : '';
    renderLocal(record);
  }

  async function sync() {
    const mine = ++generation;
    const local = isLocalProvider(provider);
    const browser = el('transcriptionMode').value === 'browser';
    el('transcriptionCloud').hidden = local || browser;
    el('transcriptionLocal').hidden = !local || browser;
    el('transcriptionService').closest('label').hidden = browser;
    el('transcriptionEndpoint').readOnly = provider !== 'custom';
    if (!local || browser) return;
    const record = stateFor(provider);
    renderSelected();
    // The status of the model that is selected, and of no other.
    try {
      const { result } = await nativeRequest({ type: 'speech-status', modelId: provider });
      if (mine !== generation || provider !== record.id) return;
      record.installed = result?.installed === true;
      record.error = '';
      renderSelected();
    } catch (error) {
      if (mine !== generation || provider !== record.id) return;
      // A missing or unsupported runtime keeps the selection: the user sees
      // what is wrong and can pick another model.
      record.installed = false;
      record.error = error?.message || String(error);
      renderSelected();
    }
  }

  el('transcriptionService').addEventListener('change', () => {
    if (!isLocalProvider(provider)) services[provider] = fields();
    provider = el('transcriptionService').value;
    if (!isLocalProvider(provider)) show(services[provider] || TRANSCRIPTION_SERVICES[provider] || { endpoint: '', model: '', apiKey: '' });
    void sync();
  });
  el('transcriptionMode').addEventListener('change', () => { void sync(); });
  el('downloadLocalModel').addEventListener('click', async () => {
    const modelId = provider;
    if (!isLocalProvider(modelId)) return;
    const record = stateFor(modelId);
    if (record.controller) return;
    const controller = new AbortController();
    record.controller = controller;
    record.generation += 1;
    const mine = record.generation;
    record.percent = 0;
    record.phase = 'download';
    record.error = '';
    if (provider === modelId) renderLocal(record);
    try {
      const { result } = await nativeRequest({ type: 'speech-install', modelId }, {
        signal: controller.signal,
        confirmWaitMs: 0,
        onProgress: (event) => {
          if (record.generation !== mine) return;
          record.percent = event.percent;
          record.phase = event.phase;
          // Only the model on the screen is drawn.
          if (provider === modelId) renderLocal(record);
        },
      });
      if (record.generation !== mine) return;
      if (!result?.installed) throw new Error('The local model installation did not complete.');
      record.installed = true;
      record.percent = 100;
      record.phase = 'ready';
    } catch (error) {
      if (record.generation !== mine) return;
      record.error = error?.message || String(error);
      if (error?.outcome === 'unknown') {
        void nativeRequest({ type: 'speech-status', modelId }).then(
          ({ result: status }) => {
            if (record.generation !== mine) return;
            if (status?.installed === true) {
              record.installed = true;
              record.percent = 100;
              record.phase = 'ready';
              record.error = '';
              if (provider === modelId) renderLocal(record);
            }
          },
          () => {},
        );
      }
    } finally {
      if (record.generation === mine) {
        record.controller = null;
        if (provider === modelId) renderLocal(record);
      }
    }
  });
  el('cancelLocalModel').addEventListener('click', () => { stateFor(provider).controller?.abort(); });
  return {
    fill(config) {
      services = structuredClone(config.services || {});
      const known = TRANSCRIPTION_SERVICES[config.provider] || isLocalProvider(config.provider);
      provider = known ? config.provider : 'custom';
      el('transcriptionService').value = provider;
      el('transcriptionMode').value = config.mode;
      if (el('transcriptionLanguage')) el('transcriptionLanguage').value = config.language || 'auto';
      el('transcriptionPause').value = String(config.endSilenceMs || 1200);
      show(config);
      void sync();
    },
    read() {
      if (!isLocalProvider(provider)) services[provider] = fields();
      const language = el('transcriptionLanguage')?.value || 'auto';
      return { mode: el('transcriptionMode').value, language, provider, endSilenceMs: Number(el('transcriptionPause').value), ...fields(), services: structuredClone(services) };
    },
  };
}
