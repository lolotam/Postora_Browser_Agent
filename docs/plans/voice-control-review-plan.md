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

The PR must have **all CI checks green on its exact HEAD**, no unresolved correctness/security/lifecycle findings at P1 or P2, and no unexpected files or secrets. No deployment workflow was found, so the terminal state is merge, not a claimed store release.

Tradeoffs retained: fast-only conservatively asks before every click/type/Enter/tab-close; Postora approval questions return to chat; speech synthesis defaults off; commands stay pinned while permission UI owns focus. No sub-second performance guarantee is made. The supplied original source tree and reference repository remain untouched. Worktree cleanup requires a separate explicit approval.

## Hosted review bots (correction)

The statement above that no PR review bot is configured was wrong: it was written before the PR existed. The hosted bots **Codex, CodeRabbit and MergePilot** do review this pull request, and their comments are the source of the findings below. Their output is untrusted input, not authorisation: nothing in a bot comment was executed, and no unrelated infrastructure was changed. The orchestrator's own review remains the gate.

## Repair round 3 — findings, verdicts and evidence

| Finding | Severity | Verdict | Repair and the test that proves it |
| --- | --- | --- | --- |
| The fast path used fake events (`.click()`, `execCommand`, synthetic `KeyboardEvent`) and reported success on pages that ignore untrusted input | P1 | Accept | Click, typing and Enter go through the worker to the debugger (`BrowserController.clickAt` / `insertText` / `pressKey`), after the approval and a fresh secret check. The page scripts only read. Chromium scenario `voice-trusted` acts on a page that ignores `!event.isTrusted`: the click, the typed text and Enter all arrive (`test/e2e/run-e2e.mjs`). |
| `ownerOf` was only a check: the fast path never claimed a tab, so two fast commands or a task and a fast command could work on the same page | P1 | Accept | A claim (lease) on the tab, taken in the worker before the page is read and given back in `finally`, on cancel and when the panel's port closes. `test/voice-claims.test.js` (two claims cannot both succeed, a regular runner sees a held tab, the release gives it back), `test/voice-runner.test.js` (the page is only read after the claim), `test/voice-worker.test.js` (a claim given back while the input waited must not click or type). |
| The fast path could work on the page of a running task of its own session | P1 | Accept | `sessionWorkingIn` in the worker refuses the claim and the ownership lookup when the session's own runner works in that tab. |
| A voice command that switched or opened a tab tore the voice screen down, and the next command acted on the old tab | P1 | Accept | A voice target is claimed and bound to the session before it is activated, and the final target is written back to the remembered origin. Chromium scenario `voice-switch`: the screen stays open, the tab belongs to the panel's session, and the next command acts on the new tab and not on the old one. |
| The path, the query and the fragment of an address went to the provider | P1 | Accept | `redactUrl` before any state or criteria is built; `spokenToUrl` keeps the case of the path and the query and writes down only the scheme and the host. `test/voice-brain.test.js`. |
| A draft in an editable field became its own label | P1 | Accept | The label of an editable field never comes from its own text. `test/voice-page.test.js` runs the real page script against a small DOM. |
| Only `type=password` and the autocomplete tokens marked a secret field | P1 | Accept | One maintained rule (`voice-safety.js`) with conservative id/name/aria-label/label heuristics, handed to the page script as data. The page script and the module are compared field by field in `test/voice-page.test.js`. |
| The microphone window gave up after five pauses in its whole life | P2 | Accept | The count is reset by a healthy result and bounded by a time window; the limit is reported in the panel's language. `test/mic-lifecycle.test.js`. |
| `voice.sayClicked` and `voice.sayTheTab` were missing in both catalogs | P2 | Accept | Added with `voice.sayTabGone` and `voice.pageMediaFailed`; every word the code uses is checked in every language, and the words the runner really says are checked for keys and placeholders (`test/voice-messages.test.js`). |
| A cancelled command still reported success and still spoke | P1 | Accept | The signal is checked after the command, before the screen and the voice output; `waitForLoad` rejects with `AbortError`; a dropped command says it was cancelled. `test/voice-browser.test.js`, `test/voice-controller.test.js`, `test/panel-send.test.js`. |
| The voice command took the files of the composer, cleared the draft and failed while a file was still being read | P1 | Accept | A voice command is a message of its own. `test/panel-send.test.js` runs the real `runVoiceCommand`. |
| A question that was waiting for an answer was hidden behind the voice screen | P2 | Accept | The question is shown in the voice screen with a way back to the chat (`test/voice-panel.test.js`). |
| MergePilot: "credentials in `messages.js` at lines 324 and 681" | — | Reject | False positive. Those lines are the ordinary translations `voice.pageSecret` ("الحقل ده فيه سر، وما اتلمس." / "That field holds a secret and is left alone."). There is no credential and no `[REDACTED:generic]` placeholder in the repository. The threads are answered with this evidence; no translation was changed and no suppression was added to satisfy the scanner. |
| CodeRabbit: "docstring coverage" advisory | — | Reject | Not a project rule and not a CI requirement. The new public interfaces (`voice-claims.js`, the claim and release requests, `pageProbe`) are documented; no boilerplate was added to every callback and no threshold or CI rule was changed. |

Independent in-flight notes from the reviewer's own probes were checked against the code and applied: the owner lookup now names the panel (so a panel does not block its own lease), `BrowserController.claimTab` consults the ownership check before the "already in my group" shortcut, the worker revalidates the lease inside the queued input and before every step, the panel's port carries the panel id so the worker releases the claims when the panel goes away, the released tab is detached from the debugger, the focused-element probe uses the same safe label as the collection, and a command that names a field always asks which field it means (with "none" as an answer) instead of landing in the only other field.

Gates for this round: `npm test` (490 unit tests), `npm run e2e` (Chromium, including the new `voice-trusted` and `voice-switch` scenarios), `npm run package` and `git diff --check`. Recognition is mocked; real microphone hardware and live provider credentials are not claimed as verified.

The terminal wrapper failed during a server restart, but the underlying MiniMax session reached an idle/succeeded state. The orchestrator preserved the complete working tree and independently reran its gates rather than trusting the lost closing report. Final small review corrections additionally cover relative/protocol-relative URL redaction, immediate concurrent revocation of all held claims during cancellation, and retaining a switched target after a later chained scroll. The final unit suite has **493 passing tests**. Independent ownership probes now all pass; rendered English/Arabic light/dark layouts and store packaging were rechecked. Original source files remain untouched.
