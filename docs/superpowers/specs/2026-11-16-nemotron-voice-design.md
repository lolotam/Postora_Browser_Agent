# Nemotron voice design

Date: 2026-11-16. Status: approved product decisions, one implementation review completed. Implementation owner: inline Kimi 3.1 Pro. This document does not authorize a model download.

## Review outcome

Feasible. No product contradiction requires changing the approved decisions. Release prerequisites: verify the pinned binding's Nemotron streaming options against its shipped declarations, exercise Windows loading with Visual C++ runtime >=14.40, and run the separately approved real bilingual smoke. These are implementation/release gates, not reasons to substitute Whisper. The current repository has no transcribe-cpp dependency.

Reconciliation findings:

- `panel.js` resolves `voiceTask` on final/error/stopped before worker cleanup. `voice-controller.js` correctly serializes promises; repair the panel's completion boundary, not its queue.
- `audio-recognition.js` records an entire phrase with MediaRecorder; it cannot supply genuine partials. Preserve it for cloud and Whisper and add a PCM streaming adapter.
- `mic.js` uses `postedUpTo` across a recognizer lifetime. The new recognizer must expose a cumulative results list with increasing phrase indexes; resetting resultIndex to zero for every phrase would drop subsequent commands.
- `native/client.js` disconnects on a single terminal response; `native/host.mjs` ignores input after its first frame. Streaming needs a separate persistent contract while retaining one-shot command/project/Whisper behavior.
- `transcription-form.js` has one global download controller. Model-specific state is required even when selection changes mid-download.
- `scripts/package-private.mjs` includes a hardcoded native-file list; `native/install.mjs` copies only three modules. Both need the binding and Windows runtime dependency closure. Store packaging already removes nativeMessaging.
- Settings default to browser/OpenAI. “Default Local” means the first Local choice and legacy Local migration, not changing those global defaults.

## Product behavior

The Local option group contains `local-nemotron` first (Nemotron Streaming 3.5, multilingual, live partials) and `local-whisper` second (Whisper Base, Arabic/English, phrase-based). Normalize legacy `provider: 'local'` to `local-nemotron`, including legacy records with `model: 'base'`: that field was the old default, not proof of an explicit new Whisper choice. Preserve `provider: 'local-whisper'`. Existing browser/cloud defaults, credentials, saved per-service settings and endpoints remain unchanged. Loading settings never downloads anything.

Each model owns status, progress, error and AbortController independently. Selecting a different model neither deletes installed files nor cancels another model's download. Cancel applies to the displayed model. Missing selected model explains Settings > Voice > Download; never silently use Whisper or cloud. Preserve the existing Whisper directory `Postora/speech/whisper-base-1.9.2-r2`.

## Pinned assets and runtime

Use `transcribe-cpp` exactly `0.4.2`, with `@transcribe-cpp/win32-x64-cpu-vulkan` exactly `0.4.2`, lockfile integrity and Node >=22. The native binding must be imported only on the Nemotron path so old one-shot operations remain independently testable. Windows x64 supports CPU and optional Vulkan; CPU must work without Vulkan hardware.

Model: `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf`; repository `handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf`; revision `53ce288f69326b415aeef030cfcb02a08a8096dd`; exact size `751094240` bytes (about 716 MiB); SHA-256 `b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c`. Download URL uses that revision, never `main`. Metadata was read from the Hugging Face model API with `blobs=true`; no weights were downloaded during planning.

Reuse staged download, exact length/digest verification and `commitInstallation`. Use a separate Nemotron destination and lock; failed/cancelled installs leave old installs intact. Private ZIP includes the binding's package metadata, JavaScript, native addon, dependent DLLs and license files with their required relative layout. Installer copies the same audited allowlist beside installed host modules. No npm install or model download at extension startup. Update private setup documentation for Node 22 and VC++ >=14.40; do not assume Whisper's existing VCLibs payload meets this requirement. Include runtime licenses and model OpenMDW-1.1 attribution in the private artifact.

## Streaming contract

One native port per capture, one model load per port, one session and stream reused across phrases. Open handshake advertises protocol 1. All subsequent frames carry captureId, phraseId and sequence; responses echo ownership. Model IDs are allowlisted. Never accept a browser-supplied filesystem path or download URL.

Proposed wire messages: `speech-stream-open`, `speech-stream-feed`, `speech-stream-finalize`, `speech-stream-reset`, `speech-stream-cancel`. Responses: `speech-stream-ready`, `speech-stream-partial`, `speech-stream-final`, `speech-stream-reset-done`, `speech-stream-error`. Feed uses base64 float32 little-endian mono PCM at 16000 Hz. Maximum 4096 samples/frame, 512000 samples/phrase, one feed in flight and at most 32000 queued samples. Reject nonfinite samples, malformed base64, wrong byte alignment, wrong IDs, duplicate/out-of-order sequence and invalid state transitions. Overflow stops capture with an actionable error; never drop audio silently. Cap transcript output at 64 KiB and incoming stream frames at 32 KiB. Preserve the old 2 MiB one-shot frame allowance. Parse split and coalesced frames correctly.

AudioWorklet downmixes input channels and uses continuous, stateful resampling from actual AudioContext rate to 16 kHz; retain filter state and fractional phase between render quanta. Use low-pass filtering before downsampling. Transfer owned buffers to the adapter. Allocate a native Float32Array copy; do not mutate or reuse it until awaited feed completes. After each feed read owned committed/tentative strings and emit a nonfinal result. Do not simulate partials from a finished phrase.

