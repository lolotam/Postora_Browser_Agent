// Chrome cannot ask for the microphone from the side panel: the prompt is
// dismissed and recognition fails. This page is a real window, so the prompt
// can show, and the words go back to the panel as a task.

import { heardText, MIC_PANEL, MIC_WINDOW, speechLang, voiceErrorKey } from './voice.js';
import { setLanguage, t } from './i18n.js';

const params = new URLSearchParams(location.search);
const language = params.get('lang') === 'ar' ? 'ar' : 'en';
const epoch = Number(params.get('epoch')) || 0;
// The voice screen listens on: every finished phrase is sent on its own and
// the window stays open until the panel closes it.
const continuous = params.get('continuous') === '1';
const RESTART_LIMIT = 5;
/** The window those restarts have to happen in. */
const RESTART_WINDOW_MS = 15000;
setLanguage(language);

const button = document.getElementById('allow');
const live = document.getElementById('live');

let recognition = null;
let text = '';
let started = false;
let finished = false;
let postedUpTo = 0;
let lastFinal = '';
let restarts = 0;
let restartWindow = 0;
// The panel is speaking: the microphone stops until it says resume.
let paused = false;
let moving = false;

function post(kind, extra = {}) {
  return chrome.runtime.sendMessage({ source: MIC_WINDOW, kind, epoch, ...extra }).catch(() => {});
}

function finish(said, send) {
  if (finished) return;
  finished = true;
  // In continuous mode every finished phrase was sent on its own; the window
  // says that it is done and closes.
  if (continuous) post('ended');
  else if (send) post('end', { text: said.trim() });
  setTimeout(() => window.close(), 500);
}

async function micState() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

async function onRecognizeError(code) {
  // A popup that cannot show the prompt leaves the permission on "prompt".
  // A normal tab can show it. A real denial stays "denied" and is explained here.
  if (code === 'not-allowed' && !params.has('tab')) {
    const state = await micState();
    if (finished) return;
    if (state !== 'denied') {
      const next = new URL(location.href);
      next.searchParams.set('tab', '1');
      await chrome.tabs.create({ url: next.href });
      await post('moved');
      window.close();
      return;
    }
  }
  moving = false;
  const key = code === 'not-allowed' || code === 'service-not-allowed' ? 'mic.denied' : voiceErrorKey(code);
  if (key) {
    live.textContent = t(key);
    post('error', { code });
  }
  button.hidden = false;
  button.disabled = false;
  button.textContent = t('mic.allow');
}

function start() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    live.textContent = t('composer.micMissing');
    post('error', { code: 'not-supported' });
    button.disabled = false;
    return;
  }
  const rec = new Ctor();
  recognition = rec;
  // A new recognizer starts with a new list of results.
  text = '';
  postedUpTo = 0;
  lastFinal = '';
  rec.lang = speechLang(language);
  rec.interimResults = true;
  rec.continuous = continuous;
  rec.onstart = () => {
    if (finished || paused || recognition !== rec) return;
    started = true;
    button.textContent = t('composer.stopListen');
    live.textContent = t('composer.listening');
    post('partial', { text: '' });
  };
  rec.onresult = (event) => {
    if (finished || paused || recognition !== rec) return;
    text = heardText(event.results);
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result.isFinal) {
        interim += `${(result[0]?.transcript ?? '').trim()} `;
        continue;
      }
      if (i < postedUpTo) continue; // this result was already sent
      postedUpTo = i + 1;
      const said = (result[0]?.transcript ?? '').trim();
      if (!said) continue;
      lastFinal = said;
      // The microphone works: a healthy result is not a broken capture, so the
      // count of restarts starts again.
      restarts = 0;
      if (continuous) post('final', { text: said });
    }
    const shown = continuous ? `${lastFinal} ${interim}`.trim() : text;
    live.textContent = shown || t('composer.listening');
    post('partial', { text: shown });
  };
  rec.onerror = (event) => {
    if (finished || paused || recognition !== rec) return;
    // A real failure also ends the session. Leave it unstarted so onend does not
    // send an empty task over the error the panel is already showing.
    if (voiceErrorKey(event.error)) started = false;
    if (event.error === 'not-allowed' && !params.has('tab')) moving = true;
    onRecognizeError(event.error);
  };
  rec.onend = () => {
    if (recognition !== rec) return;
    recognition = null;
    if (finished || moving) return;
    if (paused) return; // the panel is speaking; it will say resume
    if (continuous) {
      // Chrome ends the recognizer after a pause: start it again, but not for
      // ever, so a broken microphone cannot loop.
      const at = Date.now();
      if (at - restartWindow > RESTART_WINDOW_MS) {
        restartWindow = at;
        restarts = 0;
      }
      if (started && restarts < RESTART_LIMIT) {
        restarts += 1;
        start();
        return;
      }
      if (started) {
        // The microphone kept ending without hearing anything: the panel is
        // told why the listening stopped.
        live.textContent = t('voice.micRestarts');
        post('error', { code: 'restart-limit' });
      }
      finish(text, false);
      return;
    }
    if (started) finish(text, true);
    else post('ended');
  };
  try {
    rec.start();
  } catch {
    recognition = null;
    button.disabled = false;
    live.textContent = t('composer.micFailed');
    post('error', { code: 'start-failed' });
  }
}

button.addEventListener('click', () => {
  if (recognition) {
    try { recognition.stop(); } catch { finish(text, true); }
    return;
  }
  button.disabled = true;
  start();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source !== MIC_PANEL) return;
  // Only the panel that opened this window may stop it.
  if (Number(message.epoch) !== epoch) return;
  if (message.kind === 'cancel') {
    started = false;
    finished = true;
    try { recognition?.abort(); } catch { /* already stopped */ }
    window.close();
    return;
  }
  if (message.kind === 'stop') {
    try { recognition?.stop(); } catch { finish(text, true); }
    return;
  }
  if (message.kind === 'pause') {
    // The voice output is playing: the microphone stops, so it is not heard.
    paused = true;
    try { recognition?.abort(); } catch { /* already stopped */ }
    return;
  }
  if (message.kind === 'resume') {
    paused = false;
    if (!finished && !recognition) start();
  }
});

window.addEventListener('pagehide', () => {
  if (finished || moving) return;
  finish(text, true);
});
