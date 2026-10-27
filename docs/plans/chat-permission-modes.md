# Chat permission modes

## User decisions

- Add an access-mode control in chat: **Ask first** and **Full access**.
- Scope is the browser, including terminals embedded in websites. Native Terminal/PowerShell access is excluded.
- Full access may read and write existing page secrets and send requested secret values to configured AI providers. The user explicitly chose this over write-only access.
- The microphone icon is enlarged and centered independently in commit `442ce5a`; preserve it.

## Product contract

Ask first is the default for each chat. Browser interactions and explicit field-value reads require an action-bound approval. Full access performs supported actions without Postora approval prompts after the user acknowledges a clear warning. Questions needed to finish an ambiguous task remain questions; Full access does not invent missing credentials or silently answer them.

The warning states that actions can submit forms, send/delete data, run commands in a web terminal, and read/write sensitive fields; requested secret values may enter configured primary/backup AI requests and saved conversation history. Enable explicitly for this chat, not globally or via model/page text. Keep a visible mode indicator and a direct way to return to Ask first.

Full access never overrides Chrome's protected URLs, extension/build capabilities, missing browser permissions, Stop/cancellation, target identity, or another session's tab ownership. It does not unlock Chrome's password-manager vault, native files, or OS terminals.

## Authority and lifecycle

- A worker-owned per-session authority is the source of truth. Keep grants ephemeral; a new chat or restarted worker starts Ask first. Never restore Full access from ordinary settings, saved transcripts or replayed model messages.
- Only a verified extension UI request with explicit warning acknowledgment may elevate access. Ignore mode claims in model tool arguments, page content, run/steer text, or stored history.
- Broadcast actual state to all panels for that session. Mode selection must remain correct across tab/session switching and worker reconnect; do not optimistically show Full access before worker acknowledgment.
- Changing mode cancels current execution and pending approvals before subsequent actions use the new mode. Make this behavior visible in the control's helper/warning text. Revocation is checked after asynchronous preparation, immediately before mutating browser input or a sensitive read; stale approvals do not survive it.
- Approvals bind session, policy revision, exact action/arguments, tab and target/document. A denial, stale response, malformed message, disconnect that loses the approval, or aborted signal executes nothing. Approval responses cannot double-submit or authorize a different action.

## Shared execution policy

One small policy interface serves normal tool execution, its configured fast layer, and fast-only voice. The UI and prompt describe policy; neither is the enforcement mechanism. Centralize mode normalization, action classification, approval/revision checks and consent lifetime instead of scattering permissive booleans.

Ask first allows ordinary observations (`read_page`, `get_text`, screenshots, listing tabs), notebook operations and waiting without extra prompts. Interactions (navigation/search, click, typing, keys, selection, hover/scroll/history, tab control, and enabled page JavaScript) and explicit `read_field` calls request approval. Full access automatically authorizes these supported actions. Preserve the allowJavascript/build tool allow-list separately.

Use dedicated permission requests/responses, distinct from free-form `ask_user` questions. Denial must be terminal for that action and must not consume a chat draft or attachments. Action previews identify the site and target, describe possible web-terminal execution, and avoid echoing passwords in generic UI/audit metadata.

Keep secret classification separate from permission. Default snapshots/candidate descriptions still hide password/OTP/payment/secret field contents. Add an explicit **read_field** capability for the selected indexed field: Ask first approves it; Full access reads without a prompt. This permits requested existing secrets to reach the model without automatically harvesting every secret field on a page. Use the maintained secret rules rather than a second inconsistent English-only classifier.

Add **insert_text** for the currently focused editable control, including web-terminal helper textareas after a real click/focus. Use trusted CDP input, not synthetic keyboard events. Ask first previews/approves it; Full access skips approval. Do not claim native-shell access or rely on arbitrary JavaScript to make web-terminal typing work.

After an approval, revalidate the approved tab, document and element/focus. Page replacement, copied DOM markers, focus redirection or coordinates now covered by another element cannot inherit consent. Indexed elements have isolated-world references; do not fall back to a page-writable marker after the original reference disconnects. Preserve the existing stronger voice leases and dispatch guards.

## Prompt contract

The agent receives the worker-authoritative access mode. Explain that tool-level permissions are enforced automatically, so it should not duplicate authorization questions with `ask_user`. Keep `ask_user` for genuinely missing information or a browser limitation. Preserve untrusted-page-content and no-invented-credentials rules. Full access permits user-requested page-secret reads/writes; do not leave contradictory unconditional never-read/always-ask rules. The model cannot change its own mode.

## UI reference lock

Direct build using the existing Postora panel as the primary reference, supplemented by Refero's bundled icon/focus guidance. No live Refero connector is available.

| Decision | Source | Rule |
| --- | --- | --- |
| Existing white/near-black surfaces, system font, thin borders, mint accent | Current `panel.css` and reviewed English/Arabic screenshots | Preserve the shipped design, not generic alternate brand tokens |
| Compact labeled access control near the chat composer; visible status in voice | User request + existing controls | One authoritative selection, not independent conflicting toggles |
| Full-access warning dialog and persistent risk label | Explicit user consent + existing semantic warning/danger tokens | Risk color is semantic; never color-only |
| Arabic/English, RTL, keyboard focus, Escape/cancel | Current panel and bundled craft guidance | Native accessible controls; no new UI library |

## Verification contract

Test policy as behavior, not source-string claims: default deny/ask, explicit Full acknowledgment, cancellation/denial, ordinary input, sensitive read/write, malformed/stale/duplicate replies, switching/reconnect, forged model/page mode, exact target/document, and downgrade during CDP preparation. Test each execution route; a main-model gate must also cover fast-layer tools. Add real-extension E2E for mode UI, Ask first deny/approve, Full secret access, trusted web-terminal text+Enter, revocation and RTL layouts. Existing baseline E2E tasks can enable Full through the actual consent UI; never grant it via forged model/settings fields or disable policy in production/test builds.

Run `npm test`, full `npm run e2e`, `npm run package`, and `git diff --check`. Keep microphone geometry checks (48px centered in an 80px circle) passing. Use only mock providers, synthetic secret values and local terminal fixtures; no real accounts, payments, commands or credentials. Document actual limitations and gate results.

## Delivery slices

1. Shared worker authority and chat consent UI, with focused authority/UI behavior tests. This is an internal, unshipped foundation; it is not yet permission enforcement.
2. Normal/fast tool enforcement, selected field reads and focused trusted insertion using that authority. Keep fast-only voice execution unchanged until the next slice.
3. Wire fast-only voice to the same authority and approvals, including sensitive fields and supported read/type actions; verify parity, cancellation and revocation across all routes.
4. Independent code/behavior/visual review, complete gates, PR, green exact-HEAD CI and verified merge. Do not ship or claim the feature complete before all execution routes pass. The user explicitly authorized continuation through successful merge.
