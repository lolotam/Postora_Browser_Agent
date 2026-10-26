# Voice control review and repair plan

## Global constraints

- Preserve Gemini's feature intent and the supplied Jev UI structure adapted to Postora's existing design tokens; do not redesign unrelated UI.
- Keep the original working directory untouched. All edits belong in the isolated review worktree.
- Preserve existing authentication, provider settings, attachment handling and session behavior.
- No secrets, nested reference repository, generated bundles or dependency trees in commits.
- Do not weaken tests or bypass CI, confirmations, secret-field protection, session isolation or cancellation to obtain a green result.
- The implementer must not commit, push, create a PR or merge; only the orchestrator lands verified work.

## Findings accepted for repair

| Finding | Severity | Verdict | Evidence |
| --- | --- | --- | --- |
| Duplicate `voiceLive` ID | P1 | Accept | Old composer and new voice view both declare it; lookup selects hidden composer. |
| Broken microphone-window relay | P1 | Accept | New error path omits epoch and old end handler always submits to Postora. |
| Fast-only safety bypass | P1 | Accept | Runner performs click/type/submit directly; page collector includes password inputs and values. |
| Hands-free setting not honored | P2 | Accept | New recognition always continuous and restarts while listening, regardless of checkbox. |
| Hardcoded provider protocol | P1 | Accept | Brain sends `/decisions` with hardcoded OpenRouter Jev model against arbitrary configured endpoint. |
| Log, lifecycle and session races | P1 | Accept | Global current entry, overlapping async commands, and no cancellation or pinned target. |
| Hidden approvals and false success | P1 | Accept | Postora ask remains in hidden chat; final event is logged as success without checking success flag. |
| Missing translation keys and state persistence | P2 | Accept | `voice.executing`, `voice.success`, `voice.failed` absent; checkbox defaults not loaded/saved. |
| Existing session-runner assertion failure | P2 | Accept | Reproduced at clean `8944ce3` with dependencies installed: test expects string, runtime now returns `{text, images}`. |
| Missing esbuild | Environment | Accept | Original node_modules incomplete; clean worktree `npm ci` fixes dependency availability. |

## Task 1 — Repair voice UI lifecycle

Fix DOM IDs, recognition/permission relay integration, single-shot vs hands-free behavior, preference persistence, TTS feedback prevention, view switching, cancellation and pending approval visibility. Keep the new logic cohesive (extract small testable modules where useful rather than adding another duplicated recognition system). Ensure state, log entries, errors and final results belong to the correct command/session and historical replay never speaks or changes live entries. Bound or reject overlapping requests explicitly.

## Task 2 — Repair fast-only execution

Use existing provider-aware decision clients instead of a hardcoded protocol/model. Validate decision outputs and confidence. Reuse established browser/safety abstractions where possible; otherwise add explicit per-action confirmation and reject secret fields. Support abort signals and pin tab/window context across model calls and chained steps. Respect another session's ownership. Do not represent a synthetic failure as successful execution. Keep fast-only separate from main-model fallback.

## Task 3 — Regression tests and baseline triage

Add behavioral tests for tasks 1–2 using mocked recognition, Chrome and decision clients; exercise real handlers, not only source text. Add Chromium UI integration coverage where supported. Cover duplicate IDs, permissions/epochs/cancel, settings round-trip, single-shot and hands-free, speech suppression, concurrent commands and teardown, approvals, error/partial result mapping, provider routing, malformed/low confidence responses, tab targeting and secret-field protection. Correct the proven stale session-runner assertions to inspect the returned object's `text` and assert its `images`, without changing runtime semantics.

## Task 4 — Independent gates and landing (orchestrator only)

Read delivery diff against this plan, review production code and tests, run `npm test`, `npm run e2e` and package checks as appropriate, inspect rendered voice UI in English/Arabic and light/dark at narrow widths and reduced motion. Available guard skills are not installed in this session; perform explicit code/test/docs review rather than claim unavailable tools ran. No configured PR-review bot is declared in the current CI workflow. Open PR against `main`, require green unit/E2E CI on exact commit, re-review fixes, then merge. Keep worktree unless the user explicitly authorizes deletion.

