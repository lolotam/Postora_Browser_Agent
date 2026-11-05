import { TRANSCRIPTION_SERVICES } from '../voice/transcription.js';
import { nativeRequest } from '../native/client.js';
import { t } from './i18n.js';

export function createTranscriptionForm(root = document) {
  const el = (id) => root.getElementById(id);
  let provider = 'openai', services = {}, download, generation = 0;
  const fields = () => ({ endpoint: el('transcriptionEndpoint').value.trim(), model: el('transcriptionModel').value.trim(), apiKey: el('transcriptionKey').value.trim() });
  function show(config) {
    el('transcriptionEndpoint').value = config.endpoint;
    el('transcriptionModel').value = config.model;
    el('transcriptionKey').value = config.apiKey || '';
  }
  async function sync() {
    const mine = ++generation;
    const local = provider === 'local', browser = el('transcriptionMode').value === 'browser';
    el('transcriptionCloud').hidden = local || browser;
    el('transcriptionLocal').hidden = !local || browser;
    el('transcriptionService').closest('label').hidden = browser;
    el('transcriptionEndpoint').readOnly = provider !== 'custom';
    if (!local || browser || download) return;
    el('localModelStatus').textContent = '';
    try {
      const { result } = await nativeRequest({ type: 'speech-status' });
      if (mine !== generation) return;
      el('downloadLocalModel').hidden = result.installed;
      el('localModelStatus').textContent = result.installed ? t('voice.localReady') : '';
    } catch (error) {
      if (mine === generation) { el('downloadLocalModel').hidden = false; el('localModelStatus').textContent = error.message; }
    }
  }
  el('transcriptionService').addEventListener('change', () => {
    services[provider] = fields();
    provider = el('transcriptionService').value;
    show(services[provider] || TRANSCRIPTION_SERVICES[provider]);
    void sync();
  });
  el('transcriptionMode').addEventListener('change', () => { void sync(); });
  el('downloadLocalModel').addEventListener('click', async () => {
    if (download) return;
    download = new AbortController();
    el('downloadLocalModel').disabled = true;
    el('cancelLocalModel').hidden = false;
    el('localModelProgress').hidden = false;
    el('localModelProgress').value = 0;
    el('localModelStatus').textContent = '0%';
    try {
      const { result } = await nativeRequest({ type: 'speech-install' }, { signal: download.signal, onProgress: (event) => {
        el('localModelProgress').value = event.percent;
        el('localModelStatus').textContent = event.phase === 'install' ? t('voice.installing') : `${event.percent}%`;
      } });
      if (!result.installed) throw new Error('Local model installation did not complete.');
      el('localModelProgress').value = 100;
      el('localModelStatus').textContent = t('voice.localReady');
      el('downloadLocalModel').hidden = true;
    } catch (error) { el('localModelStatus').textContent = error.message; }
    finally { download = null; el('downloadLocalModel').disabled = false; el('cancelLocalModel').hidden = true; }
  });
  el('cancelLocalModel').addEventListener('click', () => download?.abort());
  return {
    fill(config) {
      services = structuredClone(config.services || {});
      provider = TRANSCRIPTION_SERVICES[config.provider] ? config.provider : 'custom';
      el('transcriptionService').value = provider;
      el('transcriptionMode').value = config.mode;
      el('transcriptionPause').value = String(config.endSilenceMs || 1200);
      show(config); void sync();
    },
    read() {
      services[provider] = fields();
      return { mode: el('transcriptionMode').value, provider, endSilenceMs: Number(el('transcriptionPause').value), ...fields(), services: structuredClone(services) };
    },
  };
}
