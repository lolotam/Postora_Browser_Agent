# Engineering Manager Guidance & Policy Tracker

This document serves as the project's canonical engineering guidance, standing architectural policies, and review/optimization tracker.

---

## 1. Standing Policies & Directives

### 1.1 Waleed's Standing CI Optimization Instruction (Recorded: 2026-11-18)

- **Instruction Statement**:
  > "Inspect the actual workflow and critical path first. Start independent builds and browser checks as soon as their real prerequisites finish. Split slow independent test suites into isolated shards, preserving test coverage and failure propagation. Where multiple Docker targets exist, reuse the shared stage and start with at most two parallel builds after checking runner memory. Evaluate main-only staging image builds separately: document the loss of pre-merge coverage and obtain the project’s applicable approval before moving that check. Keep all required outcomes in the final merge gate and retain current release, deployment, security and freeze controls. Use a dedicated reviewed CI PR for workflow changes, separate from product work. Record why any technique does not apply. Measure wall-clock time to the required gate, aggregate runner minutes, failures/retries and any observed resource pressure. Save baseline run links now (aim for five comparable successful first-attempt code PR runs); compare with five after rollout, separating main, reruns and differing runner/cache conditions. Recheck after two weeks and give Waleed one before/after report with sample sizes, medians, absolute and percentage time change, and material cost/reliability tradeoffs. If volume is low, report the available sample and its limits. Put the due date and responsible owner in your existing project tracker. A frozen project may record the rule and defer execution until resumed."

- **Rule Location**: [`docs/CI-GUIDANCE.md`](file:///F:/Dev/Projects/Postora_Browser_Agent/docs/CI-GUIDANCE.md)
- **Applicability Audit & Technique Evaluation for Postora Browser Agent**:
  1. **Critical Path Inspection**:
     - Current CI workflow is defined in [`.github/workflows/ci.yml`](file:///F:/Dev/Projects/Postora_Browser_Agent/.github/workflows/ci.yml).
     - Job structure: A single linear job `test` (takes ~9m30s - 10m20s), followed by a conditional `release` job on `main` (takes ~15s - 25s).
     - Step timing breakdown (from run `44078358744`):
       - Setup & `npm ci`: ~10s
       - Windows speech runtime artifact install: ~1s
       - Unit tests (`npm test`, 1,210 tests): ~8s
       - Playwright Chromium install: ~21s
       - Unpackaged E2E tests (`npm run e2e`, 24 scenarios): ~4m33s
       - Store packaging (`npm run package`) & unpacking: ~1s
       - Packaged E2E tests (`npm run e2e`, 24 scenarios): ~4m48s
     - **Findings**: The critical path is dominated by two full sequential E2E test passes (~9m21s combined).
  2. **Start Independent Builds & Checks Early**:
     - *Applicable*: Packaging (`npm run package`) and Store Unpack only require code checkout and `npm ci`; they do not depend on the unpackaged E2E test run passing first.
     - *Optimization Opportunity*: Run unpackaged E2E and packaged E2E concurrently, or run packaging immediately after unit tests.
  3. **Split Slow Test Suites into Isolated Shards**:
     - *Applicable*: The E2E suite (`test/e2e/run-e2e.mjs`) contains 24 distinct scenarios. Sharding across 2 matrix runner jobs would drop critical path wall-clock time from ~10m down to ~5m30s.
  4. **Docker Targets & Staging Image Builds**:
     - *Does Not Apply*: Postora Browser Agent is a client-side Chrome Extension packaged as `.zip` artifacts for the Chrome Web Store and private distribution. There are no Dockerfiles, container targets, or staging container registries in the project.
  5. **Workflow Change Hygiene**:
     - All CI changes must land via a dedicated, reviewed pull request, separate from extension feature/product work, maintaining all test outcomes in the final required gate.

---

## 2. CI Optimization Tracker & Follow-up Schedule

| Task ID | Item | Responsible Owner | Due Date | Status |
| :--- | :--- | :--- | :--- | :--- |
| **CI-OPT-01** | Record Waleed's Standing CI Instruction & audit critical path | Antigravity / Engineering Manager | 2026-11-18 | **Completed** |
| **CI-OPT-02** | Dedicated CI PR: E2E sharding / packaging pipeline optimization | Antigravity / Core Team | 2026-11-20 | **Planned** |
| **CI-OPT-03** | 2-Week Post-Rollout Evaluation & Before/After Report to Waleed | Antigravity / Waleed Mohamed | **2026-12-02** | **Scheduled** |

---

## 3. Baseline Measurements (Pre-Rollout Sample)

The following 5 comparable successful first-attempt Pull Request code runs establish the pre-rollout baseline on Ubuntu runners:

| Run Link | PR | Commit | Wall-Clock Time | Aggregate Runner Min | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [Run #43691896201](https://github.com/lolotam/Postora_Browser_Agent/actions/runs/43691896201) | [#45](https://github.com/lolotam/Postora_Browser_Agent/pull/45) | `096edc2` | **8m 59s** (539s) | 9m | Success (first-attempt) |
| [Run #41991858095](https://github.com/lolotam/Postora_Browser_Agent/actions/runs/41991858095) | [#44](https://github.com/lolotam/Postora_Browser_Agent/pull/44) | `8e6c710` | **9m 21s** (561s) | 10m | Success (first-attempt) |
| [Run #40972479068](https://github.com/lolotam/Postora_Browser_Agent/actions/runs/40972479068) | [#43](https://github.com/lolotam/Postora_Browser_Agent/pull/43) | `916422d` | **10m 23s** (623s) | 11m | Success (first-attempt) |
| [Run #40803749973](https://github.com/lolotam/Postora_Browser_Agent/actions/runs/40803749973) | [#42](https://github.com/lolotam/Postora_Browser_Agent/pull/42) | `45bb928` | **10m 28s** (628s) | 11m | Success (first-attempt) |
| [Run #40798915000](https://github.com/lolotam/Postora_Browser_Agent/actions/runs/40798915000) | [#41](https://github.com/lolotam/Postora_Browser_Agent/pull/41) | `6067fa1` | **10m 16s** (616s) | 11m | Success (first-attempt) |

### Baseline Summary Statistics:
- **Sample Size ($N$)**: 5 successful first-attempt PR runs.
- **Median Wall-Clock Time**: **10m 16s** (616s).
- **Mean Wall-Clock Time**: **9m 53s** (593.4s).
- **Median Aggregate Runner Minutes**: **11 minutes**.
- **Resource Pressure / Bottleneck**: Sequential execution of unpackaged E2E (`~4m33s`) followed by packaged E2E (`~4m48s`) on a single runner core.
