# Privacy Policy — Postora Browser Agent

Last updated: 27 October 2026

Postora Browser Agent ("the extension") is an AI agent in Chrome's side panel. You give it a task, and it reads and operates the web pages needed to carry it out, then writes you a report. This policy explains what data the extension handles, where it goes, and how to delete it.

The extension has no server of its own. The developer does not receive your tasks, pages, keys or browsing data. The only data that reaches the developer is feedback you choose to send (see "Feedback").

## What data the extension handles

| Data | When | Where it goes |
|---|---|---|
| Your tasks and the agent's replies | Every task | Stored on your computer; sent to the AI provider you chose |
| Content of the pages the agent works on: address, title, visible text, the list of buttons and fields, and screenshots if you allow them | While a task runs, only for the tabs the agent controls | Sent to the AI provider you chose, so it can decide the next step |
| API keys and account sign-in tokens (ChatGPT, Claude, Grok, Kimi Code) you enter | When you save settings or finish sign-in | Stored on your computer; each key/token is sent only to its own provider |
| Settings | When you save them | Stored on your computer |
| Speech and its transcript | Only after voice listening is enabled | Chrome's Web Speech recognition service processes speech; the resulting command is sent to your selected execution provider |
| Google account name, email address and profile picture | Only if you sign in with Google (optional) | Stored on your computer; the picture is shown in the header |
| A backup of your settings, keys and account sign-in tokens | Only while signed in with Google | Your own Google Drive, in a hidden app folder only this extension can read |
| Feedback message, star rating, and an email address (one you type, or your Google email if signed in) | Only when you press Send in the feedback box, or give a task five stars | Sent to the developer by email through Formspree |

The extension does not collect analytics or telemetry, does not show ads, and does not track the pages you visit when no task is running.

## AI providers

To work, the extension sends your task and the content of the pages it is working on to the AI provider **you** select in settings. The available providers are OpenAI (API key or ChatGPT account), Anthropic Claude (Anthropic API key or Claude account), xAI Grok (xAI API key or Grok account), Google Gemini (API key), Kimi (Moonshot API key or eligible Kimi Code subscription), DeepSeek, NVIDIA, OpenRouter, OpenCode, Z.ai, MiniMax (pay-as-you-go or Coding Plan), and any compatible address you enter yourself. For the optional fast layer, they are TypeSafe, Vercel AI Gateway, OpenCode and OpenRouter. If you turn on a backup provider, it receives the same data when the main provider fails.

Named Gemini requests go directly to `generativelanguage.googleapis.com`. Kimi API-key requests use the international Moonshot service at `api.moonshot.ai`; subscription sign-in uses `auth.kimi.com` and subscription inference uses `api.kimi.com`. These credentials are not interchangeable, and the extension does not read consumer-site cookies or reuse Kimi chat sessions.

What each provider does with that data is governed by its own privacy policy and your agreement with it. Do not give the agent tasks on pages whose content you are not willing to share with your provider.

Account sign-ins are unofficial: they use the providers' own OAuth endpoints, not an official client of theirs.

## Google sign-in and Drive backup (optional)

Signing in uses Google's standard sign-in page and asks for your basic profile (name, email, picture), plus access to the extension's own hidden app folder in your Google Drive (`drive.appdata`). The extension cannot see any other file in your Drive.

The backup is stored without extra encryption and is protected by your Google account. To delete it, open Google Drive → Settings → Manage apps → Postora Browser Agent → Delete hidden app data. To stop backups, sign out from the account menu.

## Notifications (optional)

If you turn on "Notify me" in Settings, Chrome asks you to allow notifications. The extension then shows a desktop notification when a task finishes, needs your answer or stops with an error, only while you are on another tab. The notification says only that ("A task finished"); it contains no task, page or report text, and nothing is sent anywhere. Turning the switch off gives the permission back.

## Voice control (optional)

Voice control uses Chrome's Web Speech API, which may process audio through a remote speech service and requires an internet connection. The extension does not store audio recordings. "Keep listening" captures subsequent commands until you stop the microphone or leave the voice screen. Optional spoken replies use the browser's speech-synthesis service. Voice preferences are stored locally.

The Postora execution mode sends the transcript through the normal agent. Fast-only mode sends it and the necessary tab/element descriptions to the configured fast provider (and its backup if enabled), without consulting the main model. An observed tab or link address is reduced to its origin (scheme and host) before it reaches that provider: no username, path, query or fragment travels, and a link without a scheme is named only as a relative link. Titles remain visible, and an address you explicitly include in a command is part of that command's text and is used for the navigation as it was said. The voice activity list stays in the open panel; normal Postora tasks also enter the saved session.

Fast-only asks for confirmation before clicking, typing, submitting or closing a tab. Fields that hold a secret are left out of its element descriptions and typing actions: the rule is a list of names, in English and in Arabic, for passwords, one-time codes, safety codes, card numbers and card expiry, together with the browser's own password and card markers. It is a rule about names, so a field whose name says nothing about what it holds is not recognised.

The element that was approved is looked up again in the page and checked at the moment the input is sent: it must be the same element, still on the page, and not covered by something else. A key or a text goes out only while the focus is still the approved field and that field does not hold a secret, so a page that moved the focus to a password box gets nothing; a body that was approved is approved as that body, and a page that replaced the document does not inherit it. An element that was copied, replaced or covered never inherits the approval. The first click of an approved action may give the focus back to the approved field, and the point that is clicked is worked out again just before the click, so an element that had moved earlier can still be clicked.

## Feedback

Feedback is sent only when you submit it. It contains your message, the rating, the extension version and interface language, and an email address: one you type in the feedback box, or your Google email if you are signed in. It does not contain page content, tasks or keys. It is delivered to the developer by Formspree ([privacy policy](https://formspree.io/legal/privacy-policy/)).

## Other network requests

- To use an account sign-in (ChatGPT, Claude or Grok), the extension contacts the respective provider's sign-in and session services: OpenAI's Codex device-code and token endpoints, Anthropic's authorize page at `claude.ai` and its token endpoint at `platform.claude.com`, and xAI's device-code endpoints at `auth.x.ai`. It also reads the public version number of OpenAI's Codex CLI from the npm registry; no user data is sent in that request.
- The agent's "web search" step opens a Google search results page in the tab it controls, the same as you searching yourself.

## Data sharing and sale

Your data is not sold, not used for advertising, and not used for creditworthiness or lending. It is sent only to the services listed above, for the purposes listed above.

## Retention and deletion

- **On your computer:** sessions, settings and keys stay until you delete them. Delete a session from the session list, or remove the extension to erase everything it stored.
- **Google Drive backup:** stays until you delete it (see above).
- **Feedback emails:** kept by the developer for as long as they are useful for improving the extension. Ask to have yours deleted through the contact link below.
- **AI providers:** governed by each provider's own retention policy.

## Security

Keys and tokens are stored in the extension's local storage on your computer and sent only over HTTPS to the provider they belong to. A custom provider address you enter yourself may use plain HTTP, for example a local model on your own machine. The agent asks for your confirmation before payments, sending messages, deleting data or typing passwords.

The sign-in pages are opened by the extension itself, not by the panel, because the authorization address carries a PKCE verifier that must not reach the panel. No token, refresh token, API key or authorization code is ever logged, and never sent to the panel by the extension.

## Changes to this policy

If the extension's data practices change, this page will be updated and the date at the top will change. Significant changes will also be noted in the extension's release notes.

## Contact

Questions or deletion requests: open an issue at <https://github.com/lolotam/Browser-controle/issues>.
