# Privacy Policy — Postora Browser Agent

Last updated: 9 October 2026

Postora Browser Agent ("the extension") is an AI agent in Chrome's side panel. You give it a task, and it reads and operates the web pages needed to carry it out, then writes you a report. This policy explains what data the extension handles, where it goes, and how to delete it.

The extension has no server of its own. The developer does not receive your tasks, pages, keys or browsing data. The only data that reaches the developer is feedback you choose to send (see "Feedback").

## What data the extension handles

| Data | When | Where it goes |
|---|---|---|
| Your tasks and the agent's replies | Every task | Stored on your computer; sent to the AI provider you chose |
| Content of the pages the agent works on: address, title, visible text, the list of buttons and fields, and screenshots if you allow them | While a task runs, only for the tabs the agent controls | Sent to the AI provider you chose, so it can decide the next step |
| API keys and account sign-in tokens (ChatGPT, Claude, Grok) you enter | When you save settings | Stored on your computer; each key/token is sent only to its own provider |
| Settings | When you save them | Stored on your computer |
| Google account name, email address and profile picture | Only if you sign in with Google (optional) | Stored on your computer; the picture is shown in the header |
| A backup of your settings, keys and account sign-in tokens | Only while signed in with Google | Your own Google Drive, in a hidden app folder only this extension can read |
| Feedback message, star rating, and an email address (one you type, or your Google email if signed in) | Only when you press Send in the feedback box, or give a task five stars | Sent to the developer by email through Formspree |

The extension does not collect analytics or telemetry, does not show ads, and does not track the pages you visit when no task is running.

## AI providers

To work, the extension sends your task and the content of the pages it is working on to the AI provider **you** select in settings. The available providers are OpenAI (API key or ChatGPT account), Anthropic Claude (API key or Claude account), xAI Grok (API key or Grok account), Google Gemini, DeepSeek, NVIDIA, OpenRouter, OpenCode, Z.ai, and any compatible address you enter yourself. For the optional fast layer, they are TypeSafe, Vercel AI Gateway, OpenCode and OpenRouter. If you turn on a backup provider, it receives the same data when the main provider fails.

What each provider does with that data is governed by its own privacy policy and your agreement with it. Do not give the agent tasks on pages whose content you are not willing to share with your provider.

## Google sign-in and Drive backup (optional)

Signing in uses Google's standard sign-in page and asks for your basic profile (name, email, picture), plus access to the extension's own hidden app folder in your Google Drive (`drive.appdata`). The extension cannot see any other file in your Drive.

The backup is stored without extra encryption and is protected by your Google account. To delete it, open Google Drive → Settings → Manage apps → Postora Browser Agent → Delete hidden app data. To stop backups, sign out from the account menu.

## Notifications (optional)

If you turn on "Notify me" in Settings, Chrome asks you to allow notifications. The extension then shows a desktop notification when a task finishes, needs your answer or stops with an error, only while you are on another tab. The notification says only that ("A task finished"); it contains no task, page or report text, and nothing is sent anywhere. Turning the switch off gives the permission back.

## Feedback

Feedback is sent only when you submit it. It contains your message, the rating, the extension version and interface language, and an email address: one you type in the feedback box, or your Google email if you are signed in. It does not contain page content, tasks or keys. It is delivered to the developer by Formspree ([privacy policy](https://formspree.io/legal/privacy-policy/)).

## Other network requests

- To use an account sign-in (such as ChatGPT, Claude, or Grok), the extension contacts the respective provider's sign-in and session services. It also reads the public version number of OpenAI's Codex CLI from the npm registry; no user data is sent in that request.
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

## Changes to this policy

If the extension's data practices change, this page will be updated and the date at the top will change. Significant changes will also be noted in the extension's release notes.

## Contact

Questions or deletion requests: open an issue at <https://github.com/lolotam/Browser-controle/issues>.
