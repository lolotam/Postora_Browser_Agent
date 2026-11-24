# Review hardening — design

Date: 2026-11-24. Baseline: `main` at `0110807`, version 0.4.17.

## Source and status

This specification turns the end-to-end review of 2026-11-24 into work. Three
read-only reviewers covered the agent core, security and permissions, and the
side panel with voice. Every finding below comes from reading code. None was
reproduced in a running browser, so **each task that fixes a claimed defect
starts by reproducing it with a failing test**; a defect that cannot be
reproduced is closed with a note instead of a change. Intended changes are
tested against their new contract (see "Amendments after review"). File and line references are those of the
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

## Amendments after review (2026-11-24)

The review of this document on PR #52 found gaps. Where this section and the
text above disagree, this section wins.

**Scope of the reproduction rule.** "Reproduce first, close if it cannot be
reproduced" applies to claimed defects only. Phase 0, the local-execution
gate, the new switches and Phase 5 are intended changes: they need a test of
the new contract (or, for tooling and refactors, the checks named in their
row) and are never closed for lack of a baseline defect.

**Order.** Remembered Full access must not ship before its safeguards. The
sender check (2.1) and the local-execution gate (Phase 1, item 1) merge first;
the remembered mode merges last of the three. The sender check authenticates a
port before it is attached, before replay data is sent, and before any queued
message is dispatched.

**Phase 0 — remembered access mode.**

- Record: `{ remember, mode, localExecution, revision, acknowledgedAt, version }`.
  `remember: false` is stored explicitly, so a restart can tell "opted out"
  from "never chose". An invalid or unreadable record is Ask first with local
  execution asking.
- Enforcement, not assertion: at worker start call
  `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`,
  so content scripts cannot read or write extension storage. Audit every other
  writer of `chrome.storage.local` in trusted contexts; the panel never writes
  this key and changes it only through the worker's verified request.
- All changes to the record go through one serialized queue in the worker and
  carry the profile revision the panel last saw, in addition to the session
  revision. A stale request is refused and answered with the state in force.
- The panel shows a mode as changed only after the write succeeded. A failed
  write leaves the previous mode in force and says so; a downgrade that could
  not be stored still applies to the live sessions and is reported as "not
  remembered".
- Profile-wide effect: choosing Ask first, or turning "remember" off, applies
  at once to **every** live session: their permits are revoked and pending
  approvals cancelled, as a mode change does today. Choosing Full access
  applies to the chat it was chosen in and to chats opened afterwards; other
  chats that are already open keep their mode until the owner changes it there.

**Phase 1, item 1 — local execution.** The gate is unconditional in the first
PR: the four tools always ask, in every mode. The "without asking" switch is a
separate, later PR that ships only after the owner confirms it (open decision
2). If it ships, its consent text names all four capabilities (PowerShell,
project commands, project file writes, page JavaScript); turning it off revokes
outstanding permits in every runner, is rechecked immediately before dispatch,
and stops a native command that is still running.

**Phase 1, item 2 — lost tab.** Tab loss is a terminal outcome for the task,
not for the step: a dedicated error reaches the runner from both the main loop
and the fast layer, the task ends with a message that says the working tab was
closed, and no further provider turn or tool call happens. The test asserts
all three.

**Phase 1, item 3 — truncated calls.** The retry is owned by the agent loop,
not the provider. The provider returns an explicit `truncated` outcome;
`runAgent` tells the model its call was cut off and asks again, at most twice,
then ends the task as failed. A truncated turn is never a `final` success.
Files: `src/agent/agent.js` as well as the provider.

**Phase 1, item 4 — timeouts and dialogs.**

- The timeout cancels, it does not only stop waiting: each call gets its own
  abort signal (task signal plus timeout) that reaches injection, CDP and
  native requests, and the executor keeps its state per invocation, not
  shared. A handler that lost the race can no longer act or hold a permit.
- The execution timeout starts after the approval is granted. Waiting for the
  owner's answer has its own lifetime, and an expired card is withdrawn.
- A dialog that opens during an action ends that action with a
  `dialog-pending` result that carries the dialog text, so the model gets a
  turn while the dialog is still open. The `dialog` tool answers that exact
  dialog on that target. Tests cover answering a `confirm` and a `prompt`
  before the timeout, not only the eventual dismissal of an `alert`.

