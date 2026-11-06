# Postora workspace and voice implementation plan

**Goal:** Deliver the user-approved interface, live mode notice, automatic bilingual
speech, and per-chat project context with read/write/command tools.

**Architecture:** Focused native project operations, a shared speech transcription
client and recorder adapter, and a small panel project controller. Keep authority
in SessionRunner and the existing tool executor. Keep assets local.

**Tech stack:** Chrome MV3, ES modules, Node native messaging, MediaRecorder,
OpenAI-compatible multipart transcription, existing node:test and Playwright.

- [x] Interface: bundle Cairo/OFL, remove the empty-state image, update tokens and
  composer styles, preserve existing element IDs and RTL/mobile layouts.
- [x] Mode notice: emit access-change as transcript data; render and replay as an
  informational row without calling applyAccessState.
- [x] Speech: configure endpoint/model/key/mode, add bounded recorder adapter and
  multipart client; integrate microphone popup and panel; detect output language
  from text and choose a matching installed voice. Test no forced language and
  cancellation before late transcription can execute.
- [x] Project: native canonical paths, tree/read/write operations, hash conflict
  protection; trusted session binding and replay; project tools and cwd commands;
  folder picker, current-project chip, @file context insertion.
- [x] Validate each module with meaningful unit tests, then full tests and real
  extension fixtures using synthetic files and mocked providers. Package privately.

Execution is inline in the current session, preserving existing uncommitted work.
