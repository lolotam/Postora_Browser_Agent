// Speech in the composer. The panel turns the heard words into the same task
// a typed message would send. Chrome's recognizer is created by the panel or,
// when the side panel cannot ask for the microphone, by a real window.
// This module only decides the language, the text, and which failure to show.

/** Sent by the microphone window. The worker answers it and the panel renders it. */
export const MIC_WINDOW = 'mic-window';
/** Sent by the side panel to stop or cancel the microphone window. */
export const MIC_PANEL = 'sidepanel-mic';

/** True for the messages the microphone window and the panel exchange. */
export function isMicRelay(message) {
  return message?.source === MIC_WINDOW || message?.source === MIC_PANEL;
}

/**
 * The side panel has no place to show Chrome's microphone prompt, so the request
 * is dismissed and recognition fails even when the microphone is allowed for
 * websites. Listening stays in the panel only after this extension's own origin
 * has been allowed from a real window.
 */
export function micListenTarget(permissionState) {
  return permissionState === 'granted' ? 'panel' : 'window';
}

/** The recognizer language for the interface the user is looking at. */
export function speechLang(language) {
  return language === 'ar' ? 'ar-EG' : 'en-US';
}

/**
 * The words heard so far, final and interim together. Each result's first
 * alternative is the one Chrome is most sure of.
 */
export function heardText(results) {
  let text = '';
  for (let i = 0; i < results.length; i += 1) {
    text += results[i][0]?.transcript ?? '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The message key for a recognizer error, or null when the panel should stay quiet. */
export function voiceErrorKey(code) {
  if (code === 'no-speech' || code === 'aborted') return null;
  if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') return 'composer.micBlocked';
  if (code === 'network') return 'composer.micNetwork';
  return 'composer.micFailed';
}
