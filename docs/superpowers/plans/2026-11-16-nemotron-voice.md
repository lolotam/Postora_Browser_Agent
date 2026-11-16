# Nemotron Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Owner override: implement inline with Kimi 3.1 Pro; do not delegate. This planning session implements nothing and makes no commits. Commit steps below belong to subsequent implementation.

**Goal:** Add genuine private Nemotron live transcription, preserve selectable Whisper, and release queued Postora voice commands only after worker cleanup.

**Architecture:** Preserve the phrase recorder and one-shot native API. Add a dedicated PCM capture adapter, persistent native stream protocol and isolated model installer; repair the panel promise boundary independently.

**Tech Stack:** JavaScript ES modules, Chrome AudioWorklet/native messaging, Node >=22, transcribe-cpp 0.4.2, Windows x64 CPU/Vulkan, node:test, playwright-core 1.56.1.

---

## Review and execution gates

One specification review completed; architecture feasible. No approved migration decision was changed. The spec carries exact model revision/length/SHA-256 obtained from upstream metadata without downloading weights. Runtime integration must first inspect shipped v0.4.2 declarations for Nemotron language/stream options and cancellation/disposal signatures; do not infer them from the main-branch C++ CLI. Windows requires VC++ >=14.40 in addition to Node >=22. Missing prerequisites block the real smoke/release, not the independently testable race fix or Whisper. Never substitute another binding/model/version silently.

Work from `F:\Dev\Projects\Postora_Browser_Agent`. Existing untracked `handoff-postora-pr45.md` is unrelated: never stage it. Use targeted git add commands. Do not execute the model download until separately approved.

## File responsibilities

Existing files: `src/sidepanel/panel.js` owns worker completion; `src/voice/voice-controller.js` owns the serial command queue; `src/sidepanel/mic.js` consumes cumulative recognition results; `src/voice/audio-recognition.js` remains the MediaRecorder adapter; `src/voice/local-transcription.js` remains Whisper WAV conversion; `src/voice/transcription.js` validates and routes providers; `src/lib/settings.js` normalizes persisted settings; `src/sidepanel/transcription-form.js` owns model controls; `src/sidepanel/index.html` and `src/sidepanel/messages.js` own labels; `src/native/client.js` retains one-shot requests; `native/host.mjs` dispatches framed native traffic; `native/speech.mjs` retains Whisper and verified installer helpers; `native/install.mjs` and `scripts/package-private.mjs` deploy the runtime closure; `scripts/package.mjs` retains store stripping.

New modules: `src/voice/local-models.js` (pure provider normalization), `src/voice/pcm-resampler.js` (stateful PCM conversion), `src/voice/pcm-worklet.js` (capture only), `src/voice/nemotron-recognition.js` (recognizer state machine), `src/voice/recognition-factory.js` (shared panel/mic routing), `src/native/speech-stream.js` (port client), `native/nemotron.mjs` (installer and binding wrapper), `native/speech-stream.mjs` (protocol validation/state machine), `native/runtime-files.mjs` (audited package file enumeration). Add `docs/THIRD-PARTY-SPEECH.md`; update `docs/PRIVATE-ACCESS.md`.

## Task 1: Independently fix voice cleanup ordering

Files: modify `src/sidepanel/panel.js`, `test/voice-controller.test.js`, `test/e2e/run-e2e.mjs`; create `test/e2e/voice-cleanup.mjs`.

