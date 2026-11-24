# Review hardening — implementation plan

Specification: `docs/superpowers/specs/2026-11-24-review-hardening-design.md`.
Baseline: `main` at `0110807`. This planning session implements nothing.
The implementer is not chosen yet (owner decision, 2026-11-24).

**Order.** Phase 0 and the seven Phase 1 items first, in the order below, then
Phases 2 to 5. The specification's "Amendments after review" section is part
of every task's requirements. One task is one PR unless a row says otherwise. Each task
follows the same steps:

- [ ] For a claimed defect: reproduce it with a failing test. If it cannot be
      reproduced, record that in the PR that closes the task and change no
      behaviour. For an intended change (A1, A2, the switches, Batch E): write
      the test of the new contract first; these are never closed unreproduced.
- [ ] Make the change described in the specification.
- [ ] Run `npm test`, `npm run e2e`, `npm run package`, `npm run package:private`.
- [ ] Open the PR with the tier named below; a tier card goes to the owner
      before the task starts.

Work from `F:\Dev\Projects\Postora_Browser_Agent`, one worktree per task under
`F:\Dev\Worktrees\Postora_Browser_Agent\<branch>`. Never stage
`handoff-postora-pr45.md` or `.playwright-mcp/`.

## Batch A — priority (Phase 0 and Phase 1)

| Order | Task | Files | Tests | Tier |
| --- | --- | --- | --- | --- |
| A0 | Sender check on worker requests and ports (spec 2.1, was B1) | `src/background/service-worker.js`, `src/background/session-runner.js`, `src/permissions/panel-sender.js` | port authenticated before attach, replay and queued dispatch; untrusted sender gets nothing from `backup-export`, `save-settings`, `run` | Heavy |
| A1 | Remembered access mode (merges after A0 and A2) | `src/permissions/policy.js`, `src/background/session-runner.js`, `src/background/service-worker.js`, new `src/permissions/access-preference.js`, `src/sidepanel/access.js`, `index.html`, `messages.js`, `docs/plans/chat-permission-modes.md`, `docs/PRIVATE-ACCESS.md` | new `test/access-preference.test.js`; extend `test/access-worker.test.js`; e2e: mode survives a worker restart; backup import leaves Ask first | Heavy |
| A2 | Local-execution gate, unconditional (the "without asking" switch is a later PR, after owner decision 2) | `src/permissions/policy.js`, `src/agent/tool-kinds.js`, `src/background/session-runner.js` (card detail), `src/sidepanel/permissions.js`, `messages.js` | policy tests for the four tools in both modes: always a card; a stored `localExecution` value is ignored; e2e: `project_run` asks in Full access | Heavy |
| A3 | Lost working tab stops the task; `close_tab` ownership | `src/browser/controller.js`, `src/agent/tools.js` | controller tests with a removed tab; agent-loop and fast-layer tests: no provider turn and no tool call after the loss; e2e: close the working tab mid-task, task goes idle | Medium |
| A4 | Truncated tool calls fail the turn | `src/providers/openai-compatible.js`, `src/agent/agent.js` (owns the retry) | provider tests for `finish_reason: 'length'`, unparsable arguments and a clean history after truncation; agent tests for the two-retry cap and the terminal failure | Medium |
| A5 | Tool timeout, abort race, page dialogs | `src/agent/tools.js`, `src/browser/controller.js`, `src/agent/prompt.js` (dialog tool), `src/permissions/policy.js` (dialog class), `native/host.mjs`, `native/project.mjs` | a losing handler cannot act later; unknown result is not repeated; write paused before commit leaves the file unchanged; e2e fixture: answer `confirm` and `prompt` before the timeout, `alert` dismissed, Stop after `dialog-pending` | Medium |
| A6 | Snapshot generation ids | `src/browser/page-scripts.js`, `src/browser/controller.js`, `src/agent/tools.js`, `src/fast/fast-layer.js`, `src/agent/agent.js` | stale-index tests; e2e with the fast layer re-indexing | Medium |
| A7 | Voice approval focus | `src/sidepanel/panel.js` | e2e: Enter in the command box with a card open | Medium |
| A8 | Hands-free opt-in and spoken stop | `src/voice/voice-controller.js`, `src/sidepanel/panel.js`, `messages.js` | `test/voice-controller.test.js`: stop word mid-task, phrase dropped while busy, default off for a new profile | Medium |

