import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The synthetic speech path of the browser.
 *
 * The microphone and the native host are the only parts that are not real:
 * a worklet that posts the audio the test dictates, and a native port that
 * answers with the words the test dictates. Everything between them - the
 * recognition adapter, the voice controller, the panel and the model - is the
 * code that ships.
 */
function installSpeechFixture() {
  const worklet = { port: null };
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {}, start() {}, close() {} };
      this.connect = () => {};
      this.disconnect = () => {};
      worklet.port = this.port;
      window.__pcmWorklet = this;
    }
  }
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = { kind: 'destination' };
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  window.AudioWorkletNode = FakeAudioWorkletNode;
  window.AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  // The native speech stream: the test decides what the model says.
  chrome.runtime.connectNative = (name) => {
    const listeners = { message: [], disconnect: [] };
    const port = {
      name,
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
      postMessage(message) {
        window.__nativeLog?.push(message);
        const reply = (value) => { for (const fn of listeners.message) fn(value); };
        const said = String(window.__spokenText ?? '');
        if (message.type === 'speech-stream-open') reply({ type: 'speech-stream-opened', protocol: 1, captureId: message.captureId, phraseId: 0 });
        else if (message.type === 'speech-stream-feed') reply({ type: 'speech-stream-partial', captureId: message.captureId, phraseId: message.phraseId, seq: message.seq, committed: said, tentative: '' });
        else if (message.type === 'speech-stream-finalize') reply({ type: 'speech-stream-final', captureId: message.captureId, phraseId: message.phraseId, text: said });
        else if (message.type === 'speech-stream-reset') reply({ type: 'speech-stream-reset-ack', captureId: message.captureId, phraseId: (message.phraseId ?? 0) + 1 });
      },
      disconnect() { for (const fn of listeners.disconnect) fn(); },
    };
    window.__nativePort = port;
    return port;
  };
  window.__nativeLog = [];
  window.__pushPcm = (rms = 0.2) => {
    if (!worklet.port?.onmessage) return false;
    worklet.port.onmessage({ data: { type: 'pcm', samples: new Float32Array(512).fill(rms), rms } });
    return true;
  };
}

export async function runNemotronVoiceScenario(context, extensionId) {
  const commands = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, type: req.headers['content-type'] || '' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw || '{}');
      const said = (body.messages || []).filter((message) => message.role === 'user').map((message) => String(message.content)).join(' | ');
      commands.push(said);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `heard: ${said}` } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Nemotron voice fixture</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (error) => pageErrors.push(error.message));
  await panel.addInitScript(installSpeechFixture);
  await panel.addInitScript(() => {
    // The side panel listens in the panel only when this extension's own
    // microphone permission was granted from a real window.
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => ({ state: 'granted', onchange: null }) },
    });
  });
  const failures = [];
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: {
        transcription: { mode: 'auto', provider: 'local-nemotron', endSilenceMs: 600 },
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'fixture-model' },
        fast: { enabled: false },
        voiceEngine: 'postora',
        voiceHandsfree: true,
        uiLanguage: 'en',
      },
    }), origin);
    await panel.reload();
    await panel.waitForFunction(() => document.querySelector('#sessionTitle')?.textContent.trim());
    await panel.click('#voiceToggle');
    await panel.waitForSelector('#voiceView:not([hidden])');
    await panel.waitForFunction(() => Boolean(window.__pcmWorklet), { timeout: 15000 });
    console.log('Nemotron voice: the live recognizer is open');

    // The first phrase: the words are visible before the phrase is finished.
    await panel.evaluate(() => { window.__spokenText = 'افتح يوتيوب'; });
    await panel.evaluate(() => window.__pushPcm(0.2));
    await panel.waitForFunction(() => document.querySelector('#voiceLive')?.textContent.includes('افتح'), { timeout: 15000 });
    console.log('Nemotron voice: the Arabic words are visible while the phrase is still open');

    // The silence ends the phrase and the command is handed to the panel.
    await panel.evaluate(() => window.__pushPcm(0));
    await panel.waitForFunction(() => document.querySelectorAll('#voiceLog .voice-entry').length >= 1, { timeout: 20000 });
    let entries = await voiceEntries(panel);
    assert.match(entries.join(' | '), /افتح يوتيوب/, 'the first command carries the words that were spoken');

    // The second phrase: the result history keeps both, so the second command
    // is not dropped.
    await panel.evaluate(() => { window.__spokenText = 'open youtube'; });
    await panel.evaluate(() => window.__pushPcm(0.2));
    await panel.waitForFunction(() => document.querySelector('#voiceLive')?.textContent.includes('open'), { timeout: 15000 });
    await panel.evaluate(() => window.__pushPcm(0));
    await panel.waitForFunction(() => document.querySelectorAll('#voiceLog .voice-entry').length >= 2, { timeout: 20000 });
    entries = await voiceEntries(panel);
    assert.match(entries.join(' | '), /open youtube/, 'the second command carries the second phrase');
    assert.equal(entries.length, 2, 'every phrase runs exactly once');

    // Closing the voice screen ends the capture: no further command.
    await panel.click('#voiceBackBtn');
    await panel.waitForSelector('#voiceView', { state: 'hidden' });
    await panel.evaluate(() => { window.__spokenText = 'third phrase'; });
    await panel.evaluate(() => window.__pushPcm(0.2));
    await panel.evaluate(() => window.__pushPcm(0));
    await panel.waitForTimeout(1500);
    assert.equal((await voiceEntries(panel)).length, 2, 'a stopped capture sends nothing');

    // The audio never left the computer: only the model request was made.
    const audioPosts = requests.filter((request) => /audio|transcri/i.test(request.url) || /audio|mpeg|wav/i.test(request.type));
    assert.deepEqual(audioPosts, [], 'no audio was sent anywhere');
    assert.deepEqual(requests.filter((request) => !['/v1/chat/completions', '/v1/models'].includes(request.url)), [], 'nothing but the model was asked');

    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    console.log(`\n== scenario: nemotron-voice ==\ncommands: ${commands.length}`);
    return failures;
  } catch (error) {
    const state = await panel.evaluate(() => ({
      live: document.querySelector('#voiceLive')?.textContent,
      entries: [...document.querySelectorAll('#voiceLog .voice-entry')].map((node) => node.textContent),
    })).catch(() => null);
    return [`Nemotron voice: ${error.stack ?? error}; panel ${JSON.stringify(state)}; page errors ${JSON.stringify(pageErrors)}`];
  } finally {
    await panel.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

/** The commands the panel heard, one entry per phrase. */
async function voiceEntries(panel) {
  return panel.evaluate(() => [...document.querySelectorAll('#voiceLog .voice-entry')].map((node) => node.textContent));
}
