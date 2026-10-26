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
