# Subscription sign-in through pi-ai, an Anthropic provider, and MiniMax

Date: 2026-10-23. Reference implementation: MergePilot (`F:\Dev\Projects\MergePilot`,
`packages/engine/src/providers/subscription/auth.ts`, `docs/subscription-auth.md`).

## Problem

The README and `docs/SETUP.md` (commit 0548728) say the extension signs in with a
ChatGPT, Claude or Grok account and accepts Anthropic and xAI keys. The code only
has ChatGPT sign-in (a hand-written device-code flow in `src/providers/chatgpt-auth.js`)
and OpenAI-compatible API keys. There is no Anthropic provider, no Claude or Grok
account sign-in, and no MiniMax.

## Goals

1. One sign-in layer for the three account subscriptions, built on the OAuth flows
   of `@earendil-works/pi-ai@1.1.0` (the library MergePilot uses):
   - ChatGPT (Plus/Pro/Team) — device code, replacing the hand-written flow.
   - Claude (Pro/Max) — PKCE "copy code": the user opens claude.ai, approves, and
     pastes the `code#state` it shows back into the panel.
   - Grok (SuperGrok / X Premium) — device code at auth.x.ai.
2. A Claude provider speaking the Anthropic Messages API with either a Claude
   account token (`sk-ant-oat…`) or an Anthropic API key (`sk-ant-api…`).
3. A Grok provider that uses the Grok account token; the xAI API key keeps working
   through the existing `xai` OpenAI-compatible preset.
4. Two MiniMax presets: pay-as-you-go and Coding/Token Plan (`sk-cp-` keys).
5. Docs that describe what the code does.

## Non-goals

- Model calls through pi-ai. pi-ai is used for login and refresh only. Postora's
  own session layer (tool calls, notebook trimming, screenshots, retries, the
  FallbackSession handoff) stays the model transport.
- Any loopback-callback login (`localhost` redirect). The extension cannot listen
  on a port; the device-code and copy-code methods are forced.
- Google Antigravity, GitHub Copilot or other pi-ai OAuth providers.

## Design

### Vendor bundle

