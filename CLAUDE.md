# CLAUDE.md

Postora Browser Agent: a Chrome extension (Manifest V3) that runs a browser
automation agent from a side panel, with voice control, a fast decision layer,
and an optional private Windows native host for PowerShell and offline speech.

Key gates (all remain mandatory for code changes):

- `npm test` — unit tests (node:test).
- `npm run e2e` — browser end-to-end scenarios (Playwright Chromium).
- `npm run package` and `npm run package:private` — store artifact and private
  artifact (no native messaging in the store artifact, no weights or secrets).
- CI on the exact PR head: see [docs/CI-GUIDANCE.md](docs/CI-GUIDANCE.md).
- Nemotron/Whisper model downloads are user-initiated only; never download the
  Nemotron model or claim a real bilingual smoke without Waleed's approval.

Details and project rules live in [AGENTS.md](AGENTS.md) and `docs/`.

## Delivery tiers (Light / Medium / Heavy Implementation Pipeline)

Owner decision — Waleed Mohamed, 2026-11-19 23:05 Kuwait (verbatim): «ابعت بقي
ملفات وخطة ال3 pip lines دي لكل المديرين علشان يسجلوها وينفزوها كقاعدة عنهم في
كل الشغل ويعملولها merg علطول بدون مراجعة light task كاضافة وثائق في ملفات
المشاريع cladue.md file and agent file» (reference: PosPay PP-195,
lolotam/PayPos.systems#1085).

1. **Tier card before every new task** (side tasks and follow-up issues too): an
   AskUserQuestion card to Waleed, in Arabic, with 3 options, recommended first
   and marked «(المقترح)»: the tier, the recommendation, a one-line reason, and
   an exception option (an extra review/step on top). Do not start before his
   answer. Fix rounds inside a running task need no new card. Production,
   server, secrets and HOLD decisions stay Waleed's.
2. **LIGHT**: docs, specs, plans, ADRs, roadmap/status files, i18n, small
   CSS/UI changes up to ~150 lines. Never money, permissions/auth,
   DB/migrations, API, or a new dependency. Implementer: manager or GLM, then
   Claude Sonnet. PR merges immediately on green CI, no review-bot wait. No own
   staging deploy (ships with the next deploy).
3. **MEDIUM**: at most 3 review rounds; local review plus the project's review
   bots (skip a bot stuck more than 1 hour and say so in the merge report); CI
   green on the exact head. After round 3, P2/P3 findings become issues; P0/P1
   block. Staging deploys happen in daily batches.
4. **HEAVY** (migrations, money, permissions/auth, security, long background
   jobs): Claude Fable 5.2 (medium) writes the implementation plan, Codex Astra
   6.2 (medium) debates it ONE round before implementation; full review + CI
   with the project's round cap. A PR with migration, money or permissions/auth
   merges ONLY after Waleed's card approval (after all gates). Other Heavy
   work: the manager merges after all gates. Staging deploy alone right after
   merge; DB snapshot first if there is a migration, with a receipt.
5. **Implementer fallback, fixed order, no asking between lanes**: Light =
   manager/GLM → Claude Sonnet. Medium & Heavy = Kimi → MiniMax → GLM → Grok →
   Claude Sonnet (Heavy on Sonnet at high effort). After 2 failures or an
   exhausted quota, move to the next lane. Lanes in this project: Kimi (Kimi
   CLI), MiniMax (MiniMax Code CLI), GLM (Z.ai ZCode CLI), Grok (Grok CLI),
   Claude Sonnet (Claude Code CLI), Codex (Codex CLI).
6. **Plan summary after every merge**, in 3 parts: «ما تم» (main tasks done +
   PR numbers), «الباقي» (each remaining main task with its sub-tasks and
   status), «التوصية». Side tasks fold under their main task; keep any
   roadmap/status file in sync. End every report with these headings exactly:
   «المطلوب منك»، «الخطوة الجاية اللي أنصح بيها»، «ملاحظة» (write «مفيش» if
   none).

The tiers add a review/merge/deploy policy; every existing project gate above
stays in force unless a tier explicitly replaces it.
