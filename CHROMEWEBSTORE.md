# Chrome Web Store Listing — Postora Browser Agent

> Last Updated: 2026-10-09

Everything to paste into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). Build the upload with `npm run package` (→ `dist/postora-browser-agent-v<version>.zip`) and refresh the screenshots with `npm run store-screenshots`.

## Store Listing

**Extension Name**
Postora Browser Agent
(Arabic listing: "Postora - وكيل المتصفح", which comes from `_locales/ar`.)

**Short Description** (from the manifest, 129 characters)
AI agent that works in your browser: it searches, clicks, types and collects information, then reports back. Use any AI provider.

**Detailed Description** (English)

```
Postora Browser Agent carries out tasks for you in your own Chrome browser and reports back with the results and their sources.

Describe a task in English or Arabic, for example "find the cheapest flight from Cairo to Dubai on 20 October and compare it with the direct flights". The agent opens the pages it needs, searches, clicks, types into forms, picks options, scrolls and switches tabs, one step at a time, then writes a final report.

What you get
• A side panel where you write tasks and follow every step as it happens.
• A live cursor on the page: you see where the agent points and clicks, what it is typing, and a Stop button.
• Final reports with tables and links to the pages the information came from.
• Several sessions that can run at the same time, each in its own labelled tab group.
• Your choice of AI provider: OpenAI (API key or ChatGPT account), Anthropic Claude (Claude account or Anthropic API key), xAI Grok (Grok account or xAI API key), MiniMax (pay-as-you-go or Coding Plan), Google Gemini, DeepSeek, NVIDIA, OpenRouter, OpenCode, Z.ai GLM, or any compatible address, including a model on your own computer.
• A backup provider that takes over the same task if your main provider stops (plan used up, key rejected, server down).
• An optional fast layer that handles obvious steps quickly and hands anything uncertain to the main model.
• Arabic and English interface, light and dark themes.

How to use it
1. Click the toolbar icon to open the side panel.
2. Open Settings, choose your AI provider, enter your key (or sign in to your ChatGPT, Claude or Grok account — ChatGPT and Grok show a one-time device code, Claude shows a code after you approve that you paste back), pick a model, and press "Test connection".
3. Go to the page where the task should start, type the task, and press Enter.
4. Watch the steps, answer the agent if it asks you something, and read the final report.

Safety and privacy
The agent asks for your confirmation before purchases, payments, sending messages, deleting data or entering passwords. It acts only in the tabs of its own session and only while a task is running. Page content goes only to the AI provider you choose. The extension has no server of its own, no analytics and no ads. While the agent works, Chrome shows a "started debugging this browser" bar; this is how its clicks and typing reach the page.

Account sign-ins are unofficial: the extension talks to the providers' own OAuth endpoints, the way a third-party client does. Providers may change or block them at any time.

Support
Questions and bug reports: https://github.com/lolotam/Browser-controle/issues
```

**Detailed Description** (Arabic, for the Arabic listing)

