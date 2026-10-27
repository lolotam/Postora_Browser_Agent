# Voice control integration — reviewed specification

## Goal and scope

Integrate the supplied Jev Voice Control experience into Postora's existing side panel. This is a review and repair of Gemini's implementation, not a redesign. The original Gemini plan was supplied by the user from `voice_control_integration_plan.md` and is the functional source alongside this specification.

- Clicking the composer microphone shows a dedicated voice screen; Back restores chat and stops microphone capture and speech output.
- Keep the large microphone, live interim/final transcript, hands-free and spoken-reply controls, typed commands and activity log.
- Support Postora's current agent (default) and a configured fast-provider-only mode without silently falling back to the main model.
- Retain English/Arabic, RTL/LTR, light/dark themes and existing provider/account behavior.
- Fast-only mode must not bypass sensitive-action confirmation, expose or populate secret fields, cross into another running session, or continue executing after cancellation.
- Model confidence and timing describe measured decisions, not an unverified sub-second latency guarantee.

## Acceptance criteria

1. All DOM IDs are unique. New transcript updates reach the visible voice screen.
2. Direct recognition and the existing microphone-window fallback support the new view, correct relay epochs, engine selection, cancellation and bounded restart behavior.
3. Hands-free off processes one utterance and stops; hands-free on can continue. Speech output cannot feed back into commands. Preferences persist.
4. Commands execute serially or are explicitly refused while busy; activity results cannot attach to unrelated, replayed or another session's tasks. Failures and partial completion are never shown as unconditional success.
5. Postora approval questions are visible and answerable, never hidden behind the voice screen.
6. Fast-only uses the existing provider-aware decision clients and configured model, endpoint, key, backup and timeout behavior. Invalid or low-confidence decisions fail closed.
7. Click, type and submission paths require explicit confirmation when they could send, delete, pay or otherwise mutate sensitive data. Secret inputs (password, payment, OTP and secret autocomplete fields) are rejected before observation/typing. No credentials appear in page descriptions or errors.
8. Commands are cancellable and retain a well-defined browser target across asynchronous decisions; no implicit retargeting to another tab/window during a command.
9. Behavioral regression tests cover new UI and execution paths, not only text helpers; unit and Chromium E2E suites pass.

## Reference lock and decision ledger

| Decision | Source | Role |
| --- | --- | --- |
| Dedicated voice screen and central microphone | Supplied Jev `sidepanel.html` / `sidepanel.css` and Gemini plan | Interaction structure only |
| Typography, surfaces, borders, accent and control radii | Existing Postora `panel.css` design tokens | Brand authority; do not import Jev's purple theme |
| Permissions, relay epoch and cancellation | Existing Postora `voice.js` / `mic.js` | Preserve Chrome permission workaround |
| RTL, focus labels and reduced-motion support | Existing bilingual UI and accessibility requirements | New controls remain keyboard/screen-reader usable |

## Delivery

Worktree: `E:/Dev/Worktrees/Postora_Browser_Agent/voice-control-review`.
Branch: `fix/voice-control-review`, PR base: `main`.
Gemini implementation remains preserved in the original working directory. Do not add the nested reference repository or any secrets to the PR.
MiniMax `minimax-coding-plan/MiniMax-M3.1-Flash` repairs code and writes regression tests; the orchestrator independently reviews, tests, commits and lands. No extra plan debate or general web research was requested. The available workflow runs unit and Chromium E2E tests, with no deployment job. Merge only after all checks on the exact final commit are green and all blocking review findings are addressed.