- [ ] Add a deferred-command unit using the existing setup/FakeRecognition harness: enqueue two phrases; completing a report must not resolve the supplied onCommand promise; only release after simulated idle. Assert command count stays one before release and becomes two afterward.
- [ ] Add browser scenario `voice-cleanup`: choose voiceEngine `postora`, disable spoken replies, enqueue two typed voice commands while first is running. Instrument the worker event transport in the test to hold its first idle event after final; assert one dispatch while held, then release idle and assert second dispatch and two successful log entries. Exercise final(false), error, stopped and idle without terminal. Preserve pending-question and replay regressions.
- [ ] Run `node --test test/voice-controller.test.js` and `$env:E2E_FILTER='voice-cleanup'; npm run e2e; Remove-Item Env:E2E_FILTER`. Expected new browser regression fails before repair; existing queue units pass.
- [ ] Add `terminal: false` to the task created by runVoiceCommand. Replace final/error/stopped calls to finishVoiceTask with an ownership-checked terminal assignment. Use the existing voiceEntryFor guard; do not mark tasks from replayed events.

```js
// In matching live terminal handlers, after rendering their existing outcome:
if (voiceEntryFor(event)) voiceTask.terminal = true;
// In status, after setRunning(event.running):
if (!event.running) {
  const entry = voiceEntryFor(event);
  if (entry) {
    if (!voiceTask.terminal) entry.setErr(t('voice.failed'));
    finishVoiceTask();
  }
}
```

- [ ] Retain settleVoiceCommand for pending questions. Retain immediate finish for failed pre-dispatch sends, and cancellation retirement for close/session change. Do not change fast_only routing or release from an arbitrary delay.
- [ ] Repeat the two commands. Expected all pass, second starts strictly after idle, no “This session is already working on something”.
- [ ] Commit: `git add src/sidepanel/panel.js test/voice-controller.test.js test/e2e/run-e2e.mjs test/e2e/voice-cleanup.mjs` then `git commit -m "fix: wait for worker idle before next voice command"`.

## Task 2: Normalize Local models without changing cloud defaults

Files: create `src/voice/local-models.js`, `test/local-models.test.js`; modify `src/lib/settings.js`, `src/voice/transcription.js`, `src/voice/local-transcription.js`, `test/transcription.test.js`.

- [ ] Write these pure migration assertions with node:test and node:assert/strict:

```js
assert.equal(normalizeLocal({provider:'local', model:'base'}).provider, 'local-nemotron');
assert.equal(normalizeLocal({provider:'local-whisper', model:'base'}).provider, 'local-whisper');
assert.deepEqual(normalizeLocal({provider:'groq', apiKey:'fixture'}), {provider:'groq', apiKey:'fixture'});
```

- [ ] Run `node --test test/local-models.test.js test/transcription.test.js`; expect missing normalizeLocal module/export failure.
- [ ] Implement the pure normalizer and call it when building merged transcription settings, before service validation:

```js
export const LOCAL_MODELS = Object.freeze({
  'local-nemotron': {label:'Nemotron Streaming 3.5', endpoint:'', model:'nemotron-3.5-q8_0'},
  'local-whisper': {label:'Whisper Base', endpoint:'', model:'base'},
});
export function normalizeLocal(config) {
  if (config.provider !== 'local') return {...config};
  return {...config, provider:'local-nemotron', ...LOCAL_MODELS['local-nemotron']};
}
export const isLocalProvider = provider => Object.hasOwn(LOCAL_MODELS, provider);
```

- [ ] Register both providers in TRANSCRIPTION_SERVICES; local validation returns endpoint:null. Route only local-whisper through transcribeLocal and add `modelId:'local-whisper'` to its speech-transcribe message. Reject blob transcription for local-nemotron with “Nemotron requires live microphone capture.” The recognition factory in Task 7 will select that path before recording. Preserve legacy native speech requests without modelId as Whisper for compatibility.
- [ ] Test legacy base migration, explicit Whisper, browser mode, custom endpoint, stored credentials and services map retention. Assert no fetch/native download during migration and no network fetch for either Local validation path.
- [ ] Run `node --test test/local-models.test.js test/transcription.test.js test/local-speech.test.js`; expect pass.
- [ ] Commit targeted files: `git add src/voice/local-models.js src/lib/settings.js src/voice/transcription.js src/voice/local-transcription.js test/local-models.test.js test/transcription.test.js`; `git commit -m "feat: distinguish Nemotron and Whisper local selections"`.

