# Review hardening — design

Date: 2026-11-24. Baseline: `main` at `0110807`, version 0.4.17.

## Source and status

This specification turns the end-to-end review of 2026-11-24 into work. Three
read-only reviewers covered the agent core, security and permissions, and the
side panel with voice. Every finding below comes from reading code. None was
reproduced in a running browser, so **each task starts by reproducing its
finding with a failing test**; a finding that cannot be reproduced is closed
with a note instead of a change. File and line references are those of the
baseline commit and were spot-checked, not exhaustively verified.

Owner decisions recorded here (Waleed Mohamed, 2026-11-24):

- All findings get a specification and a plan; the seven "fix first" items come
  before everything else.
- The access mode selection must be remembered. Today every new chat and every
  worker restart returns to Ask first and the owner has to choose Full access
  again.
- Who implements is decided later. This document assigns no implementer.

## Goals

1. Close the paths where page or file content can cause local command
   execution, a wrong-tab action, or an action the user did not see.
2. Remove the failure modes that leave a task wrong, stuck or silently marked
   as a success.
3. Remember the access mode the owner chose.
4. Make a running task legible and the first run short.

Non-goals: new providers, a redesign of the side panel, a rewrite of
`panel.js` beyond the split in Phase 5, changes to the store listing.

## Phase 0 — remembered access mode (owner request)

**Today.** `AccessAuthority` (`src/permissions/policy.js:230`) starts every
session at Ask first and lives in worker memory only. This was deliberate:
`docs/plans/chat-permission-modes.md` says "a new chat or restarted worker
starts Ask first. Never restore Full access from ordinary settings, saved
transcripts or replayed model messages." This phase reverses the first half of
that sentence by owner decision and keeps the second half.

**Design.**

- The chosen mode is a preference of this browser profile, stored under its own
  `chrome.storage.local` key (`accessPreference`), **not** inside `settings`.
  It is therefore never part of a settings save, a backup file, a Drive backup,
  an import, a transcript or a session body.
- Shape: `{ mode, acknowledgedAt, version }`. `mode` is `ask-first` or
  `full-access`; anything else reads as Ask first.
- Only the worker reads and writes it, and only when a verified side panel of
  this extension sets the mode through the existing `access-mode` request with
  its acknowledgement. Model output, page text, tool arguments, `run`/`steer`
  text and imported data can never write it.
- A new `AccessAuthority` starts in the remembered mode. A restarted worker
  restores it for every session it rebuilds. The revision counter still starts
  at 1 and every permit is still bound to its revision.
- Choosing Ask first is remembered the same way, so the control always shows
  the last choice.
- The Full access warning is shown when the owner turns Full access on. It is
  not shown again on each new chat. The mode indicator stays visible in every
  chat, with a one-click return to Ask first.
- A "Remember my choice" switch in Settings → Behavior, on by default. Off
  restores today's behaviour (every chat starts at Ask first) and clears the
  stored preference.
- Store build: same behaviour. The private-only tools are absent there, so the
  remembered mode cannot reach them.

**Interaction with Phase 1, item 1.** Remembered Full access covers browser
actions. The four local-execution tools keep their own gate (below), so a
remembered Full access never means unattended PowerShell unless the owner also
turned that separate switch on.

**Acceptance.**

1. Choose Full access, open a new chat: it is in Full access with no dialog.
2. Restart the worker (or the browser): existing and new chats are in the
   remembered mode.
3. Choose Ask first: new chats start at Ask first.
4. Export a backup and import it on a clean profile: the profile is at Ask
   first.
5. A `save-settings` message, an imported backup, a transcript replay and a
   model tool call each fail to change the stored preference.
6. With "Remember my choice" off, every chat starts at Ask first.

## Phase 1 — the seven priority fixes

### 1. Local execution always has its own gate

`policy.js:529-531` issues a permit for every non-observation tool in Full
access, including `run_terminal`, `project_run`, `project_write` and
`run_javascript`. A page or a linked file that persuades the model reaches
PowerShell as the Windows user.

- Add an action class `LOCAL_EXECUTION` for those four tools.
- In Full access they still ask, unless the owner turned on **"Run local
  commands without asking"** — a separate switch with its own warning, stored
  beside the access preference with the same rules (worker-written, never in
  settings or backups), remembered per the owner's request, off by default.
- The approval card for these tools shows the full command, working directory,
  JavaScript expression, or the target path with the size and a diff summary of
  the write.
- Acceptance: in Full access with the switch off, each of the four tools
  produces a card; with it on, none does; neither state can be set by anything
  but the verified panel.

### 2. A lost working tab stops the task

`controller.js:72-118`: when the working tab is gone, `currentTab()` falls
through to `startOn()`, which claims the active tab of the last focused window.

- After a task has started, a missing working tab ends the step with "the
  working tab was closed". `startOn()` runs only at task start.