Use speech activity threshold RMS 0.012 and clamp configured endSilenceMs to 600–2000 ms (default 1200), matching existing behavior. After speech followed by configured silence, flush pending PCM, await all feeds, finalize, emit exactly one nonempty final result, reset and increment phraseId before accepting the next phrase. At 30 seconds finalize a spoken phrase to remain within the 32-second native bound. Idle silence does not create commands. Continuous captures retain the loaded model; noncontinuous capture finishes after one phrase. Audio arriving during finalize/reset has a bounded next-phrase queue with separate ownership.

The adapter exposes start/stop/abort, continuous/interimResults/maxAlternatives/lang, onstart/onprocessing/onresult/onerror/onend. For this adapter both public stop and abort cancel without final commands; silence uses a private finalization operation. Maintain cumulative SpeechRecognition-shaped results until capture ends. Each partial replaces the current index; each final freezes that index. No transcription language is forced from UI `rec.lang`; use explicit model language `auto` and remove only documented language metadata tokens, preserving Arabic and English text.

Epoch changes precede cancellation. Stop, close, spoken-reply pause and session changes retire callbacks, stop tracks, disconnect worklet/port and close AudioContext. Native disconnect cancels work; dispose stream/session/model only after pending feed settles, with process termination as the final resource boundary. Inference errors stop capture once and suppress all late text. Old host handshake failure instructs rerunning `node native/install.mjs` and reloading. Unsupported Windows architecture/Node/runtime reports requirements without changing selection.

## Voice task cleanup boundary

A task record retains its entry, sessionId, startedAt and resolve plus a terminal flag. Matching live final/error/stopped updates the entry and sets terminal, but retains the task and promise. Matching live status running=false calls setRunning(false), fails an entry without terminal report, then clears/resolves the task. Replay/stale/other-session events cannot settle it. Retain existing pending-question `settleVoiceCommand()` exception and answer routing; an answer starts no fresh task. Pre-dispatch failures can release immediately because no worker task exists. Close/session cancellation still retires ownership and drops queued commands. No arbitrary timeout may release a queued command while the worker remains busy.

## Privacy and acceptance

No Local audio reaches a transcription service or telemetry. Final transcript still goes to the selected execution provider; UI copy must explain this distinction. No localhost service is introduced. Native origin authorization remains mandatory.

Acceptance includes migration and routing units; independent model status/install/cancel tests; PCM continuity and validation; native mocked-binding partial/final/reset/failure tests; cancellation and stale-event tests; browser synthetic native streams in Arabic/English; a Postora queue regression that enqueues command two before command one finishes and proves dispatch after idle. Existing Whisper, project and native command tests remain green. Run `npm test` and `npm run e2e`. Real Windows English/Arabic smoke requires a separately user-approved model download and is not CI.

## Validation results (2026-11-17)

What was actually run, and what was not.

- **`npm test`: 1210 unit tests, 1210 passing, 0 failing.** The new coverage is the local model selection and routing, the pinned runtime and the installer, the native stream protocol, the PCM resampler and worklet, the recognition state machine, the independent model downloads, and the recognizer factory. The Whisper, project and native command cases are unchanged and green.
- **`npm run e2e`: the new `nemotron-voice` scenario passes**, on its own and in the order of the suite: the live recognizer opens, the Arabic words are visible while the phrase is still open, every phrase becomes exactly one command in the panel, a closed voice screen sends nothing, and no request other than the provider's model list is made - no audio leaves the computer. The scenario judges the speech path; whether the task that follows can run in the browser is the work of the other scenarios.
- **`npm run e2e` did not finish green in this sandbox.** The four voice scenarios that share the browser before it (`voice-cleanup`, `voice-switch`, `voice-window`, `voice-replay`) fail with Chrome's "Grouping is not supported by tabs in this window" and "Tabs can only be moved to and from normal windows": the agent cannot open its grouped tab in this browser window. The same four scenarios fail the same way on the tree before this work (`baa122e`, verified by running them against an export of that tree), so this is the environment of the machine, not a regression of this work. The whole suite must be read on a machine where these four scenarios pass.
- **`npm run package`**: `dist/postora-browser-agent-v0.4.15.zip`, 118 files, 713 KB. No `node_modules`, no model weights, and the store manifest keeps no native messaging permission.
- **`npm run package:private`**: `dist/postora-private-v0.4.15.zip`, 242 files. The pinned runtime closure is inside it - `transcribe-cpp` 0.4.2, `@transcribe-cpp/win32-x64-cpu-vulkan` with its `transcribe.dll`, `koffi` and the licenses of all three - together with the new native modules (`nemotron.mjs`, `speech-stream.mjs`, `runtime-check.mjs`, `runtime-files.mjs`). No model weights are in either archive.
- **Model download completed & verified:** The 751094240-byte model download (`nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf`) was approved, downloaded, verified with SHA-256 (`b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c`), and installed to `Postora\speech\nemotron-3.5-q8_0-53ce288f\`. Model status returns `{ modelId: 'local-nemotron', installed: true, supported: true, protocol: 1 }`.
- **Runtime prerequisites:** Windows x64, Node v24.21.0. The native binding `transcribe.dll` requires Microsoft Visual C++ 2015-2022 redistributable x64 (version 14.40 or newer). The installer and runtime check correctly detect its absence and display the direct download link (`https://aka.ms/vs/17/release/vc_redist.x64.exe`). Once the redistributable is installed on the host machine, the live CPU transcription path is ready.

## Sources

- https://github.com/handy-computer/transcribe.cpp/blob/v0.4.2/bindings/typescript/README.md
- https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/nemotron-3.5-asr-streaming-0.6b.md
- https://huggingface.co/api/models/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf?blobs=true
- https://registry.npmjs.org/transcribe-cpp/0.4.2
