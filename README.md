# Postora Browser Agent — AI agent that operates your Chrome

A Chrome side-panel extension. Give it a task in Arabic or English and it carries it out in your real browser, one step at a time: it searches, clicks, types, picks from menus, scrolls, switches tabs, and reads and collects information. When it finishes, it returns a **final report** with the results and sources.

**Model access & auth:** sign in with a ChatGPT, Claude, Grok or eligible Kimi Code account, or use an API key.

| Provider | How you connect |
|---|---|
| **ChatGPT** (Plus / Pro / Business) | Account sign-in with a **device code**: the panel shows a one-time code you type on OpenAI's activation page. An `auth.json` from the Codex CLI can be imported instead. |
| **Claude** (Pro / Max) | Account sign-in by **pasting the code Claude shows after you approve**: the extension opens claude.ai, you approve, and you paste the code back into the panel. An **Anthropic API key** works too. |
| **Grok** (SuperGrok / X Premium) | Account sign-in with a **device code** at `auth.x.ai`. An **xAI API key** works too, through the xAI preset. |
| **MiniMax** | API key: the **pay-as-you-go** preset or the **Coding Plan** preset (`sk-cp-…` keys), each with its own key. |
| **Google Gemini** | Select **Google Gemini — API key** and use a [Google AI Studio key](https://aistudio.google.com/apikey). Catalog and execution use Google's documented OpenAI-compatible API directly. Existing Gemini presets keep working. |
| **Kimi** | Select **Moonshot API** for an international [Platform API key](https://platform.kimi.ai/console/api-keys), or **Kimi Code account** for subscription device sign-in. These are different products/billing scopes; ordinary Kimi chat sessions are not API credentials. Code is for eligible programming use, with account/region restrictions. |
| OpenAI, DeepSeek, NVIDIA NIM, OpenRouter, OpenCode, Z.ai GLM | API key (OpenAI-compatible). |

You choose the model, the auth method, and the reasoning effort.

👉 **[Full setup guide → docs/SETUP.md](docs/SETUP.md)** · Arabic overview: [docs/README.ar.md](docs/README.ar.md)

## Quick start

1. Clone the repo:
   ```bash
   git clone https://github.com/lolotam/Browser-controle.git
   ```
2. In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the repo folder.
3. Open the side panel (**Alt+Shift+A**) and connect your provider (sign in with a ChatGPT, Claude or Grok account, or enter an API key).
4. Pick a model and a reasoning effort, then click **Save**.
5. Open any website and type a task.

## Features

- **Trusted input:** clicks and keystrokes go through the Chrome DevTools Protocol, so they work on sites that ignore synthetic events.
- **Live cursor:** while a task runs, the page shows the agent's cursor gliding to each target and rippling on clicks, a caption saying what it is doing, a highlight on the element it acts on, and a glowing frame with a Stop button. It is hidden from the screenshots the model sees, and can be turned off in settings.
- **Page understanding:** numbered interactive elements (including inside shadow DOM), visible text, and screenshots for vision-capable models.
- **Tools:** navigate, search, click, type, press keys, select options, hover, scroll, read long pages, history, and tab management. JavaScript extraction is optional.
- **Safety:** the agent must ask you before payments, sending messages, deleting data or typing passwords. Page text is treated as untrusted.
- **Optional fast layer:** a ⚡ layer can run confident steps without calling the main LLM. It uses TypeSafe's Jev decision model, directly or through Vercel AI Gateway/OpenRouter, or a JSON chat judge on OpenCode Zen. Zen defaults to the paid `glm-5.3-flash` chat model with a more conservative probability threshold; explicitly selected `jev-*` models still use System One. Both primary and backup slots support this choice. Chat probabilities are model estimates, not Jev's calibrated scores. It is experimental.
- **Fast-layer access failures:** a 403 or disabled model is skipped for the current task with one warning. A configured fast backup is tried; otherwise the normal agent continues with its main model. Fast-only voice reports the failure without claiming success or bypassing permissions. Correct the provider/model access in settings before retrying.
- **Access control:** Full access still requires explicit warning acknowledgement and worker confirmation. Once active, the composer control is red; its risk text is available on hover and to screen readers, not as a persistent paragraph.
- **Backup providers:** if the main model's provider fails (plan or quota used up, key rejected, server error, no connection), a backup provider finishes the same task from where it stopped; the fast layer has its own backup decision provider. A red or amber notice under the header says what failed and who took over.
- **Test connection everywhere:** the main model, its backup, the fast layer and its backup each have a test button that sends a real request with the task's tools and settings, so a wrong key or a model without tool calls shows up before the first task. OpenRouter's list only offers models that support tool calls.
- **Optional Google sign-in:** the header's account button opens a Google sign-in window; the extension keeps only the name, email and picture, shows the picture in the header, and sends the email with feedback. While signed in, settings, API keys and account sign-in tokens (ChatGPT, Claude, Grok, Kimi Code) are backed up after every change to a hidden folder of the user's own Google Drive (`appDataFolder`), and a fresh install restores them at sign-in. **Back up now** always writes the current backup again, even when unchanged, and shows a green timestamped confirmation or the actual failure in red. Automatic unchanged backups remain deduplicated. No backend or client secret is involved.
- **One API key per provider:** a key entered for one provider is reused by the backup slot and the fast layer whenever they pick the same provider. The Anthropic key is shared by the main Claude slot and the one of its backup.
- **Sessions:** several sessions, saved on your computer, with search, rename and delete. Sessions can run tasks at the same time; each works only in its own Chrome tab group and never brings a tab to the front. The side panel follows the tab in front: a new tab starts on a blank session, and a tab where a task ran (or that the user picked a session for) keeps its session.
- **Interface:** Arabic or English, light or dark following the system. The agent replies in the language of the task, or always in a language you switch on in settings. Settings can be backed up to a file and restored after reinstalling.
- **Voice control:** click the composer microphone (or press **Alt+Shift+V** while the panel is focused) to open the voice screen: live transcript, continuous listening, optional spoken replies, typed commands and an activity log. **Back to chat** stops capture. Settings selects the existing Postora agent (default) or the configured fast provider alone. Fast-only asks before clicks, typing, submitting or closing tabs and refuses secret fields. If Chrome needs microphone permission, a separate window opens; commands remain targeted at the original browser tab.

## Privacy

The extension has no server of its own: tasks and page content go only to the AI provider you choose. See the [privacy policy](docs/privacy.md).

## Status

| Part | State |
|---|---|
| Browser control + agent loop | ✅ Covered by unit tests and a Chromium end-to-end test (mock model) |
| Account authentication (ChatGPT, Claude, Grok subscriptions) | 🟡 ChatGPT by device code, Claude by pasting the code Claude shows after you approve, Grok by device code. The **Grok account path is not yet verified against a live account** — the transport is pi-ai's, but no live SuperGrok/X Premium account has been driven through it yet. |
| Claude provider (Anthropic Messages API, account token or API key) | ✅ Unit tested against the real request and stream shapes |
| MiniMax (pay-as-you-go and Coding Plan) | ✅ Unit tested; the model list is a fixed one, as MiniMax serves no `/models` |
| Named Gemini API, Moonshot API and Kimi Code account | 🟡 Unit and Chromium integration tests use synthetic HTTP/credentials. Real Gemini/Moonshot key access and Kimi Code account entitlement/refresh are **not live-verified**. Kimi OAuth is pinned to `auth.kimi.com`, with inference at `api.kimi.com/coding/v1`; tokens are not silently moved to `.ai` or Moonshot. |
| Other providers & API keys (Gemini, Grok, DeepSeek, NVIDIA NIM, GLM, OpenAI API, OpenRouter) | ⏳ Code exists; model lists checked live where they are public (NVIDIA, OpenRouter); configurable with API keys |
| Fast layer (Jev or a gateway chat model) | ⏳ Experimental, tested with mocks only |
| Manual Google Drive backup | ✅ Forced writes, unchanged-content deduplication for automatic backups, timestamp/error feedback, expired sessions and deleted-file recovery covered with synthetic Drive HTTP and browser tests; no live Drive account was used for these regressions. |

### Gemini and Zen troubleshooting

- **Gemini catalog:** entering, replacing or signing out a shared Google key refreshes/clears the active catalogs without switching provider or saving first. Specialized image, audio/live, embedding and video models are not offered as browser-agent chat models.
- **Gemini requests:** named and legacy Gemini configurations use a conservative OpenAI-compatible profile: optional `stream_options` is omitted, function schemas are normalized without dropping browser tools, and existing image/tool thought signatures remain intact. Usage is still read if Google sends it. A connection test requests text only while retaining all task schemas, fails on an empty answer, and has a 45-second deadline. Task idle timeout remains 180 seconds; a timeout now says whether response headers or stream data were missing. Thought-only SSE events refresh the idle deadline, and Stop interrupts a blocked body read.
- **Zen access:** the [official model list](https://opencode.ai/v2/docs/console/models/) still documents Jev. A listed model is not proof that your key/workspace may use it: enable it in the workspace, check billing/entitlement, or explicitly choose an available paid chat model. Free-tier chat is restricted to OpenCode itself; the extension does not impersonate OpenCode or bypass a 403. Existing saved Jev configurations are not silently replaced with a billable model. See the [current inference endpoints](https://opencode.ai/v2/docs/console/api/inference/).
- **Verification limits:** the public Zen catalog and provider documentation were inspected live, but inference regressions use synthetic HTTP. No live Gemini or Zen key was available to reproduce account-specific latency or access. Google's [compatibility documentation](https://ai.google.dev/gemini-api/docs/openai) advertises usage streaming; omitting it is a conservative mitigation of the reported idle stall, not a claim that every Google endpoint rejects it.

> Using provider account plans or subscriptions outside official apps is unofficial. Providers may change or block endpoints at any time.

## Development

```bash
npm test                  # unit tests
npm install && npm run e2e
```

The checkout uses LF line endings on every platform, so a test that reads a
source file sees the same bytes CI sees. A clone made before this rule holds
CRLF on Windows; normalize it once with:

```bash
git rm --cached -r . && git reset --hard
```

The OAuth sign-in and refresh flows come from [pi-ai](https://github.com/earendil-works/pi) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
