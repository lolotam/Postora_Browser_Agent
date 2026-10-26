// The voice screen's controller.
//
// It owns the one recognizer that may be running, keeps the commands in one
// line so two never overlap, and makes sure the voice output never becomes a
// command of its own. The panel hands it the parts that touch the browser (a
// recognizer, the microphone window) and the parts that touch the screen
// (state, transcript, log); everything that can be checked without Chrome
// lives here.
//
// Every change of the capture retires the callbacks of the old one: a
// recognizer that was stopped, a microphone window that was closed and a
// capture that was paused for the voice output all ignore what they hear
// afterwards.

/** How many times the recognizer may be started again in a row. */
const RESTART_LIMIT = 5;
/** The window those restarts have to happen in. */
const RESTART_WINDOW_MS = 15000;
/**
 * How long the microphone stays deaf after the voice output. The recognizer is
 * stopped while the reply plays, so this only has to cover the results that
 * were already on their way when it was stopped.
 */
const SPEECH_GUARD_MS = 800;
/** How long the voice output may take before the microphone is given back. */
const SPEECH_TIMEOUT_MS = 2000;
/** The speaking rate used to guess how long the voice output lasts. */
const WORDS_PER_MINUTE = 150;

export function createVoiceController({
  createRecognition,
  canListenInPanel,
  openMicWindow,
  closeMicWindow,
  pauseCapture = () => {},
  resumeCapture = () => {},
  say,
  stopSpeech,
  speaking,
  onState,
  onTranscript,
  onCommand,
  onLog,
  loadPrefs,
  savePrefs,
  onFailure = () => {},
  onMicBlocked = () => {},
  cancelledText = () => 'Cancelled',
  now = () => Date.now(),
}) {
  let prefs = { handsFree: true, speakReplies: false };
  // The saved preferences are read as soon as the controller exists, so a
  // switch that is changed before the screen opens is saved with the other
  // one as it was, not as it defaults.
  const ready = Promise.resolve(loadPrefs())
    .then((loaded) => { prefs = { ...prefs, ...loaded }; return prefs; })
    .catch(() => prefs);

  let recognition = null;
  let capture = null; // 'panel' | 'window' | null
  // False while the voice output holds the microphone: nothing that is heard
  // then belongs to the user.
  let captureActive = true;
  // Every change of the capture retires the callbacks of the old one.
  let generation = 0;
  let screenToken = 0;
  let speechToken = 0;
  let restarts = 0;
  let restartWindow = 0;
  let suppressUntil = 0;
  let busy = false;
  let queue = [];
  let running = null;
  let screenOpen = false;
  let speechTimer = null;

  const state = () => (busy ? 'thinking' : speaking() ? 'speaking' : listening() ? 'listening' : 'idle');
  const setState = () => onState(state());
  const suppressed = () => now() < suppressUntil || speaking();
  const listening = () => Boolean(capture) && captureActive;

  // ---------- the recognizer ----------

  function makeRecognizer(myGeneration) {
    const rec = createRecognition();
    if (!rec) return null;
    rec.interimResults = true;
    rec.continuous = prefs.handsFree;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      if (myGeneration !== generation) return; // a retired recognizer
      onResult(event);
    };
    rec.onerror = (event) => {
      if (myGeneration !== generation) return;
      onError(event?.error);
    };
    rec.onend = () => {
      if (myGeneration !== generation) return;
      if (recognition === rec) recognition = null;
      onEnd();
    };
    return rec;
  }

  function startRecognizer() {
    const myGeneration = ++generation;
    const rec = makeRecognizer(myGeneration);
    if (!rec) {
      onFailure('not-supported');
      return false;
    }
    recognition = rec;
    try {
      rec.start();
    } catch {
      recognition = null;
      generation += 1;
      onFailure('start-failed');
      return false;
    }
    return true;
  }

  function stopRecognizer() {
    generation += 1; // the callbacks of this recognizer are retired
    const rec = recognition;
    recognition = null;
    if (!rec) return;
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  }

  function onResult(event) {
    let interim = '';
    const finals = [];
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = (result[0]?.transcript ?? '').trim();
      if (result.isFinal) {
        if (text) finals.push(text);
        if (!prefs.handsFree) break;
      } else {
        interim += `${text} `;
      }
    }
    if (interim.trim() && !suppressed()) onTranscript(interim.trim(), { final: false });
    for (const text of finals) {
      if (suppressed()) return;
      onFinal(text);
      // One utterance is one command: the microphone is off after it.
      if (!prefs.handsFree) break;
    }
  }

  function onFinal(text) {
    if (suppressed()) return; // the voice output's own words, heard late
    onTranscript(text, { final: true });
    if (!prefs.handsFree) stopListening(); // one utterance, then the microphone is off
    enqueue(text);
  }

  function onError(code) {
    if (!code || code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      if (capture === 'window') {
        stopListening();
        onFailure(code);
        return;
      }
      // The side panel cannot ask for the microphone; a real window can. The
      // user still wants to listen, so the capture continues in that window.
      stopRecognizer();
      capture = null;
      onMicBlocked();
      if (screenOpen) {
        capture = 'window';
        captureActive = true;
        Promise.resolve(openMicWindow({ continuous: prefs.handsFree })).catch(() => {
          // The window did not open: the panel is not listening any more.
          capture = null;
          generation += 1;
          setState();
          onFailure('mic-failed');
        });
      }
      setState();
      onFailure(code);
      return;
    }
    // A microphone that is not there, or a speech service that is not
    // reachable, is not something the screen can keep claiming to listen to.
    stopListening();
    onFailure(code);
  }

  function onEnd() {
    if (!listening()) {
      setState();
      return;
    }
    if (!prefs.handsFree) {
      capture = null;
      generation += 1;
      setState();
      return;
    }
    // Chrome ends the recognizer after a pause. It is started again, but not
    // for ever: a recognizer that keeps failing is left alone.
    const at = now();
    if (at - restartWindow > RESTART_WINDOW_MS) {
      restartWindow = at;
      restarts = 0;
    }
    restarts += 1;
    if (restarts > RESTART_LIMIT) {
      capture = null;
      generation += 1;
      setState();
      onFailure('restart-limit');
      return;
    }
    if (!startRecognizer()) {
      capture = null;
      setState();
    }
  }

  // ---------- the commands ----------

  function enqueue(text) {
    const command = String(text ?? '').trim();
    if (!command || !screenOpen) return;
    queue.push({ command, entry: onLog(command) });
    pump();
  }

  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const abort = new AbortController();
    running = abort;
    const { command, entry } = queue.shift();
    setState();
    try {
      await onCommand(command, { signal: abort.signal, entry });
    } catch (err) {
      entry?.setErr?.(String(err?.message ?? err));
    } finally {
      busy = false;
      running = null;
      setState();
      if (queue.length) pump();
    }
  }

  // ---------- the screen ----------

  async function open() {
    const token = ++screenToken;
    screenOpen = true;
    await ready;
    // The screen was closed while the preferences were loading: the capture
    // must not come back to life.
    if (token !== screenToken || !screenOpen) return;
    setState();
    if (prefs.handsFree) startListening();
  }

  function close() {
    screenToken += 1;
    screenOpen = false;
    stopListening();
    dropQueued();
    running?.abort();
    clearTimeout(speechTimer);
    speechTimer = null;
    speechToken += 1;
    captureActive = true;
    stopSpeech();
    suppressUntil = 0;
    setState();
  }

  /** The commands that were waiting never ran: the log says they were cancelled. */
  function dropQueued() {
    for (const item of queue.splice(0)) item.entry?.setErr?.(cancelledText());
  }

  function startListening() {
    if (!screenOpen || capture) return;
    captureActive = true;
    restarts = 0;
    restartWindow = now();
    if (canListenInPanel()) {
      capture = 'panel';
      if (!startRecognizer()) {
        capture = null;
        generation += 1;
      }
    } else {
      capture = 'window';
      Promise.resolve(openMicWindow({ continuous: prefs.handsFree })).catch(() => {
        // The window did not open: the panel is not listening, and it must not
        // claim that it is.
        capture = null;
        generation += 1;
        setState();
        onFailure('mic-failed');
      });
    }
    setState();
  }

  function stopListening() {
    if (!capture && !recognition) {
      setState();
      return;
    }
    capture = null;
    captureActive = true;
    generation += 1;
    stopRecognizer();
    closeMicWindow();
    setState();
  }

  function toggleListening() {
    if (capture) stopListening();
    else startListening();
  }

  async function setHandsFree(on) {
    await ready;
    prefs = { ...prefs, handsFree: Boolean(on) };
    await savePrefs(prefs);
    if (!prefs.handsFree) stopListening();
    else if (screenOpen) startListening();
  }

  async function setSpeakReplies(on) {
    await ready;
    prefs = { ...prefs, speakReplies: Boolean(on) };
    await savePrefs(prefs);
  }

  // ---------- the voice output ----------

  function speak(text) {
    if (!prefs.speakReplies || !text) return;
    // Nothing is spoken after the screen is closed: the reply belongs to the
    // screen that is showing it.
    if (!screenOpen) return;
    // Retire the previous completion before cancel() can invoke it synchronously.
    const token = ++speechToken;
    clearTimeout(speechTimer);
    stopSpeech();
    // The output is not a command: the microphone stops while it plays, and a
    // result that arrives late is dropped.
    suppressUntil = now() + SPEECH_GUARD_MS;
    // A second reply inherits the capture paused by the first one.
    const wasListening = Boolean(capture);
    captureActive = false;
    if (wasListening) {
      if (capture === 'panel') stopRecognizer();
      pauseCapture(); // the microphone window stops as well
    }
    let ended = false;
    const resume = () => {
      // An older utterance must not bring the microphone back under a newer
      // one, and nothing may come back after the screen was closed.
      if (ended || token !== speechToken || !screenOpen) return;
      ended = true;
      clearTimeout(speechTimer);
      speechTimer = null;
      captureActive = true;
      suppressUntil = Math.max(suppressUntil, now() + SPEECH_GUARD_MS);
      if (listening() && capture === 'panel' && !startRecognizer()) capture = null;
      if (wasListening && capture === 'window') resumeCapture();
      setState();
    };
    // A speech engine that never says it is done must not keep the microphone
    // off for ever.
    speechTimer = setTimeout(resume, estimateMs(text) + SPEECH_TIMEOUT_MS);
    say(text, { onEnd: resume });
  }

  return {
    get prefs() { return { ...prefs }; },
    get busy() { return busy; },
    get listening() { return listening(); },
    get open() { return screenOpen; },
    open,
    close,
    setHandsFree,
    setSpeakReplies,
    toggleListening,
    startListening,
    stopListening,
    handlePartial(text) {
      if (!screenOpen || !captureActive || capture !== 'window') return;
      if (suppressed()) return;
      onTranscript(String(text ?? ''), { final: false });
    },
    handleFinal(text) {
      if (!screenOpen || !captureActive || capture !== 'window') return;
      onFinal(String(text ?? ''));
    },
    handleError(code) {
      if (!screenOpen || !captureActive || capture !== 'window') return;
      onError(code);
    },
    /** The microphone window ran out: the capture is over. */
    handleCaptureEnded() {
      if (!screenOpen || capture !== 'window') return;
      capture = null;
      generation += 1;
      closeMicWindow();
      setState();
    },
    /** A command that was typed instead of spoken. It runs like a spoken one. */
    submit(text) {
      if (!screenOpen) return;
      const command = String(text ?? '').trim();
      if (!command) return;
      onTranscript(command, { final: true });
      enqueue(command);
    },
    speak,
    cancelCommand() {
      dropQueued();
      running?.abort();
    },
  };
}

/** How long the voice output lasts, so the microphone is given back in time. */
function estimateMs(text) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean).length;
  return Math.ceil((words / WORDS_PER_MINUTE) * 60 * 1000);
}
