import { speechLocale } from './transcription.js';

// Keep playback failures distinct from microphone/transcription failures.
export async function playReply(text, { synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
  isCurrent = () => true, onEnd = () => {}, onStatus = () => {} } = {}) {
  let ended = false;
  const finish = () => { if (!ended) { ended = true; onEnd(); } };
  const fail = (code) => { if (isCurrent()) onStatus(code); finish(); };
  if (!synth || !Utterance) { fail('unavailable'); return; }
  try {
    if (!synth.getVoices().length) await new Promise((resolve) => {
      const ready = () => { clearTimeout(timer); synth.removeEventListener?.('voiceschanged', ready); resolve(); };
      const timer = setTimeout(ready, 1500);
      synth.addEventListener?.('voiceschanged', ready, { once: true });
    });
    if (!isCurrent()) return;
    const utterance = new Utterance(text);
    utterance.lang = speechLocale(text);
    utterance.rate = 1.05;
    const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith(utterance.lang.slice(0, 2)));
    if (!voice) { fail(utterance.lang.startsWith('ar') ? 'noArabicVoice' : 'unavailable'); return; }
    utterance.voice = voice;
    utterance.onstart = () => { if (isCurrent()) onStatus('playing'); };
    utterance.onend = () => { if (ended) return; if (isCurrent()) onStatus('finished'); finish(); };
    utterance.onerror = (event) => {
      if (['canceled', 'interrupted'].includes(event.error)) finish();
      else fail(event.error === 'not-allowed' ? 'blocked' : 'failed');
    };
    // Chrome can retain a paused synthesis queue from an earlier interrupted reply.
    synth.resume?.();
    synth.speak(utterance);
  } catch { fail('failed'); }
}