## Task 3: Pin runtime, installer and private packaging

Files: modify `package.json`, `package-lock.json`, `native/speech.mjs`, `native/install.mjs`, `scripts/package-private.mjs`, `test/local-speech.test.js`, `test/package.test.js`, `docs/PRIVATE-ACCESS.md`; create `native/nemotron.mjs`, `native/runtime-files.mjs`, `docs/THIRD-PARTY-SPEECH.md`, `test/nemotron-install.test.js`.

- [ ] Inspect registry metadata: `npm view transcribe-cpp@0.4.2 engines optionalDependencies dist --json` and `npm view @transcribe-cpp/win32-x64-cpu-vulkan@0.4.2 dist --json`. Expected Node >=22 and matching pinned platform package. Install runtime dependency with `npm install --save-exact transcribe-cpp@0.4.2`. Record platform package exact version/integrity in lockfile; do not install weights.
- [ ] Read the installed package declarations and package.json exports. Confirm stream language:auto, supported Nemotron family options, feed cancellation and disposal signatures. Import package only within the Nemotron loader. Fail explicitly if pinned version cannot provide genuine streaming; record blocker rather than upgrading silently.
- [ ] Add installer tests using temporary fixture bytes, mocked fetch and injected model loader: independent Whisper/Nemotron status, digest/length rejection, cancel before publication, concurrent commit winner, failed repair preserving old directory, unknown modelId rejection. Existing downloadAsset and commitInstallation are the reusable primitives.
- [ ] Run `node --test test/nemotron-install.test.js test/local-speech.test.js`; expect new Nemotron API failures.
- [ ] Export the immutable model asset in native/nemotron.mjs:

```js
export const NEMOTRON_ASSET = Object.freeze({
  name: 'nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
  size: 751094240,
  sha256: 'b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c',
  url: 'https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/53ce288f69326b415aeef030cfcb02a08a8096dd/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
});
```

- [ ] Implement `nemotronOperation(message, options)` for speech-status/install only, with separate `Postora/speech/nemotron-3.5-q8_0-53ce288f` destination. Reuse downloadAsset into owned staging and commitInstallation after digest and load validation. Status includes modelId, installed, supported and protocol:1. Reject unsupported OS/architecture/Node before loading binding. Dispatch explicit local-nemotron from speechOperation via dynamic import; local-whisper and absent modelId preserve existing paths. Reject all other IDs.
- [ ] Define runtimeFiles(root) in native/runtime-files.mjs returning relative allowlisted files from the two pinned packages and their actual runtime dependencies, including package.json exports targets, addon, DLLs and licenses. Inspect package contents; reject symlinks/paths escaping root. Never copy arbitrary node_modules, dev dependencies or model weights. Use this same function for private ZIP and host installation. Include all new native modules beside host.mjs.
- [ ] Add packaging assertions that storeManifest omits nativeMessaging, store entries exclude native binaries, private entries contain required runtime files and license notice, and installed host resolves binding without repository node_modules. Validate VC++ >=14.40 in a separate child loading the binding; an incompatible runtime must give a setup instruction, never take down the main installer without explanation. Document the prerequisite; do not silently install a machine-wide redistributable.
- [ ] Run `node --test test/nemotron-install.test.js test/local-speech.test.js test/package.test.js`; expect pass. Run `npm run package` and `npm run package:private`; expect both ZIPs and private dependency closure only.
- [ ] Commit only listed task files with `git commit -m "feat: package pinned private Nemotron runtime and installer"` after targeted `git add`.

## Task 4: Persistent protocol and owned native streaming

Files: create `native/speech-stream.mjs`, `src/native/speech-stream.js`, `test/speech-stream.test.js`; modify `native/host.mjs`, `native/nemotron.mjs`, `test/native-terminal.test.js`.