- `close_tab` (`tools.js:660-675`) closes only tabs this session owns or opened
  as disposable.
- Acceptance: closing the working tab mid-task never changes another tab;
  `close_tab` on a foreign tab id is refused.

### 3. Truncated tool calls are never executed

`openai-compatible.js:502` `safeJson` returns `{ _raw }` for unparsable
arguments and `finish_reason: 'length'` is not checked.

- Unparsable arguments and a `length` finish are a failed turn: the same
  behaviour as `anthropic.js` and `responses.js`. The model is told its call
  was cut off and asked again; the step counts once.
- Acceptance: a truncated `done`, `insert_text` and `navigate` each produce a
  retry, never an action and never a success report.

### 4. Every tool call can be stopped

`tools.js:726-745` checks the abort signal only before the handler; injection
and CDP calls have no timeout; nothing handles `Page.javascriptDialogOpening`.

- Race each tool against the task's abort signal and a per-tool timeout
  (default 30 s, longer for `project_run` and `run_terminal` as configured).
- Handle JavaScript dialogs through CDP: report the dialog text to the model
  and dismiss `beforeunload`; `alert`/`confirm`/`prompt` are answered by a new
  `dialog` tool or dismissed after the timeout.
- Stop always ends in `status: running false`.
- Acceptance: a page that opens `alert()` during a click does not hang the
  task; Stop during a hung tool returns the panel to idle within 2 s.

### 5. Element indexes carry a generation

The fast layer rebuilds `__agentElements` each step, but the model sees the new
state only when `fastActions.length > 0 || !llmHasSeenPage` (`agent.js:76`).

- Every page snapshot has a generation id. Tools that take an index also carry
  the generation the model saw. A stale generation is refused with the fresh
  state, and nothing is clicked.
- Acceptance: after the fast layer re-indexes, a model call with an old index
  returns the new state without acting.

### 6. Voice approval does not take focus

`panel.js:2007` focuses the Approve button.

- Do not move focus. Announce the card through a polite live region, as
  `permissions.js:373-376` already does for the chat cards.
- Acceptance: Space and Enter typed into the command box never approve.

### 7. Hands-free is opt-in and "stop" stops

`panel.js:1628` defaults hands-free to on; `voice-controller.js:235` queues
every final phrase, also during a task.

- Hands-free defaults to off for new profiles; an existing saved choice is
  kept.
- While a task runs, a stop word ("stop", "cancel", «وقف», «توقف», «الغِ»)
  stops the task. Any other phrase heard while busy is dropped and shown as
  "heard, not run".
- The microphone indicator shows listening whenever capture is live.
- Acceptance: "stop" spoken mid-task stops it and starts nothing.

## Phase 2 — security

| # | Finding | Where | Change |
| --- | --- | --- | --- |
| 2.1 | Worker handlers answer any extension sender | `service-worker.js:168-363`, `session-runner.js:172,226-244` | One `isSidePanelSender` check at the top of `handleRequest` and `onConnect`; `overlay-stop` stays open to the content script. |
| 2.2 | Approval cards hide what is approved | `session-runner.js:339-355` | Show full destination URL, typed text (masked for secret fields), JS expression, write summary. Never fall back to the current origin for a navigation. |
| 2.3 | Secret and hidden-file filter covers listing only | `native/project.mjs:85-106`, `native/host.mjs:220-226` | Apply it to `project-read` and `project-write`; `.git/` is never writable. Pin allowed roots in the host configuration. |
| 2.4 | Imported backup can set a project root | `sessions/store.js:80-95` | Drop `body.project` on import; validate `body.meta` is absent. |
| 2.5 | Page-controlled text enters user messages unframed | `prompt.js:131-134`, `fast-layer.js:265`, `fallback-session.js` | Tab title, URL, fast-layer snapshots and `project_read` output go in a delimited data block with escaped markers. |
| 2.6 | `navigate`/`open_tab` accept any scheme | `tools.js:838-842`, `controller.js:775-780` | http and https only. |
| 2.7 | Typed secrets and `read_field` values are stored | `agent.js:129-132`, `tools.js:288` | Redact both in transcript, log and backup for secret fields. |
| 2.8 | Markdown autolink re-matches inside an emitted `href` | `sidepanel/markdown.js:10-11` | Single-pass tokenizer that builds DOM nodes. |
| 2.9 | Drive backup holds keys unencrypted | `lib/drive-backup.js:107-117` | "Include keys and sign-ins" switch, default as today; document it. Passphrase encryption is a later option. |

Store-build review risk (unused native modules shipped, `claude-cli` User-Agent
rule in `header-rules.js`) is recorded for the owner; no change is specified
without his decision.

## Phase 3 — agent quality