**Phase 2.**

- 2.2: the card shows origin and path; credentials in the URL and query values
  are masked in what the panels receive. The approval stays bound to the exact
  unmasked destination.
- 2.3: the filter is checked against every component of the requested and the
  canonical path, for listing a directory as well as for read and write. It is
  a guarantee of the project file tools only. PowerShell keeps the Windows
  user's privileges and is not confined to the project; that is why it keeps
  per-command approval.
- 2.5: every page- or tool-derived field at the handoff is framed, including
  the fast layer's ranked hints and action summaries. Framing is defence in
  depth, not an authorization control.
- 2.7: one sensitivity-aware projection is applied before arguments are
  copied anywhere, including the fast layer's recent actions and its reusable
  text candidates (`fast-layer.js:187-188`), so a typed secret is not sent to
  the fast provider. Tested with a synthetic secret.
- 2.8: links are created only for `http` and `https` destinations, for
  Markdown links and autolinks alike. Anything else renders as inert text.
- 2.9: recommended default is **off** for including keys and sign-ins in the
  Drive backup, with explicit consent to turn it on. Turning it off replaces
  the current Drive file with one without credentials; older revisions Drive
  keeps are outside the extension's control and the text says so. The default
  is the owner's decision (open decision 4).

**Tiers.** The voice approval focus fix (Phase 1, item 6) is Medium, like the
rest of Phase 1; it guards an approval.

### Second round (2026-11-24)

**Remembered access mode.**

- Fail closed on protection: remembered Full access is honoured only after
  `setAccessLevel` has resolved in this worker start. If it rejects, every
  session starts at Ask first and the panel says the remembered mode could not
  be restored.
- Creating an authority is ordered with preference changes: a runner reads the
  profile revision immediately before it is published in the live runner map
  and starts at Ask first if the revision moved while it loaded.
- A downgrade that cannot be stored must not come back after a restart. The
  worker retries the write; until it succeeds it also sets a
  `chrome.storage.session` revocation marker, and a restore that finds the
  marker, or cannot prove the record is current, is Ask first. The message says
  plainly that Full access may need to be turned off again after a browser
  restart if the write keeps failing.
- "Remember" off means a Full access choice applies to that chat only. Chats
  opened afterwards start at Ask first.
- The Full access warning is rewritten for the new scope: with "remember" on it
  says the choice applies to new chats and survives a restart. Turning
  "remember" on while a chat is in Full access shows that warning again. The
  earlier contract in `docs/plans/chat-permission-modes.md` ("for this chat,
  not globally") is updated in the same PR.
- The `localExecution` field is reserved. Until the owner approves the switch,
  the first delivery ignores any stored value and always asks.

**Truncated calls.** The provider must not leave the cut-off assistant turn in
its history: it either does not commit the turn or removes it before returning
`truncated`, so the retry is a valid conversation. Tested by a second request
after a truncated one.

**Timeouts.**

- Three outcomes, not two: cancelled before dispatch, confirmed stopped, and
  **unknown** (the command had already reached Chrome or the native host). An
  unknown result is reported as such to the model, which must check the page
  state before repeating the action; the agent never repeats it by itself.
- The per-call signal reaches `native/host.mjs` and `native/project.mjs`:
  `projectOperation` takes the signal and checks it immediately before the
  rename that commits a write. Tested by a write paused before commit that
  leaves the original file unchanged.
- A pending dialog has its own deadline, independent of the action timer, and
  is dismissed when the task stops, fails or the deadline passes. Tested with
  Stop after `dialog-pending` and before any reply.
- Answering a dialog is an action of its own class. In Ask first, accepting a
  `confirm` or answering a `prompt` needs a fresh approval bound to that
  dialog; dismissing does not. It does not inherit the approval of the click
  that opened it.

**Phase 2.**

- 2.2: path segments that look like tokens (long high-entropy segments) are
  masked in the preview as well as credentials and query values.
- 2.3: protected names are compared case-insensitively, as Windows does, in
  list, read and write checks.
- 2.9: a Drive restore keeps local credentials that the backup omits; omission
  is not deletion. The consent to include credentials is local to the profile,
  stored outside `settings`, and is never exported, imported or restored.