- [ ] Write fixture tests injecting a fake binding with deferred feed promises. Assert no second feed until first resolves; text snapshots are copied; finalize follows last feed; reset retains model load count one; cancellation during feed suppresses partial/final and disposes only after settlement. Check thrown load/feed/finalize/reset errors close capture once.
- [ ] Add frame tests: fragmented headers/bodies, multiple frames per stdin chunk, malformed JSON/base64, nonfinite floats, 4097 samples, >512000 phrase samples, wrong owner/phrase/sequence, repeated open/finalize, feed during reset and port disconnect. Preserve one-shot native command/project tests.
- [ ] Run `node --test test/speech-stream.test.js test/native-terminal.test.js`; expect missing stream module failure.
- [ ] Implement createSpeechStream({loadModel, send}) returning async handle(message) and cancel(). State is opening/feeding/finalizing/awaiting-reset/closed. Open stores protocol:1, captureId and phraseId:0; sequence starts zero. Every feed must match the expected sequence, then increments it only on acceptance. Validate size before base64 decoding and copy decoded float samples into an owned Float32Array. Serial operations must not prevent cancellation setting closed immediately.

```js
// Within a serialized accepted feed operation; owned is never reused.
await stream.feed(owned);
if (closed) return;
const {committed, tentative} = stream.text;
send({type:'speech-stream-partial', captureId, phraseId, seq,
  committed:String(committed), tentative:String(tentative)});
// Finalization reads stream.snapshot.text after await stream.finalize().
// reset is allowed only after final and advances phraseId exactly once.
```

- [ ] Replace host's first-frame-only parser with an incremental framed parser. First message selects immutable one-shot or stream mode. Retain one-shot reply-once behavior and kill tree behavior. Stream mode uses a separate send function, serial bounded input and disconnect cancellation; reject commands/project requests on a stream port. Keep origin check before processing any frame. Bound stdout text and queued stdin bytes.
- [ ] Implement openSpeechStream({runtime, signal, captureId, onPartial, onFinal, onError}) in src/native/speech-stream.js. It exposes ready, feed(Float32Array), finalize(), reset(), cancel(); await matching ACK/partial before next feed; ignore retired capture/phrase replies and reject malformed current replies. A 10-second handshake deadline explains outdated host installation. Cancel removes listeners, disconnects and rejects pending promises. Keep nativeRequest unchanged.
- [ ] Run `node --test test/speech-stream.test.js test/native-terminal.test.js test/local-speech.test.js`; expect pass with mocked binding and no weights/network.
- [ ] Commit listed task files: `git commit -m "feat: add bounded persistent native speech protocol"` after targeted staging.

## Task 5: PCM worklet and recognition state machine

Files: create `src/voice/pcm-resampler.js`, `src/voice/pcm-worklet.js`, `src/voice/nemotron-recognition.js`, `test/pcm-resampler.test.js`, `test/nemotron-recognition.test.js`.

- [ ] Add PCM fixtures for 48 kHz, 44.1 kHz and 16 kHz: mono averaging, silence, impulse, clipped/nonfinite input, split render blocks matching a single continuous input, and attenuation above output Nyquist. Assert one second yields 16000 samples within filter startup convention, documented by the test.
- [ ] Run `node --test test/pcm-resampler.test.js`; expect missing resampler failure.
- [ ] Implement a stateful windowed-sinc resampler: 32 taps, cutoff `0.45 * min(1, 16000/inputRate)`, normalized coefficients for fractional input position, retained prior samples and monotonic next source position. Average channels first, clamp finite output to [-1,1]. Export createPcmResampler(inputRate) returning push(channels) and reset(); worklet imports it, chunks into <=4096 owned samples and transfers buffers. Never transfer its retained history buffer. Output audio must be silent to prevent feedback.
- [ ] Add adapter fake-media/context/worklet/port tests with injected clock. Deliver Arabic and English partials before finalize, then two finals with resultIndex 0 and 1. Assert hands-free loads once, silence finalizes once, empty silence does not command, overflow fails, 30-second phrase limit finalizes, close/pause/session retirement suppresses late events and tracks/context close exactly once.
- [ ] Run `node --test test/nemotron-recognition.test.js`; expect missing adapter failure.
- [ ] Implement createNemotronRecognition with injectable dependencies and the SpeechRecognition properties specified in the design. Open host before feeding; capture with echoCancellation/noiseSuppression, load worklet via chrome.runtime.getURL, then connect source/worklet/muted destination. Maintain one in-flight feed and <=32000 queued samples; overflow calls fail then cancel. RMS/activity timestamps drive configured silence. Freeze and drain current phrase at silence; bounded next-phrase queue waits for reset ACK.