```
Postora - وكيل المتصفح ينفّذ المهام بدلًا منك في متصفح Chrome الخاص بك، ثم يكتب لك تقريرًا بالنتائج ومصادرها.

اكتب المهمة بالعربية أو الإنجليزية، مثلًا: "ابحث عن أرخص رحلة من القاهرة إلى دبي يوم 20 أكتوبر وقارنها بالرحلات المباشرة". يفتح الوكيل الصفحات اللازمة، ويبحث، ويضغط، ويكتب في النماذج، ويختار من القوائم، وينتقل بين التبويبات خطوة بخطوة، ثم يكتب تقريرًا نهائيًا.

المزايا
• لوحة جانبية تكتب فيها المهمة وتتابع كل خطوة لحظة بلحظة.
• مؤشر حي على الصفحة: ترى أين يشير الوكيل وأين يضغط وماذا يكتب، مع زر إيقاف.
• تقارير نهائية فيها جداول وروابط للصفحات التي جاءت منها المعلومات.
• عدة جلسات تعمل في نفس الوقت، كل جلسة في مجموعة تبويبات باسمها.
• تختار مزوّد الذكاء: OpenAI (مفتاح API أو حساب ChatGPT)، وAnthropic Claude (حساب Claude أو مفتاح Anthropic API)، وxAI Grok (حساب Grok أو مفتاح xAI API)، وMiniMax (الدفع حسب الاستخدام أو Coding Plan)، وGoogle Gemini، وDeepSeek، وNVIDIA، وOpenRouter، وOpenCode، وZ.ai GLM، أو أي عنوان متوافق، حتى نموذج يعمل على جهازك.
• مزوّد احتياطي يكمل المهمة نفسها إذا توقف المزوّد الأساسي.
• طبقة سريعة اختيارية تنفّذ الخطوات الواضحة بسرعة وتترك غير الواضح للموديل الأساسي.
• واجهة عربية وإنجليزية، ووضع فاتح وداكن.

طريقة الاستخدام
1. اضغط أيقونة الإضافة لفتح اللوحة الجانبية.
2. افتح الإعدادات، واختر مزوّد الذكاء، وأدخل المفتاح (أو سجّل الدخول بحساب ChatGPT أو Claude أو Grok — يعرض ChatGPT وGrok رمزًا مؤقتًا، ويعرض Claude رمزًا بعد الموافقة فتلصقه في اللوحة)، واختر الموديل، ثم اضغط "اختبار الاتصال".
3. افتح الصفحة التي تبدأ منها المهمة، واكتب المهمة، واضغط Enter.
4. تابع الخطوات، وأجب الوكيل إن سألك، واقرأ التقرير النهائي.

الأمان والخصوصية
يطلب الوكيل موافقتك قبل الشراء أو الدفع أو إرسال الرسائل أو حذف البيانات أو كتابة كلمات المرور. ولا يعمل إلا في تبويبات جلسته وأثناء تنفيذ المهمة فقط. ويذهب محتوى الصفحات إلى مزوّد الذكاء الذي تختاره وحده. لا يوجد خادم خاص بالإضافة، ولا تحليلات، ولا إعلانات.

تسجيل دخول الحسابات غير رسمي: تتحدث الإضافة مع نقاط OAuth الخاصة بالمزوّد نفسه، كما يفعل أي عميل من طرف ثالث، وأي مزوّد قد يغيّرها أو يمنعها في أي وقت.
```

**Category**
Productivity → Workflow & Planning

**Single Purpose**
Carries out web tasks the user describes, by operating pages in the user's browser and reporting the results.

**Primary Language**
English (with an Arabic translation)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1: task running, live cursor clicking | 1280×800 | ✅ Ready | `store-assets/screenshot-1-working.png` |
| Screenshot 2: final report | 1280×800 | ✅ Ready | `store-assets/screenshot-2-report.png` |
| Screenshot 3: settings | 1280×800 | ✅ Ready | `store-assets/screenshot-3-settings.png` |
| Small Promo Tile | 440×280 | ✅ Ready | `store-assets/promo-small-440x280.png` |
| Marquee Promo Tile | 1400×560 | ⬜ Optional, not created | |

The screenshots come from the packaged build running against a local demo page, so they match what is uploaded.

## Permissions Justification

Paste each line into the matching field of the dashboard's Privacy tab.

| Permission | Type | Justification |
|------------|------|---------------|
| `sidePanel` | permissions | The whole interface (task box, live steps, final report, settings) is a side panel that stays open next to the page the agent is working on. |
| `debugger` | permissions | The agent clicks, types and presses keys as trusted input, which many sites require (they ignore synthetic DOM events), and takes screenshots of the tab it controls so a vision model can see the layout. It attaches only to the tabs in the running session's tab group, only while a task runs, and detaches when the task ends. Chrome shows its standard "started debugging this browser" bar meanwhile. |
| `scripting` | permissions | Injects small functions into the controlled tab to read the page (address, title, visible text, the list of buttons and fields) and to draw the on-page cursor and Stop button. Nothing runs in tabs the agent is not working on. |
| `tabs` | permissions | Reads the address and title of the tab a task starts on and of the session's tabs, lists tabs for the agent's tab switching, opens and closes tabs the agent uses, and follows which tab is in front so the panel shows that tab's session. |
| `tabGroups` | permissions | Each session's tabs are put in a tab group named after the session, so parallel sessions never act on each other's tabs and the user can see which agent works where. |
| `storage` | permissions | Saves settings, API keys and sessions (tasks, steps, reports) on the user's computer. |
| `unlimitedStorage` | permissions | Session histories with screenshots can exceed the default 10 MB local quota; without it, saving long sessions would fail. |
| `identity` | permissions | Optional Google sign-in: shows the user's name and picture in the header, attaches their email to feedback they send, and backs up their settings to their own Google Drive app folder. |
| `declarativeNetRequestWithHostAccess` | permissions | Adjusts headers only on the extension's own requests: it removes the Origin header from the sign-in endpoints that reject one (OpenAI's `auth.openai.com` and `chatgpt.com/backend-api/codex`, Anthropic's `platform.claude.com` and `claude.ai`, xAI's `auth.x.ai`), and sets the Claude Code User-Agent that `api.anthropic.com` expects. The rules are limited to requests the extension itself starts (`initiatorDomains` = this extension) and never touch the user's browsing. |
| `notifications` | optional_permissions | Asked for only when the user turns on "Notify me" in Settings, and given back when they turn it off. Shows a desktop notification when a task finishes, needs the user's answer or stops with an error, only while the user is on another tab. The text is generic ("A task finished"): no task, page or report content. |
| `<all_urls>` | host_permissions | The user can ask the agent to work on any website, so it must be able to read and operate whichever site the task needs. Host access also lets the extension call the AI provider address the user chooses, including a custom or local one (for example `http://localhost:11434`). Access is used only for tabs in the running session and for the chosen provider. |