`scripts/build-vendor.mjs` bundles the three pi-ai OAuth flow modules
(`dist/auth/oauth/{anthropic,openai-codex,xai}.js`, imported by file path because
pi-ai's `exports` map does not expose them) with esbuild
(`platform: 'browser', format: 'esm'`), aliasing `node:http` and `node:crypto` to a
stub that throws. The output, `src/vendor/pi-oauth.js` (≈40 KB), is committed with a
header naming the package, version and licence (MIT), so "Load unpacked" and
`npm run package` keep working without a build. A test rebuilds the bundle in memory
and fails when the committed file differs. The spike on 2026-10-23 confirmed: the
bundle loads under Node, and its remaining `process` references are guarded by
`typeof process`.

### Credential store (`src/providers/account-auth.js`)

- One `chrome.storage.local` key per provider — `accountAuth.chatgpt`,
  `accountAuth.claude`, `accountAuth.grok` — each holding
  `{ generation, credential: { type: 'oauth', access, refresh, expires, ...extra } }`,
  pi-ai's credential shape; extras (ChatGPT `accountId`, email, plan) are kept.
  Writes for one provider are serialised, and a refresh or login result is stored
  only if the record (generation and refresh token) or login attempt it started from
  is still current, so a late result never undoes a sign-out.
- Migration: on first read, a legacy `chatgptAuth` record
  `{ accessToken, refreshToken, accountId, email, planType, expiresAt, idToken }`
  becomes `accountAuth.chatgpt` and `chatgptAuth` is removed. A ChatGPT user stays
  signed in.
- `getValidCredential(provider, { forceRefresh })`: refreshes when fewer than
  10 minutes remain (pi-ai refreshes at 5; refreshing first means pi-ai never needs
  to), single-flight per provider, and **writes the rotated refresh token to storage
  before returning**. Only a confirmed OAuth rejection (`invalid_grant` and its
  kin) removes the record and asks the user to sign in again; timeouts, network
  errors, 408/429/5xx and anything unclassified keep it.
- Refresh runs only in the service worker. The panel asks the worker for status.

### Login orchestration (service worker)

`startAccountLogin(provider)` runs `<flow>.login(interaction)` with an
`AuthInteraction`:

- `notify(event)` → posts `{ type: 'auth-event', provider, event }` to open panels
  (`auth_url` opens a tab; `device_code` shows the code and URL).
- `prompt({ type: 'select' })` → answered automatically: `device_code` for ChatGPT,
  `copy_code` for Claude. Grok has no select.
- `prompt({ type: 'manual_code' | 'text' })` → posts `auth-prompt` and waits for the
  panel's `auth-input` message; `auth-cancel` rejects it.
- The existing keep-alive (`chrome.runtime.getPlatformInfo` every 20 s) runs for the
  whole login. A worker restart mid-login loses the PKCE verifier; the panel shows
  the error and the user starts again.

Message routes take a `provider` field; a message without one means `'chatgpt'`, so
the current panel code keeps working while it is updated. `auth-import` (Codex
`auth.json`) stays, ChatGPT only, and writes the new shape.

### Network

`installHeaderRules` gains Origin-removal rules for `platform.claude.com`,
`claude.ai` and `auth.x.ai`, and `removeRuleIds` lists every rule id it installs.
Whether `api.anthropic.com` (with `anthropic-dangerous-direct-browser-access`) and
`api.x.ai` need the same is checked while implementing; a rule is added only for a
host that rejects the extension's Origin.

### Providers

- `slot.provider` gains `'claude'` and `'grok'`, next to `'chatgpt'` and
  `'compatible'`. Settings gain `claude: { auth: 'account' | 'apiKey', apiKey, model, effort }`
  and `grok: { model, effort }`, in the main slot and in `fallback`.
- `src/providers/anthropic.js`: `AnthropicSession` with the session interface
  (`addUserMessage`, `addToolResult`, `next` → `{ text, toolCalls, usage, retryWaitMs }`),
  streaming `POST https://api.anthropic.com/v1/messages`. With an account token it
  sends what pi-ai sends (`api/anthropic-messages.js:749-890`):
  `Authorization: Bearer <token>`,
  `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (plus any feature betas),
  `user-agent: claude-cli/2.1.280`, `x-app: cli`, and a first system block exactly
  `You are Claude Code, Anthropic's official CLI for Claude.`, followed by Postora's
  system prompt. With an API key it sends `x-api-key`. Both send
  `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true`.
  Thinking maps the effort setting to a token budget. Models come from
  `GET /v1/models`.
- Grok account: the Responses API at `https://api.x.ai/v1/responses`, as pi-ai
  uses, through a `ResponsesSession` extracted from `ChatgptSession` (which keeps
  its Codex-specific options). Models from `GET /v1/models` with the token.
- MiniMax: presets `minimax` (pay-as-you-go) and `minimax-coding-plan` (`sk-cp-`),
  both `https://api.minimax.io/v1`, default model `MiniMax-M3.1-Flash`, a new
  `thinkingStyle: 'minimax'` that sends `reasoning_split: true` (and
  `reasoning_effort` on M3.1-Flash), keeps the reasoning in the conversation history,
  and strips `<think>…</think>` from the displayed text.

### Backup

`backup.js`, `drive-backup.js` and the worker's `storage.onChanged` filter include
`accountAuth`. A backup file that holds the older `chatgptAuth` imports as
`accountAuth.chatgpt`.

## Risks

- Claude and Grok account access is unofficial, exactly as ChatGPT's is; the docs
  already warn. Anthropic may change the Claude Code identity requirements; the
  values are copied from pi-ai 1.1.0 and named in one place.
- Losing a rotated refresh token signs the user out (MergePilot commit 6e561e7).
  The store writes before returning, and nothing else refreshes.