```js
// Keep result history until this capture ends; mic.js uses postedUpTo.
const result = Object.assign([{transcript:text}], {isFinal});
results[phraseIndex] = result;
api.onresult?.({resultIndex:phraseIndex, results:results.slice()});
if (isFinal) phraseIndex += 1;
```

- [ ] Make stop and abort retire epoch before teardown and never finalize. Internal finishPhrase is the only finalization path. On asynchronous media permission completion, compare epoch before retaining resources. Noncontinuous emits final then onend; continuous resets without onend or model reload. Any failure emits one transcription-failed error then ends; late callbacks are ignored.
- [ ] Run `node --test test/pcm-resampler.test.js test/nemotron-recognition.test.js test/transcription.test.js`; expect pass.
- [ ] Commit listed task files: `git commit -m "feat: capture live PCM and emit Nemotron partial results"` after targeted staging.

## Task 6: Independent Local model controls

Files: modify `src/sidepanel/transcription-form.js`, `src/sidepanel/index.html`, `src/sidepanel/messages.js`; create `test/transcription-form.test.js`.

- [ ] Add a fake DOM/nativeRequest test: begin Nemotron download, select Whisper, begin Whisper download, cancel Whisper; assert only Whisper signal aborted and Nemotron progress persisted. Resolve responses in reverse order and assert the visible model's status never receives the other's result. Missing/unsupported/outdated status must preserve selection.
- [ ] Run `node --test test/transcription-form.test.js`; expect global-download behavior failure.
- [ ] Replace one download variable with a Map keyed by local model ID. Each record contains controller, generation, installed, percent, phase and error. Capture modelId in every async callback and update its record, then render the currently selected record. Send modelId in speech-status/install; no download on fill/sync/provider change.

```js
const modelState = new Map();
const stateFor = id => {
  if (!modelState.has(id)) modelState.set(id, {controller:null, generation:0, installed:false, percent:0, error:''});
  return modelState.get(id);
};
// Cancel button handler:
stateFor(provider).controller?.abort();
```

- [ ] Replace legacy option with a Local optgroup containing local-nemotron first and local-whisper second. Hide endpoint/model/key fields for both Local choices. Add translated labels/help in messages.js; explain user-initiated download, live versus phrase transcription, local audio privacy and execution-provider transcript transfer. Show exact selected model download size and setup errors. Use existing UI structure and IDs.
- [ ] Run `node --test test/transcription-form.test.js test/transcription.test.js`; expect pass.
- [ ] Commit listed files: `git commit -m "feat: manage Local speech models independently"` after targeted staging.

## Task 7: Wire panel and microphone window; verify interruptions

Files: create `src/voice/recognition-factory.js`, `test/recognition-factory.test.js`, `test/e2e/nemotron-voice.mjs`; modify `src/sidepanel/panel.js`, `src/sidepanel/mic.js`, `test/e2e/run-e2e.mjs`.

