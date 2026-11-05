// SpeechRecognition-shaped adapter: existing queue, Stop, echo suppression, and
// microphone-window ownership stay in the same controller for both engines.
export function createAudioRecognition({ transcribe, checkConfiguration = () => {}, endSilenceMs = 1200, mediaDevices = navigator.mediaDevices,
  Recorder = globalThis.MediaRecorder, Context = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  let epoch = 0, stream, recorder, context, interval, deadline, request;
  const api = { continuous: false, interimResults: false, onresult: null, onerror: null, onend: null, onstart: null, onprocessing: null };
  const cleanup = () => {
    clearInterval(interval); clearTimeout(deadline);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (context) { void context.close().catch(() => {}); context = null; }
  };
  api.start = () => {
    const mine = ++epoch;
    request = new AbortController();
    if (!Recorder || !mediaDevices?.getUserMedia) throw new Error('Audio recording is unavailable.');
    void (async () => {
      try {
        try { checkConfiguration(); } catch (error) {
          api.onerror?.({ error: 'transcription-failed', message: error.message }); api.onend?.(); return;
        }
        const captured = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (mine !== epoch) { captured.getTracks().forEach((track) => track.stop()); return; }
        stream = captured;
        const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => Recorder.isTypeSupported(type));
        recorder = new Recorder(stream, mimeType ? { mimeType } : {});
        const parts = [];
        let heardSpeech = !Context;
        recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
        recorder.onstop = async () => {
          if (mine !== epoch) return;
          cleanup();
          if (!heardSpeech) { api.onend?.(); return; }
          api.onprocessing?.();
          try {
            const text = await transcribe(new Blob(parts, { type: recorder.mimeType || mimeType || 'audio/webm' }), request.signal);
            if (mine !== epoch) return;
            if (text) {
              const result = [{ transcript: text }]; result.isFinal = true;
              api.onresult?.({ resultIndex: 0, results: [result] });
            }
          } catch (error) {
            if (mine === epoch && error.name !== 'AbortError') api.onerror?.({ error: 'transcription-failed', message: error.message });
          } finally { if (mine === epoch) api.onend?.(); }
        };
        recorder.start();
        api.onstart?.();
        deadline = setTimeout(() => api.stop(), 30000);
        if (Context) {
          context = new Context();
          const analyser = context.createAnalyser(); analyser.fftSize = 2048;
          context.createMediaStreamSource(stream).connect(analyser);
          void context.resume();
          const samples = new Float32Array(analyser.fftSize);
          let lastVoice = Date.now(), heard = false;
          interval = setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
            if (rms > 0.012) { lastVoice = Date.now(); heard = true; heardSpeech = true; }
            if (heard && Date.now() - lastVoice > Math.max(600, Math.min(2000, Number(endSilenceMs) || 1200))) api.stop();
          }, 100);
        }
      } catch (error) {
        if (mine !== epoch) return;
        cleanup();
        if (mine === epoch) { api.onerror?.({ error: error.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture', message: error.message }); api.onend?.(); }
      }
    })();
  };
  api.stop = () => { if (recorder?.state === 'recording') recorder.stop(); };
  api.abort = () => { epoch += 1; request?.abort(); if (recorder?.state === 'recording') recorder.stop(); cleanup(); };
  return api;
}
