import { transcribeLocal } from './local-transcription.js';
import { isLocalProvider, normalizeLocal } from './local-models.js';

export const TRANSCRIPTION_SERVICES = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-transcribe' },
  groq: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  deepgram: { label: 'Deepgram', endpoint: 'https://api.deepgram.com/v1/listen', model: 'nova-3' },
  'local-nemotron': { label: 'Nemotron Streaming 3.5', endpoint: '', model: 'nemotron-3.5-q8_0' },
  'local-whisper': { label: 'Whisper Base', endpoint: '', model: 'base' },
  custom: { label: 'Custom · OpenAI-compatible', endpoint: 'http://localhost:8080/v1/audio/transcriptions', model: 'whisper-1' },
};

export const DEFAULT_TRANSCRIPTION = {
  mode: 'auto', provider: 'openai', ...TRANSCRIPTION_SERVICES.openai, apiKey: '', services: {},
};

export function speechLocale(text) {
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(text) ? 'ar-EG' : 'en-US';
}

export function validateTranscription(config) {
  const normalized = normalizeLocal({ ...DEFAULT_TRANSCRIPTION, ...config });
  if (!TRANSCRIPTION_SERVICES[normalized.provider]) throw new Error('Unknown transcription service.');
  const endpoint = normalized.endpoint || TRANSCRIPTION_SERVICES[normalized.provider].endpoint;
  if (isLocalProvider(normalized.provider)) return { ...normalized, endpoint: null };
  if (normalized.mode === 'browser') return { ...normalized, endpoint };
  if (!endpoint) throw new Error('Transcription endpoint is required.');
  if (!/^https?:\/\//i.test(endpoint) || (!/^https:\/\//i.test(endpoint) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(endpoint))) {
    throw new Error('Remote transcription services require HTTPS. Use http://localhost for a local server.');
  }
  return { ...normalized, endpoint };
}

export async function transcribeAudio(blob, config = {}, { fetcher = fetch, signal } = {}) {
  const settings = validateTranscription(config);
  if (settings.provider === 'local-nemotron') throw new Error('Nemotron requires live microphone capture.');
  if (settings.provider === 'local-whisper') return transcribeLocal(blob, { signal, modelId: 'local-whisper' });
  const localServer = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(settings.endpoint || '');
  if (!settings.apiKey && !localServer) throw new Error('Speech transcription needs an API key for this service.');
  if (settings.provider === 'deepgram') {
    const endpoint = new URL(settings.endpoint);
    endpoint.searchParams.set('model', settings.model);
    endpoint.searchParams.set('language', 'multi');
    endpoint.searchParams.delete('language_hint');
    endpoint.searchParams.append('language_hint', 'ar');
    endpoint.searchParams.append('language_hint', 'en');
    const response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: `Token ${settings.apiKey}`, 'Content-Type': blob.type || 'audio/webm' }, body: blob, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`Speech transcription failed (${response.status}).`);
    return response.json().then(readTranscript);
  }
  const form = new FormData();
  form.set('file', blob, `speech.${blob.type?.split('/')[1] || 'webm'}`);
  form.set('model', settings.model);
  // No forced language: keep Arabic speech in Arabic and let English come through.
  const response = await fetcher(settings.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}` }, body: form, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`Speech transcription failed (${response.status}).`);
  return response.json().then(readTranscript);
}

function readTranscript(data) {
  const text = data?.text || data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || data?.transcript || '';
  if (!text.trim()) throw new Error('Speech transcription returned no text.');
  return text.trim();
}
