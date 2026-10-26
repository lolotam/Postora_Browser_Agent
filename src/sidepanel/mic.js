// Chrome cannot ask for the microphone from the side panel: the prompt is
// dismissed and recognition fails. This page is a real window, so the prompt
// can show, and the words go back to the panel as a task.

import { heardText, MIC_PANEL, MIC_WINDOW, speechLang, voiceErrorKey } from './voice.js';
import { setLanguage, t } from './i18n.js';

const params = new URLSearchParams(location.search);
const language = params.get('lang') === 'ar' ? 'ar' : 'en';
const epoch = Number(params.get('epoch')) || 0;
setLanguage(language);

const button = document.getElementById('allow');
const live = document.getElementById('live');

let recognition = null;
let text = '';
let started = false;
let finished = false;

function post(kind, extra = {}) {
  chrome.runtime.sendMessage({ source: MIC_WINDOW, kind, epoch, ...extra }).catch(() => {});
}

function finish(said, send) {
  if (finished) return;
  finished = true;
  if (send) post('end', { text: said.trim() });
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
      post('moved');
      window.close();
      return;
    }
  }
  const key = code === 'not-allowed' || code === 'service-not-allowed' ? 'mic.denied' : voiceErrorKey(code);
  if (key) {
    live.textContent = t(key);
    post('error', { code });
  }
  button.hidden = false;
  button.disabled = false;
  button.textContent = t('mic.allow');
}

function begin() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    live.textContent = t('composer.micMissing');
    post('error', { code: 'not-supported' });
    button.disabled = false;
    return;
  }
  const rec = new Ctor();
  recognition = rec;
  text = '';
  started = false;
  finished = false;
  rec.lang = speechLang(language);
  rec.interimResults = true;
  rec.continuous = false;
  rec.onstart = () => {
    started = true;
    button.textContent = t('composer.stopListen');
    live.textContent = t('composer.listening');
    post('partial', { text: '' });
  };
  rec.onresult = (event) => {
    text = heardText(event.results);
    live.textContent = text || t('composer.listening');
    post('partial', { text });
  };
  rec.onerror = (event) => {
    // A real failure also ends the session. Leave it unstarted so onend does not
    // send an empty task over the error the panel is already showing.
    if (voiceErrorKey(event.error)) started = false;
    onRecognizeError(event.error);
  };
  rec.onend = () => {
    recognition = null;
    if (started) finish(text, true);
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
  begin();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source !== MIC_PANEL) return;
  if (message.kind === 'cancel') {
    started = false;
    finished = true;
    try { recognition?.abort(); } catch { /* already stopped */ }
    window.close();
    return;
  }
  if (message.kind === 'stop') {
    try { recognition?.stop(); } catch { finish(text, true); }
  }
});

window.addEventListener('pagehide', () => {
  if (started) finish(text, true);
});