| # | Finding | Where | Change |
| --- | --- | --- | --- |
| 3.1 | Image pruning deletes user attachments | `anthropic.js:503-517`, `openai-compatible.js:383-386`, `responses.js:311-314` | Prune tool-result screenshots only. |
| 3.2 | Backup handoff carries the session's first task | `fallback-session.js:41-45,152-169` | Per-task log with a current-task field; cap steps and argument size. |
| 3.3 | Retry covers response headers only | `lib/retry.js` | Retry once when the stream failed before any output; keep the checkpoint on provider errors so Resume is offered. |
| 3.4 | "Visible text" is the top of the document | `page-scripts.js:370`, `controller.js:450-455,501` | Viewport-anchored text, one total element cap across frames, a frame argument for `get_text` (see PR #51). |
| 3.5 | Trimming cuts file content, never trims fast-layer states | `openai-compatible.js:364,372`, `agent.js:76-77`, `anthropic.js:82-88` | One shared trimming module; file reads and `ask_user` answers are exempt; fast-layer states are trimmed. |
| 3.6 | No loop detection | `agent.js:38` | Hash tool, arguments and page fingerprint; nudge after two repeats, stop after four. |
| 3.7 | Debugger infobar "Cancel" is ignored | `controller.js:71,325-332` | `canceled_by_user` stops the task. |
| 3.8 | Auto-compaction needs reported usage | `openai-compatible.js:65`, `session-runner.js:658` | Estimate tokens (characters / 4) when usage is missing. |
| 3.9 | Smaller items | several | Text-only turn is not an automatic success; `ask_user` timeout; evict idle runners; `emit` guarded like `broadcast`. |

## Phase 4 — side panel and voice

| # | Finding | Where | Change |
| --- | --- | --- | --- |
| 4.1 | No progress while a task runs | `panel.js:814-818`, `index.html:129` | Live status in the folded summary: step n of max, tool, model, tokens. |
| 4.2 | Startup errors are invisible | `panel.js:3946-3947` | Show them in `#notices`. |
| 4.3 | First run is about nine actions | `panel.js:2972`, `provider-form.js:215`, `workspace.css:17` | Land on Models, auto-save the model after first sign-in, three-step first-run card using the unused `empty.*` strings. |
| 4.4 | Send button stays hidden after an answer | `panel.js:1149` | Restore it when the question clears. |
| 4.5 | Microphone cleanup closes foreign tabs | `panel.js:1490-1494` | Match `chrome.runtime.getURL(...)` exactly. |
| 4.6 | A question marks the voice entry "Cancelled" | `panel.js:622`, `voice-controller.js:302-308` | Show "waiting for your answer". |
| 4.7 | Long tasks | `panel.js:1179,547-559,448-455` | Scroll only when at the bottom, "jump to latest" chip, batch deltas per frame, collapse old turns. |
| 4.8 | Settings | `panel.js:3888`, `index.html` | One save behaviour (auto-save per control); composer autocomplete for `/` commands and `@` files. |
| 4.9 | Accessibility | `panel.css:15,71,225`, `index.html:130` | Focus ring with 3:1 contrast, minimum 11px text, `aria-live` off while streaming. |
| 4.10 | RTL and speech language | `workspace.css:47`, `panel.js:1645` | Totals follow the interface direction; speech language picker (ar, en, auto). |
| 4.11 | Hardcoded English | `index.html:485-716`, `voice/transcription.js:23-62`, `model-session.js:61` | Move to `messages.js`, both languages. |
| 4.12 | Stop feedback | `panel.js:2076`, `overlay.js:181-184` | "Stopping…" state, Escape shortcut, on-page Stop even with the cursor off. |

## Phase 5 — maintainability and repository

- Split `panel.js` (3,950 lines) along its existing seams: connection and event
  router, transcript renderer, composer, voice screen, sessions, account and
  backup, settings, model slots, provider auth. No behaviour change; one module
  per PR.
- Provider markup in `index.html:351-669` becomes one `<template>`.
- Add ESLint with the rules the code already follows; CI fails on errors.
- CI: the release job reuses the packages the test job built.
- Repository root: move or delete the 60 untracked `.log` files and add the
  pattern to `.gitignore`; decide on `handoff-postora-pr45.md`.

## Tiers

Per the delivery tiers in `CLAUDE.md`. Phase 0, item 1 of Phase 1 and items
2.1–2.4 change permissions or authority: **Heavy**, merged only after the
owner's card approval. The rest of Phases 1–3 is **Medium**. Phase 4 items of
150 lines or fewer and i18n are **Light**; the others are Medium. Phase 5 is
Medium, except the root cleanup, which is Light.

## Testing

Each fix lands with a unit test that fails before it. Phases 0–2 also add
real-extension end-to-end scenarios: remembered mode across a worker restart,
the local-execution card in Full access, the lost-tab stop, a page dialog
during a click, and the sender check. Policy is tested as behaviour, never by
matching source text. `npm test`, `npm run e2e`, `npm run package` and
`npm run package:private` stay green on the exact PR head.
