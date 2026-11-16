import { createAudioRecognition } from './audio-recognition.js';
import { createNemotronRecognition } from './nemotron-recognition.js';
import { transcribeAudio, validateTranscription } from './transcription.js';

function defaultBrowserRecognition() {
  const Ctor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * The recognizer for the chosen transcription setting.
 *
 * The browser recognizer comes first: it needs nothing installed. Then the
 * live local model, which runs on this computer and never reaches the
 * network. Every other choice transcribes one phrase with the service it
 * names.
 *
 * A local model that cannot be built is a failure with its own reason: the
 * audio is never sent somewhere else instead.
 */
export function createConfiguredRecognition(settings, dependencies = {}) {
  const {
    createBrowserRecognition = defaultBrowserRecognition,
    createAudio = createAudioRecognition,
    createNemotron = createNemotronRecognition,
    validate = validateTranscription,
    transcribe = transcribeAudio,
  } = dependencies;
  const config = structuredClone(settings?.transcription ?? {});
  if (config.mode === 'browser') return createBrowserRecognition();
  if (config.provider === 'local-nemotron') return createNemotron();
  return createAudio({
    endSilenceMs: config.endSilenceMs,
    checkConfiguration: () => validate(config),
    transcribe: (blob, signal) => transcribe(blob, config, { signal }),
  });
}
