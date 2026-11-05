# Private Full access on Windows

## Chat, voice, and project update

The interface follows the supplied compact chat reference. The large empty-state
logo is removed; model selection is borderless; Arabic uses the bundled Cairo font
and its OFL license. No external font service is contacted. Confirmed access changes
are displayed as small conversation notes. Those notes never grant permissions.

**Automatic Arabic/English speech:** open Settings → Voice and choose Automatic
Arabic / English. Set a transcription endpoint, model, and API key. The defaults
use `https://api.openai.com/v1/audio/transcriptions` and `gpt-transcribe`, following
the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).
A compatible local service may use an HTTP localhost URL and omit the key. The
service must accept multipart `file`, `model`, and `response_format=json`, and
return `{ "text": "..." }`. We send no language constraint and never use the
English translation endpoint. Endpoint credentials are not forwarded on redirects.

Each phrase is bounded to 30 seconds and finishes after about 1.2 seconds of silence.
Audio goes only to the configured transcription service and is not stored in chat
history; transcribed text is processed like a typed task. Transcripts and requested
project file contents reach the configured chat provider and may remain in history.
Live transcription quality requires a working service; regression tests use a mock
service and synthetic audio. The system voice is chosen from the response language.
Install an Arabic Windows speech voice if the browser has none; Postora reports
that missing voice instead of choosing English for Arabic text.

**Project folders:** click the folder icon next to the chat controls, browse or paste
an absolute path, then Link. This binds the folder to the current chat. Stop a running
task before changing its project. The project chip reopens the file list; typing `@`
lets you pick a file reference. Ask the agent to read project instructions, modify
files, or run tests. It uses `project_list`, `project_read`, `project_write`, and
`project_run`. Project association is saved per chat. Unlink removes the association
without deleting the folder or its files.

Listings omit `.git`, dependency/build directories, `.env` files and common private
key formats. This avoids loading irrelevant or sensitive content automatically;
an explicitly requested read still uses the normal access policy. File tools reject
paths outside the linked real directory and symlinks that escape it. Writes require
the hash returned by the latest read, or `new` for a new file. Read larger files in
chunks before replacing their full contents. Text reads are limited to 1 MiB per
file and 24000 characters per result; writes are limited to 64000 UTF-8 bytes.
PowerShell commands start in the project but retain the Windows user's privileges:
they are not an OS sandbox. Commands retain the 60-second maximum timeout.

Project writes use an exclusive sibling lock across native processes, so two
Postora sessions cannot silently overwrite the same revision. A crash can leave
a `.postora-write.lock` file: after confirming that no Postora write is running,
the user may remove that specific lock and retry after reading the file again.
Editors outside Postora do not participate in this lock protocol.

This is a local, unpacked extension. Nothing is uploaded to the Chrome Web Store.
Run `npm run package:private` to create `dist/postora-private-v0.4.2.zip`.
Extract it into a permanent directory and load that directory with **Load unpacked**
in `chrome://extensions`. When updating an existing installation, use **Reload**;
removing it deletes its stored settings and credentials.

Full access authorizes supported browser actions, including requested deletion,
form entry, and explicit reads/copies of sensitive field values, without another
Postora approval for each action. Values read by the model reach the configured AI
provider and saved conversation history. Ordinary page snapshots still mask secret
fields; `read_field` reads the particular field required by the task.

## Local PowerShell, files, and clipboard

Install Node.js, then run this command once from the private extension directory:

```powershell
node native/install.mjs
```

