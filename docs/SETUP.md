# Full Setup Guide — Provider & Account Setup

This guide takes you from a fresh clone to running your first browser task using account authentication (ChatGPT, Claude, Grok subscriptions) or standard API keys. See [Roadmap](#roadmap).

Time needed: about 10 minutes.

---

## 1. Requirements

| Need | Details |
|---|---|
| Browser | Google Chrome **116 or newer** (or another Chromium browser that supports the Side Panel API and `chrome.debugger`: Edge, Brave, Arc). Check at `chrome://settings/help`. |
| Account plan or API key | Access via ChatGPT plan (Plus, Pro, Business), Claude account (Pro/Team), Grok account (SuperGrok), or an API key from any supported provider (Anthropic, xAI, OpenAI, Google AI Studio, DeepSeek, NVIDIA, etc.). |
| Git | To clone the repo. |
| Node.js 20+ | **Optional.** Only needed to run the tests, or for the `auth.json` fallback login (step 4B). The extension itself has no build step. |

> ⚠️ **Honest warning.** Using subscription accounts (ChatGPT, Claude, Grok) from a third-party client is not an official product of those providers. Providers can change or block unofficial clients at any time. Do not use them for anything you cannot afford to have stop working.

---

## 2. Get the code

```bash
git clone https://github.com/lolotam/Browser-controle.git
cd Browser-controle
```

There is nothing to build. The folder that contains `manifest.json` (the repo root) **is** the extension.

---

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked** and select the repo folder (the one with `manifest.json`).
4. "Postora Browser Agent" appears in the list. Click the puzzle icon in the toolbar and **pin** it.
5. Click the icon (or press **Alt+Shift+A**). The side panel opens on **Settings** because no model is chosen yet.

When you pull new code later, return to `chrome://extensions` and click the **reload ↻** button on the extension card.

**Keep your settings:** use **reload ↻**, not **Remove**. Chrome deletes an extension's stored data (settings, API keys, account sign-ins) when it is removed. Before removing it, open Settings → **Settings backup** → **Download backup**; after loading it again, use **Restore from file**. The backup file holds your keys, so keep it private.

The manifest pins the extension ID to `bhoimdlegicacjkholpfcokajpiimbcn`, so it stays the same whichever folder you load it from. The first load after this change still starts empty, because the previous ID came from the folder path.

---

## 4. Connect your AI provider account or key

In the side panel's Settings, choose your provider. You can connect using direct account authentication (ChatGPT subscription, Claude account, Grok account) or an API key.

### 4A. ChatGPT account sign-in

1. Select **"اشتراك ChatGPT"** (ChatGPT subscription) and click **"تسجيل الدخول بحساب ChatGPT"** (Sign in with ChatGPT).
2. A new tab opens at `https://auth.openai.com/codex/device`, and the side panel shows a one-time code such as `ABCD-1234`.
3. In that tab, sign in to ChatGPT (with 2FA if you use it), then enter the code.
4. Approve the request. Within a few seconds the panel shows **"متصل: you@email — plus/pro"** (Connected).

The code expires after 15 minutes. If it expires, click the button again.

**If you get "Device-code login is not enabled":** your account or workspace has device-code authorization for Codex turned off. Enable it in ChatGPT → Settings → Security (workspace admins: the workspace security settings), or use 4B.

### 4B. ChatGPT fallback: import `auth.json` from Codex CLI

Use this only if 4A is not possible:

```bash
npm install -g @openai/codex
codex login            # choose "Sign in with ChatGPT"
```

Codex writes your tokens to:

| OS | Path |
|---|---|
| macOS / Linux | `~/.codex/auth.json` |
| Windows | `%USERPROFILE%\.codex\auth.json` |

If the file does not exist, Codex stored the tokens in your OS keychain instead. Add `cli_auth_credentials_store = "file"` to `~/.codex/config.toml`, then run `codex login` again. Open the file, copy **all** of its contents, and paste them into **"بديل: استيراد auth.json"** → **استيراد** (Import) in the panel.

> ⚠️ **Gotcha: shared refresh token.** After an import, the extension and the Codex CLI hold the **same** refresh token. OpenAI rotates refresh tokens, so when one of them refreshes, the other is signed out ("session expired"). Either stop using the CLI on that login, or prefer 4A, which creates a separate session.

### 4C. Claude account sign-in (paste the code)

1. Select **"اشتراك Claude"** (Claude subscription) and click **"تسجيل الدخول بحساب Claude"** (Sign in with Claude).
2. A new tab opens at `claude.ai`. Sign in and approve the request.
3. Claude shows you a code (it looks like `code#state`). Copy it.
4. Paste it into the code field in the panel and press **"إرسال الرمز"** (Submit the code).
5. The panel shows **"متصل"** (Connected), and the model list loads.

The code is single-use and expires like any authorization code. The extension opens the page itself, because that page's address carries the PKCE verifier, which never reaches the panel.

**Prefer an API key?** In the same Claude section, switch **"طريقة الدخول لـ Claude"** (Claude access) to **"مفتاح Anthropic API"** (Anthropic API key) and paste an `sk-ant-api…` key. That key is shared with the backup slot, like every other provider key.

### 4D. Grok account sign-in (device code)

1. Select **"اشتراك Grok"** (Grok subscription) and click **"تسجيل الدخول بحساب Grok"** (Sign in with Grok).
2. A new tab opens at `auth.x.ai`, and the panel shows a one-time code such as `ABCD-1234`.
3. Sign in to your SuperGrok / X Premium account in that tab, enter the code, and approve.
4. The panel shows **"متصل"** (Connected), and the model list loads.

> ⚠️ **Not verified yet.** The Grok account path has not been checked against a live SuperGrok / X Premium account. The transport is the one pi-ai uses for xAI, but no live account has been driven through it. An **xAI API key** works today, through the **xAI (Grok)** preset.

### 4E. MiniMax

Two presets, each with its own key:

| Preset | Key | Address | Default model |
|---|---|---|---|
| **MiniMax** | pay-as-you-go key | `https://api.minimax.io/v1` | `MiniMax-M3.1-Flash` |
| **MiniMax Coding Plan** | `sk-cp-…` key | `https://api.minimax.io/v1` | `MiniMax-M3.1-Flash` |

MiniMax always thinks, so its reasoning effort has no "Off" level. It serves no model list of its own, so the extension shows the fixed one above.
---

## 5. Choose the model and reasoning effort

After you connect, the model list loads automatically from your account (`/backend-api/codex/models` for ChatGPT, `/v1/models` for Claude, `/v1/models` for Grok). Exactly which models you see depends on your plan and on the provider.

1. **الموديل (Model):** pick one from the list. Press **↻** to reload it. If the list stays empty, type a model id you know from Codex into the text box.
2. **مستوى التفكير (Reasoning effort):** the options come from the selected model, for example `low` / `medium` / `high` / `xhigh`.
   - `low` / `medium`: faster and cheaper on your limits, and enough for most browsing.
   - `high` / `xhigh`: for multi-step research or tricky sites.
   - "افتراضي الموديل" uses the model's own default.
3. **General options:**
   - **أقصى عدد خطوات** (Max steps): default 40. One step is one browser action.
   - **لقطات الشاشة** (Screenshots): keep this on. Codex models accept images, which helps on visual pages.
   - **JavaScript**: leave this off unless you need precise data extraction. It gives the model full script access to pages.
4. Click **حفظ** (Save). The chip in the header shows `ChatGPT · <model> · <effort>`.

Leave **⚡ الطبقة السريعة** (fast layer) off for now. It needs a key for one of its decision providers (TypeSafe Jev, Vercel AI Gateway, OpenCode Zen or OpenRouter); a key already entered for the same provider elsewhere in the settings is reused. It is covered in the Arabic overview ([README.ar.md](README.ar.md)).

---

## 6. Run your first task

1. Open a normal website tab, e.g. `https://news.ycombinator.com`. Chrome blocks extensions on `chrome://` pages and the Web Store.
2. In the panel, type a task, for example:
   - `Summarise the top 5 stories on this page with their links`
   - `ابحث عن "best budget mechanical keyboard 2026" وقارن أول 3 نتايج في جدول`
3. Press **Enter**.

What happens next:

- Chrome shows a bar: **"Postora Browser Agent started debugging this browser."** This is expected. Clicks and typing go through the DevTools protocol, so sites see real input. Clicking **Cancel** on that bar stops browser control.
- Each step appears as a line (`✓ 3. click "index":12`). The model's reasoning summary shows in grey.
- Before paying, sending messages, deleting data or typing passwords, the agent **asks you**. Answer in the input box.
- When the task is done, a green **التقرير النهائي** (Final report) card shows the results and sources.
- **إيقاف** (Stop) cancels the task at any time. **＋** starts a new chat. Follow-up messages in the same chat keep the context.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Device-code login is not enabled" | See 4A, or use 4B. |
| "The sign-in was interrupted — start again" | The service worker restarted while the sign-in was waiting for you. Start the sign-in again; nothing was stored. |
| "The sign-in was cancelled" | You pressed Cancel. Start the sign-in again. |
| Claude asks for a code but nothing is shown | Open the tab the extension opened at `claude.ai`, approve, and copy the code it shows (`code#state`) into the panel. |
| "ChatGPT session expired, please sign in again" | The refresh token was revoked or rotated, often because the CLI shares it (see 4B). Sign in again with 4A. |
| `HTTP 403` from ChatGPT | Your plan has no Codex access, or OpenAI rejected this client. Check that Codex works for you in the official CLI or app. |
| "usage limit reached for this plan" (`HTTP 429`) | You hit your Codex limit. Wait for the reset or use a lower reasoning effort. |
| "Instructions are not valid" or a similar `400` | The extension already retries once with a different prompt layout. If it persists, OpenAI changed the backend; open an issue with the exact message. |
| Model list is empty | Press ↻. If it is still empty, type the model id manually. |
| "Chrome does not allow extensions to control chrome://…" | Navigate the tab to a normal `https://` site first. |
| Clicks land in the wrong place | Page zoom or layout shifted. The agent usually retries; you can tell it "take a screenshot first". |
| Nothing happens / panel frozen | Open `chrome://extensions` → Postora Browser Agent → **Inspect views: service worker** → Console, and read the error. Reload the extension. |

Logging out: Settings → **تسجيل خروج** (Log out). This deletes the stored tokens.

---

## 8. Security and privacy

- Tokens and API keys are stored in `chrome.storage.local` on your machine. They are **not encrypted**, so don't use this on a shared computer profile.
- The page text, element list and screenshots of the pages the agent works on are sent to the model provider you chose (OpenAI for a ChatGPT account, Anthropic for Claude, xAI for Grok).
- Page content is treated as untrusted (prompt-injection defense in the system prompt). That lowers the risk but does not remove it. Don't point the agent at sites where one wrong click can spend money without a confirmation step.
- The extension asks for broad permissions (`<all_urls>`, `debugger`, `tabs`, `scripting`) because it has to operate any site you choose.

---

## 9. Development

```bash
npm test          # unit tests (node:test), no install needed
npm install
npm run e2e       # loads the extension in Chromium with mock models
# If Playwright's Chromium is not installed:
CHROMIUM_PATH=/path/to/chrome npm run e2e
```

Project layout:

```
manifest.json                      MV3 manifest (side panel, debugger, <all_urls>)
src/background/service-worker.js   run coordination, panel messaging
src/background/account-login.js    the account sign-ins (ChatGPT, Claude, Grok)
src/agent/agent.js                 observe → decide → act loop
src/agent/tools.js                 tool schemas + implementations
src/agent/prompt.js                system prompt and safety rules
src/browser/controller.js          CDP input, scrolling, screenshots, tab handling
src/browser/page-scripts.js        injected DOM snapshot / element actions
src/providers/account-auth.js      one stored credential per account provider, with refresh
src/providers/chatgpt-auth.js      the auth.json import from the Codex CLI
src/providers/anthropic.js         Claude: Anthropic Messages API (account token or API key)
src/providers/responses.js         the Responses API (ChatGPT Codex backend, Grok account)
src/providers/chatgpt.js           Responses API on chatgpt.com/backend-api/codex
src/providers/openai-compatible.js Chat Completions (Grok, GLM, OpenAI, OpenRouter, MiniMax; Claude only through OpenRouter)
src/vendor/pi-oauth.js             pi-ai's OAuth login and refresh flows (MIT), bundled
src/fast/                          optional fast layer (Jev or a gateway chat model)
src/sidepanel/                     UI (Arabic RTL / English LTR, follows system theme) + safe Markdown renderer
icons/, _locales/                  logo + PNG icons (scripts/render-icons.mjs), translated store name
test/                              unit tests + e2e/run-e2e.mjs
```

The OAuth sign-in and refresh flows come from [pi-ai](https://github.com/earendil-works/pi) (MIT); see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). pi-ai is used for login and refresh only — no model call goes through it.

### Adding a provider (roadmap)

Every provider is a session object with three methods. `agent.js` never needs to change:

```js
session.addUserMessage(text, images)          // images: data URLs
session.addToolResult(callId, output, images)
await session.next({ signal, onEvent, toolChoice }) // → { text, toolCalls: [{ id, name, args }], usage }
```

To add one:

1. Implement the session in `src/providers/`.
2. Create it in `createSession()` in `service-worker.js`.
3. Add it to the provider list in settings and the panel.
4. Add unit tests with a stubbed `fetch`, like `test/chatgpt.test.js`.

---

## Roadmap

1. ✅ Direct account authentication: ChatGPT subscription (device code & auth.json fallback), Claude account sign-in (paste the code Claude shows after you approve), and Grok / SuperGrok account sign-in (device code).
2. ⏳ API key providers: Anthropic Claude API, xAI Grok API, Z.ai GLM (incl. Coding Plan), OpenAI API key, Google Gemini, OpenRouter, DeepSeek, NVIDIA NIM, MiniMax (pay-as-you-go and Coding Plan).
3. ⏳ Jev fast layer: tested end-to-end with a mock only.
4. ⏳ The Grok account path still needs a check against a live SuperGrok / X Premium account.
