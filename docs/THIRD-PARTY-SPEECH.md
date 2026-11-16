# Third-party speech runtime

Postora's private local speech features use pinned third-party software installed under your user profile (for example `%LOCALAPPDATA%\Postora`). These components are not uploaded to Chrome Web Store builds.

## Nemotron Streaming 3.5 (local-nemotron)

- Model (GGUF, pinned): `handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf`, file `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf`, revision `53ce288f69326b415aeef030cfcb02a08a8096dd`, size `751094240` bytes, SHA-256 `b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c`.
- Runtime bindings: `transcribe-cpp@0.4.2` and its platform package `@transcribe-cpp/win32-x64-cpu-vulkan@0.4.2` (installed locally for the private build; licenses preserved in the private package closure).
- Native dependency: `koffi@3.3.8` (loaded by `transcribe-cpp`).

## Whisper (local-whisper)

- Whisper assets remain pinned as defined in `native/speech.mjs` (base model and runtime ZIP downloads with SHA-256 verification).

## Model downloads and privacy

- Models and runtimes are downloaded only when you explicitly choose to install them in the extension UI or via the native installer.
- Microphone audio for local transcription is processed locally by the installed runtime; no audio is sent to Postora servers by these local paths.

## Prerequisites

- Windows x64 and Node.js >= 22 (for the native host when using Nemotron streaming).
- The Microsoft Visual C++ 2015-2022 redistributable for x64 in version **14.40 or newer**. The pinned native runtime is a compiled library: an older runtime crashes inside it while it loads.
- The private installer checks this in a separate child process, so an incompatible runtime is reported as a message with the setup instruction instead of taking the installer down. Nothing is installed on your machine: the redistributable is a machine-wide change and your decision. Download: <https://aka.ms/vs/17/release/vc_redist.x64.exe>.
- The Nemotron streaming model is served by the pinned runtime through its parakeet stream slot (the upstream conversion keeps the RNN-T head). The runtime is asked whether it can stream the model before a stream is opened; a runtime that cannot is refused with an explanation rather than transcribing badly.