## Baseline

- Revision: `8944ce3211fba84b9944b888032ebcb80e928d28`.
- Clean-main tests after `npm ci`: 352 passed, 1 failed (stale session-runner assertion); baseline log retained outside repository.
- Gemini edits copied only from `src/lib/settings.js`, `src/sidepanel/{index.html,messages.js,panel.css,panel.js}`, `src/voice/` and `test/voice-brain.test.js`.
- Original source tree and nested `JevVoiceControl/` remain untouched.

## Independent delivery review — round 1

The orchestrator independently reran the delivered code: 395 unit tests passed, Chromium E2E passed, and eight English/Arabic light/dark renders at 320px/400px passed layout checks. Screenshots were inspected. These green checks were insufficient to approve the delivery: a separate reproducer exercising the real modules demonstrated the first three defects below.

| Finding | Severity | Verdict | Required repair |
| --- | --- | --- | --- |
| Retired recognizer still executes a late final after Stop | P1 | Accept | Generation-bound callbacks and relay lifecycle; regression with captured old callback. |
| Named close-tab target bypasses another session's ownership | P1 | Accept | Recheck actual mutation target ownership and cancellation; fail closed on lookup failure. |
| Chained search uses context from before navigation | P2 | Accept | Refresh context from the pinned current target before every step. |
| Session changes do not abort fast command/approval/queue | P1 | Accept | Cancel voice lifecycle without stopping unrelated worker tasks; runtime panel coverage. |
| Fallback capture state and opening/closing popup races | P1 | Accept | Epoch-scoped bidirectional relay, late-window teardown, ended-capture signal, origin window/tab targeting. |
| External microphone keeps recording during speech output | P1 | Accept | Pause/retire external capture generation too; overlapping speech callbacks cannot resume retired capture. |
| Type-and-submit approval hides submission and proposed text | P1 | Accept | Explicit presentation of proposed text and submission; refuse secret focus rather than redirect. |
| Localization, malformed decisions, oversized mic with tiny icon | P2 | Accept | Translated results, strict typed validation, Postora accent and scoped icon sizing. |

MiniMax receives a targeted follow-up brief for these findings, retaining all previous changes. The next delivery requires independent review and full gates again. No production code is committed or merged on the strength of a delegate's self-report.

## Final review and merge threshold

Round 2 fixed the three independently reproduced defects and added coverage for permission-window targeting, session-change cancellation, approvals, replay, provider selection, and strict decision handling. The orchestrator subsequently repaired small delivery gaps directly: propagated send failures and cancellation across pending session selection, per-panel microphone epoch ranges, popup-to-tab migration, retired microphone-page callbacks, overlapping external-microphone speech, and context refresh after a navigating click. Additional behavioral tests exercise the actual microphone script and actual panel send functions using mocked browser boundaries.

Final checks include the full unit suite, Chromium E2E, store packaging, the independent three-bug regression script, and eight rendered English/Arabic light/dark voice layouts at 320px/400px. Screenshots are retained outside the repository. Recognition is mocked in automated tests; real microphone hardware and live provider credentials are not claimed as verified.

The PR must have **all CI checks green on its exact HEAD**, no unresolved correctness/security/lifecycle findings at P1 or P2, and no unexpected files or secrets. No PR review bot is configured in this repository; the orchestrator's code, test and documentation review is the review gate. No deployment workflow was found, so the terminal state is merge, not a claimed store release.

Tradeoffs retained: fast-only conservatively asks before every click/type/Enter/tab-close; Postora approval questions return to chat; speech synthesis defaults off; commands stay pinned while permission UI owns focus. No sub-second performance guarantee is made. The supplied original source tree and reference repository remain untouched. Worktree cleanup requires a separate explicit approval.