- [ ] Test factory routing with injected constructors: browser returns browser recognizer, local-nemotron returns streaming adapter, local-whisper/cloud return MediaRecorder adapter. Assert no Local path calls cloud fetch and no fallback occurs on constructor failure.
- [ ] Run `node --test test/recognition-factory.test.js`; expect missing factory failure.
- [ ] Export createConfiguredRecognition(settings, dependencies) from factory. Branch on transcription.mode === browser first; branch on provider === local-nemotron second; otherwise use createAudioRecognition with existing validateTranscription/transcribeAudio callbacks and endSilenceMs. Replace duplicate constructor selection in panel and mic with factory calls; preserve existing browser availability and permission fallback behavior.
- [ ] Add synthetic browser native-port/worklet injection before panel scripts run. Send Arabic and English partial frames and inspect visible live text before final. Complete two phrases and assert two commands exactly once in both panel and mic window; verify cumulative result history prevents postedUpTo dropping phrase two. Stop, close, switch session and enable spoken reply pause while a feed waits; release it afterward and assert no command. Inspect captured network requests to prove no audio POST.
- [ ] Register E2E scenario `nemotron-voice`; run `$env:E2E_FILTER='nemotron-voice,voice-cleanup'; npm run e2e; Remove-Item Env:E2E_FILTER`. Expected both pass without installed model or native binding. Run `node --test test/recognition-factory.test.js test/voice-controller.test.js test/transcription.test.js`; expect pass.
- [ ] Commit listed files: `git commit -m "feat: integrate live Local speech in panel and mic window"` after targeted staging.

## Task 8: Full verification and separately approved real smoke

Files: update validation notes in `docs/superpowers/specs/2026-11-16-nemotron-voice-design.md`; no test changes unless a failure exposes a defect.

- [ ] Run `npm test`; expected zero failing unit tests, including unchanged Whisper/native/project cases.
- [ ] Run `npm run e2e`; expected all existing and new browser scenarios pass. If Chromium unavailable, use documented `$env:CHROMIUM_PATH` pointing to an installed browser; report blocker rather than claiming pass.
- [ ] Run `npm run package` and `npm run package:private`; inspect outputs with package tests and confirm no nativeMessaging in store artifact, no weights/secrets in either artifact and complete private runtime closure.
- [ ] After the user approves the 751094240-byte model download, run `node native/install.mjs`, reload the private extension, select Nemotron, click Download and verify complete status. Record Windows architecture, Node version, VC++ version and exact model hash. Test CPU with English and Arabic phrases, live partial visibility before silence, second phrase without model reload, stop during inference, spoken-reply pause and session switch. Select existing Whisper and verify phrase transcription still works. Record real outcomes separately from synthetic CI evidence; an unapproved/unrun smoke remains pending.
- [ ] Commit validation documentation only after actual results: `git add docs/superpowers/specs/2026-11-16-nemotron-voice-design.md`; `git commit -m "docs: record Nemotron voice validation results"`.

## Plan self-review performed

Coverage: migration/routing Task 2; race and question exception Task 1; pins/install/runtime/licenses/store boundary Task 3; protocol/ownership/cancel Task 4; PCM/partials/reset/limits Task 5; independent model UI Task 6; panel/mic/privacy/interruption Task 7; full suites and approved real smoke Task 8. Whisper and race work remain testable before Nemotron weights exist.

Placeholder check: no fabricated digest, no unbounded audio queue, no silent fallback, no assumed runtime dependency already installed. Binding-specific stream configuration and native package closure require inspecting the pinned artifact in Task 3; these explicit verification gates must be closed before Task 4 is implemented. Code snippets specify interfaces and critical changes, not a complete production patch.

Type consistency: provider/modelId use local-nemotron/local-whisper; captureId is a nonempty bounded string, phraseId and seq are nonnegative safe integers. PCM is Float32Array in JavaScript, base64 little-endian float32 on the wire; Whisper remains WAV PCM16. Result objects use isFinal and transcript; partial wire objects use committed/tentative, final objects use text. Browser cancellation uses AbortSignal; native ownership is per process/port with explicit capture and phrase checks. All implementation commits are future steps, not performed by the documentation author.