The installer copies the host to `%LOCALAPPDATA%\Postora\native` and registers it
under HKCU for Chrome, Edge, and Chromium. It retains the extension's stable manifest key and
allows only that extension ID. It does not request administrator access, expose an
HTTP listener, or register the host for other Windows accounts. Native messaging
registration follows [Chrome's native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

Reload the extension and choose **Full access** in the relevant chat. `run_terminal`
runs PowerShell as the signed-in Windows user, including local file operations,
program execution, and `Get-Clipboard` / `Set-Clipboard`. Ask first requires an
approval for each native command. Command output reaches the AI provider and saved
history. There is no automatic administrator elevation or password-vault access.
Maximum command length is 16000 characters, timeout 60 seconds, captured output
64 KiB. Commands are independent; supply `cwd` explicitly when required.

Stop, a downgrade to Ask first, or a disconnected native port terminates the running
command tree. Effects already performed cannot be undone. Do not use the bridge
to start services intended to outlive the command.

## Mode changes

Enabling Full access keeps the task running. A pending browser action obtains a
fresh permit for its originally captured target, and the target is checked again
before execution. A denial is never retried. Returning to Ask first stops the task
and revokes old permits. The live mode is sent to the model on its next turn.

The mode is per chat and stays through task completion and panel reconnects while
the worker remains alive. A new chat, browser restart, or worker restart starts
Ask first. The mode selector shows the worker-confirmed state.

Chrome protected pages, the browser password vault, native dialogs, and OS account
restrictions are not unlocked by extension permissions. The store packaging path
removes `nativeMessaging` and the native command tool; the private packaging path
retains them.

## Provider and transcription update (0.4.0)

Main and fallback providers now have two groups: Authentication / subscription,
and API key / coding-plan key. Existing saved credentials and engines are retained.
ChatGPT / Codex, Claude / Claude Code, xAI / Grok, and Kimi Code use their existing
account paths. Labels do not restrict the user to a named subscription tier.
MiniMax and Z.ai plan entries explicitly require a plan key; no unsupported OAuth
flow is presented. API choices include OpenRouter, OpenAI, Gemini, Anthropic,
Moonshot, MiniMax, Z.ai, DeepSeek, NVIDIA, and custom compatible endpoints.

OpenRouter uses [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
with a fresh verifier and a random extension callback path. The returned key is
kept in the existing provider key store and persisted when the user saves. This
is an OpenRouter credit-billed key, not access to ChatGPT or Claude subscription
allowances. Closing the sign-in window leaves the prior settings intact.

Speech services are independent of the reasoning account. The Voice page offers
OpenAI, [Groq](https://console.groq.com/docs/speech-to-text),
[Deepgram](https://developers.deepgram.com/docs/multilingual-code-switching),
custom compatible servers, and local multilingual Whisper Base. Each service
retains its own endpoint, model and key when switching. Groq uses multipart
transcriptions with `whisper-large-v3-turbo`. Deepgram receives the original audio
with `language=multi` and Arabic/English hints, never its default English-only
setting. Claude remains available as a reasoning engine; its
[documented models](https://platform.claude.com/docs/en/models/overview) do not
provide a standalone speech-to-text API, so there is no fake Claude STT choice.

Local mode downloads about 163 MB on an explicit button click, displays byte-based
progress, verifies pinned SHA-256 hashes, and installs under
`%LOCALAPPDATA%\Postora\speech`. It uses whisper.cpp 1.9.2, multilingual Base at a
pinned Hugging Face revision, and app-local Microsoft VC runtime DLLs downloaded
from Microsoft. It does not install machine-wide software or need administrator
rights. The host verifies that the executable actually starts before committing
the installation. Repair serializes the final directory swap and preserves a
damaged previous installation in a `.previous-*` sibling for manual recovery.
Cancel closes the native port, aborts downloads/inference, and
removes this attempt's staging files. No cloud fallback occurs in local mode.
Audio is converted to mono 16 kHz PCM in the browser, sent over native messaging,
and stored in a temporary directory only for inference, then removed. The text
still goes to the user's selected reasoning engine. Base is compact; Arabic
dialect accuracy and latency depend on the recording and CPU.

Download origins and licenses:

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.2) — MIT.
- [Whisper model](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1)
  and [OpenAI Whisper](https://github.com/openai/whisper) — MIT.
- [Microsoft desktop C++ framework package](https://learn.microsoft.com/en-us/troubleshoot/developer/visualstudio/cpp/libraries/c-runtime-packages-desktop-bridge)
  — Microsoft license; downloaded directly, not included in the extension archive.

Re-run `node native/install.mjs` when updating from 0.3.0, then reload the extension.

## Verification (2026-11-05)

Version 0.4.2 renders model turns as compact borderless text rows, collapsed by
default, with keyboard-accessible expansion. Tool rows expand independently to
show their original arguments and result summary; hidden details remain in the
saved conversation replay. Arabic prose determines RTL alignment independently
of the interface language, including mixed reports beginning with English text.
Code blocks and isolated inline commands retain LTR direction.

Unconfigured/legacy installs retain browser speech recognition until a
transcription service is explicitly configured. Native command approvals show
the command text in an LTR scrollable preview. Native project handlers are
removed from the store build. Model integrity checks use streaming hashes rather
than loading the entire model into memory; integrity verification remains enabled.

Version 0.4.1 adds Arabic/English playback test buttons and persistent playback
status. Missing system voices and browser playback errors are reported separately
from speech recognition errors. A paused synthesis queue is resumed before speech.
The Voice settings offer 0.6, 0.9 and 1.2 second end-of-phrase delays. Existing
settings retain 1.2 seconds unless changed; faster delays may split long pauses
into separate commands. This changes capture latency, not model inference speed.
Deepgram configuration does not supply a text-to-speech voice; Arabic playback
still requires an Arabic voice visible to the browser.

- `npm test`: 1078 passing tests.
- `node test/e2e/providers-voice.mjs` with `POSTORA_TEST_DOWNLOAD=1`:
  grouped connection routes, account/API switching, independent speech keys,
  real checksum-verified download, native transport and local inference passed.
  Cloud transport tests use synthetic responses, not paid provider credentials.
- Browser regression scenarios passed using an installed extension-capable
  Chromium via `CHROMIUM_PATH` and grouped `E2E_FILTER` runs. Headless fixtures
  were updated to wait for startup, foreground controls, and close leftover
  connections. The default Playwright executable was not installed.
- `node --test test/native-terminal.test.js`: seven passing tests, including
  actual PowerShell framing, Unicode output, failures, output limits, timeout,
  rejected extension origin, and termination on native-port closure.
- `node test/e2e/native-terminal.mjs`: actual Chrome native messaging transport
  to the installed host passed with a synthetic output command.
- `node test/e2e/workspace.mjs`: the real extension linked a synthetic project,
  selected an `@` file, upgraded access mid-action, read and replaced a file using
  its hash, ran a native command, and transcribed through a mock multilingual
  endpoint. Composer geometry passed at 320/360/400 px in both languages/themes.
- Private and store packaging and `git diff --check`: passed. No publishing.
