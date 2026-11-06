import { transcribeLocal } from './local-transcription.js';

export const TRANSCRIPTION_SERVICES = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-transcribe' },
  groq: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  deepgram: { label: 'Deepgram', endpoint: 'https://api.deepgram.com/v1/listen', model: 'nova-3' },
  local: { label: 'Local · Whisper', endpoint: '', model: 'base' },
  custom: { label: 'Custom · OpenAI-compatible', endpoint: 'http://localhost:8080/v1/audio/transcriptions', model: 'whisper-1' },
};

export const DEFAULT_TRANSCRIPTION = {
  mode: 'auto', provider: 'openai', ...TRANSCRIPTION_SERVICES.openai, apiKey: '', services: {},
};

export function speechLocale(text) {
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(text) ? 'ar-EG' : 'en-US';
}

export function validateTranscription(config) {
  const settings = { ...DEFAULT_TRANSCRIPTION, ...config };
  if (!TRANSCRIPTION_SERVICES[settings.provider]) throw new Error('Unknown transcription service.');
  if (settings.provider === 'local') return { settings, endpoint: null };
  const endpoint = new URL(settings.endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw new Error('Use HTTPS or a localhost transcription endpoint.');
  if (endpoint.username || endpoint.password) throw new Error('Do not put credentials in the transcription URL.');
  if (!local && !settings.apiKey?.trim()) throw new Error('Configure the transcription API key in Settings → Voice.');
  if (!settings.model?.trim()) throw new Error('Choose a transcription model in Settings → Voice.');
  return { settings, endpoint };
}

export async function transcribeAudio(blob, config, { signal, fetcher = fetch } = {}) {
  const { settings, endpoint } = validateTranscription(config);
  if (!blob?.size || blob.size > 20 * 1024 * 1024) throw new Error('Recording must be between 1 byte and 20 MiB.');
  if (settings.provider === 'local') return transcribeLocal(blob, { signal });
  if (settings.provider === 'deepgram') {
    // Nova-3 multi includes Arabic and English; never accept its English default.
    endpoint.searchParams.set('model', settings.model);
    endpoint.searchParams.set('language', 'multi');
    endpoint.searchParams.append('language_hint', 'ar');
    endpoint.searchParams.append('language_hint', 'en');
    endpoint.searchParams.set('smart_format', 'true');
    const response = await fetcher(endpoint.href, {
      method: 'POST', body: blob, credentials: 'omit', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { Authorization: `Token ${settings.apiKey.trim()}`, 'Content-Type': blob.type || 'audio/webm' },
    });
    if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status}). Check the Voice service settings.`);
    const result = await response.json();
    const text = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof text !== 'string') throw new Error('Transcription service returned no text.');
    return text.trim();
  }
  const form = new FormData();
  form.append('file', blob, blob.type.includes('mp4') ? 'recording.mp4' : 'recording.webm');
  form.append('model', settings.model);
  form.append('response_format', 'json');
  // Deliberately no language/translation parameter: preserve Arabic and English.
  const response = await fetcher(endpoint.href, {
    method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), credentials: 'omit', redirect: 'error',
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {},
  });
  if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status}). Check the Voice service settings.`);
  const result = await response.json();
  if (typeof result.text !== 'string') throw new Error('Transcription service returned no text.');
  return result.text.trim();
}