Merge order for the three Heavy tasks is A0, A2, A1: remembered Full access
must not reach `main` before the sender check and the local-execution gate.
Each waits for the owner's approval card before merge. A3 to A8 do not depend
on each other and may run in parallel.

Exit for Batch A: all nine merged, CI green on `main`, a private package built
and checked by hand on the owner's Comet and Chrome profiles: Full access
remembered after a browser restart; `project_run` asks; closing the working tab
stops the task; "stop" by voice stops.

## Batch B — security (Phase 2)

| Order | Task | Spec rows | Tier |
| --- | --- | --- | --- |
| B2 | Approval cards show what is approved | 2.2 | Heavy |
| B3 | Project file filters on read and write, pinned roots | 2.3 | Heavy |
| B4 | Import drops `project` and body `meta` | 2.4 | Heavy |
| B5 | Untrusted text framed as data | 2.5 | Medium |
| B6 | http(s)-only navigation | 2.6 | Medium |
| B7 | Secrets redacted in transcript, log and backup | 2.7 | Medium |
| B8 | Markdown renderer builds DOM nodes | 2.8 | Medium |
| B9 | Drive backup "include keys" switch and docs | 2.9 | Medium |

The sender check moved to Batch A as A0. B2 builds on the card detail added in
A2.

## Batch C — agent quality (Phase 3)

| Order | Task | Spec rows | Tier |
| --- | --- | --- | --- |
| C1 | Stall detector | 3.6 | Medium |
| C2 | Keep user attachments when pruning images | 3.1 | Medium |
| C3 | Shared trimming module | 3.5 | Medium |
| C4 | Stream retry and kept checkpoint | 3.3 | Medium |
| C5 | Per-task handoff log with caps | 3.2 | Medium |
| C6 | Viewport text, element cap, frame argument | 3.4 (coordinate with PR #51) | Medium |
| C7 | Token estimate when usage is missing | 3.8 | Medium |
| C8 | Debugger cancel stops; smaller items | 3.7, 3.9 | Medium |

C3 before C7: the estimate reuses the module's message sizes.

## Batch D — side panel and voice (Phase 4)

| Order | Task | Spec rows | Tier |
| --- | --- | --- | --- |
| D1 | Live status line in the folded log | 4.1 | Medium |
| D2 | Startup errors in notices; send button after an answer; microphone cleanup | 4.2, 4.4, 4.5 | Light |
| D3 | Stick-to-bottom scrolling, jump chip, delta batching | 4.7 | Medium |
| D4 | First-run card and model auto-save | 4.3 | Medium |
| D5 | Composer autocomplete for `/` and `@` | 4.8 (second half) | Medium |
| D6 | Settings auto-save | 4.8 (first half) | Medium |
| D7 | Voice: waiting state, speech language picker, kept errors | 4.6, 4.10 | Medium |
| D8 | Accessibility and RTL totals | 4.9, 4.10 | Light |
| D9 | Hardcoded strings to `messages.js` | 4.11 | Light |
| D10 | Stop feedback and shortcut | 4.12 | Medium |

## Batch E — maintainability (Phase 5)

| Order | Task | Tier |
| --- | --- | --- |
| E1 | Root cleanup and `.gitignore` | Light |
| E2 | ESLint in CI | Medium |
| E3 | Release job reuses built packages | Medium |
| E4 | `panel.js` split, one module per PR, behaviour unchanged | Medium |
| E5 | Provider markup as a template | Medium |

E4 starts only after Batch D, so the split does not collide with UI changes.

## Open decisions for the owner

1. Implementer for each batch.
2. "Run local commands without asking": confirm it is a separate switch from
   Full access, off by default, remembered once turned on.
3. Store-build review risk (native modules shipped unused, `claude-cli`
   User-Agent rule): fix, or accept while the build stays private.
4. Drive backup keys: default for "include keys and sign-ins" (recommended:
   off, with explicit consent), and whether to add passphrase encryption.