**Remote code:** No. All code ships in the package, and the store package has no way to run code it did not ship: `npm run package` builds it without the development build's "run JavaScript" tool (the tool, its handler, its prompt line, its settings switch and `Runtime.evaluate` are all left out, and the package tests check that). The agent acts on pages only through fixed tools: clicks, typing, scrolling and reading. This removes a review risk; it does not by itself guarantee approval, since the `debugger` permission is reviewed on its own merits.

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes. Data goes only to services the user chooses; there is no developer server.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | Yes (optional) | Yes | Google name, email and picture for sign-in; email attached to feedback | Google (sign-in), Formspree (feedback delivery) |
| Health info | No | | | |
| Financial info | No | | | |
| Authentication info | Yes | Yes | The user's AI provider keys and account tokens (ChatGPT, Claude, Grok), each sent only to its own provider; included in the user's own Drive backup | Only the provider each key belongs to; Google Drive (the user's own backup) |
| Personal communications | No | | | |
| Location | No | | | |
| Web history | Yes | Yes | Addresses of the pages the agent visits during a task, sent to the AI provider as context | The user's chosen AI provider |
| User activity | No | | | |
| Website content | Yes | Yes | Text, element lists and screenshots of the pages the agent works on, sent to the AI provider to decide the next step | The user's chosen AI provider |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL:** https://github.com/lolotam/Browser-controle/blob/main/docs/privacy.md
(Live once this branch is merged into `main`. Check that the link opens before submitting.)

## Distribution

**Visibility**: Public. Choose Unlisted first if you want testers before it is searchable.
**Regions**: All regions

## Developer Info

**Publisher Name**: (the name on your Chrome Web Store developer account)
**Contact Email**: (verified in the developer account; shown publicly)
**Support URL**: https://github.com/lolotam/Browser-controle/issues
**Homepage URL**: https://github.com/lolotam/Browser-controle

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-10-09 | First store release | Draft |
| 0.2.0 | 2026-10-11 | Retries on rate limits and overloads, page dates, text-written tool calls; session notebook and autocomplete picking; time and tokens per step; optional notifications; tested free setup; store build without the run-JavaScript tool | Draft |
| 0.3.0 | Unreleased | Account sign-in for ChatGPT, Claude and Grok through pi-ai (device code, pasted code); an Anthropic provider; MiniMax presets; per-provider settings and keys; account sign-ins in the backup | Draft |

## Review Notes

### Before the first upload
1. **Developer account:** register at the dashboard (one-time US$5 fee) and verify the contact email.
2. **Google sign-in:** the store assigns a new extension ID, so add `https://<store-id>.chromiumapp.org/` to the OAuth client's authorized redirect URIs in Google Cloud. Then replace the manifest `key` with the store item's public key (Dashboard → Package → View public key), so unpacked development builds share the store ID. Also enable the Google Drive API for the project, and publish the OAuth consent screen with the `drive.appdata` scope (Google may ask to verify the app).
3. **Privacy policy link** must be live (merge this branch).

### Known Issues / Limitations (review risks)
- **`debugger` + `<all_urls>`** puts the item in in-depth review, which can take longer than usual. The justifications above explain both.
- **Account sign-ins (ChatGPT, Claude, Grok)** connect directly to the respective providers' OAuth endpoints. Providers may change or block them, and the listing describes them neutrally without claiming official endorsement. The Grok account path has not been verified against a live SuperGrok / X Premium account yet; the xAI API key path works.
- Trademarks (OpenAI, ChatGPT, Anthropic, Claude, Gemini, Grok…) appear only to name the providers the user can connect, not in the extension name or icon.

### Rejection History
(none yet)
