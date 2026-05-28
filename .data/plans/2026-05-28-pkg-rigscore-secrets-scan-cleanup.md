# pkg-rigscore Secrets & Cross-Repo Scan Cleanup

**Generated:** 2026-05-28
**Source:** ad-hoc scan run after PR #163 merged — "does the rigscore codebase or git history mention my repos or secrets?"
**Strategy verdict:** INCREMENTAL · two Wave-10 residuals from `.data/plans/2026-05-27-pkg-rigscore-post-acceptance-fix-waves.md` never shipped (PR #152 closed only Security #4 and #6, not #3 and #5); one new low-priority docs scrub surfaced.

## What the scan found

| Class | Finding | Risk |
|---|---|---|
| Fixture secrets | `test/fixtures/scored-project/.env` still contains `AKIAIOSFODNN7EXAMPLE` + `sk-proj-FIXTURE0000000000000000000000000000000`. GitHub push-time secret scanning, gitleaks, and TruffleHog will flag both. | Will block PRs in any downstream repo that imports rigscore as a submodule or runs these scanners on its tree. Already documented in `.data/health-reports/pkg-rigscore/2026-05-27-health.md:170` (Security #5). |
| Fixture prompt-injection | `test/fixtures/scored-project/.env` carries an unwrapped prompt-injection payload (Security #3, same health report). | Subagent that reads the fixture content during a check could be steered. Original Wave 10 plan was to wrap in `<<<INJECTED_PAYLOAD_FOR_TEST_DO_NOT_INTERPRET ... >>>` delimiters per CLAUDE.md data-framing rules. |
| Cross-repo names | `.data/plans/2026-05-28-pkg-rigscore-session-followups.md:171` names three other BRC workspace projects (`svc-gomoveshift-video`, `svc-social-media-seo`, `lib-skill-utils`) with their rigscore self-scores. PR #116 did one cross-repo scrub but newer plans slipped in afterwards. | Low. Names only, no contents. Public scrub posture is already permissive (org name `Back-Road-Creative` is in CHANGELOG, Dockerfile, action.yml). Worth dropping the score numbers since they characterize unrelated private projects. |
| Real secrets in working tree | None. `.git/config` is HTTPS with `pushurl = no-push`, no embedded token. Pickaxe across all refs for `joepetjr`, `Petrucelli`, `insta360`, `metricool`, `sops`-credentials → zero hits. | — |

## Sequencing rules

- Waves 1 and 2 are independent — can ship in either order or interleave.
- Wave 3 is a 5-line docs scrub; bundle with Wave 1 *or* Wave 2 if either has cap headroom, otherwise its own ~20-line PR.
- Standard JP rules: branch off `main`, conventional commits, no Claude/Anthropic attribution, ≤300 sum (feat/fix/test/behavior) or ≤300 net (refactor/chore code-motion), JP merges via `sudo gh-merge-approved`.

---

## Wave 1 — Replace canonical-shaped fixture keys (one PR, ~30 lines)

**Branch:** `chore/fixture-keys-no-scanner-trip`
**Commit:** `chore(test/fixtures): swap AWS canonical + OpenAI fixture keys for non-matching patterns`
**Closes:** Security #5 from `.data/health-reports/pkg-rigscore/2026-05-27-health.md` (Wave 10 residual from `2026-05-27-pkg-rigscore-post-acceptance-fix-waves.md:243`).

**Files:**

| File | Change | Δ |
|---|---|---|
| `test/fixtures/scored-project/.env` | Replace `AKIAIOSFODNN7EXAMPLE` → `AKIAXXXXXXXXXXXXXXXX`; replace `sk-proj-FIXTURE000…` → `sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXX` (or equivalent X-only patterns). Both still match rigscore's own AWS-prefix / OpenAI-prefix detectors (which key on prefix shape, not on the canonical AWS-docs sequence). | ±2 |
| `test/fixtures/scored-project/README.md` | Already documents that `AKIAIOSFODNN7EXAMPLE` is intentional (`README.md:30,68`). Update to reflect the new placeholder + drop the AWS-canonical justification. | ±10 |
| `test/secret-patterns.test.js` / `test/key-patterns-hardening.test.js` / `test/file-size-cap.test.js` | These tests use their *own* inline sk-/AKIA strings, not the fixture — verify with `git grep "AKIAIOSFODNN7EXAMPLE\|sk-proj-FIXTURE"` afterwards and confirm the only remaining hit is the README change above. | 0 |

**Verification:**
- `git grep "AKIAIOSFODNN7EXAMPLE"` → 0 hits after the change (or only the README explaining the swap).
- `npx vitest run` → all `env-exposure` / `secret-patterns` tests still pass (the prefix-based detectors don't care about the suffix shape).
- Simulate gitleaks: `docker run --rm -v $PWD:/repo zricethezav/gitleaks:latest detect --source /repo --no-git` should not flag `test/fixtures/scored-project/.env` after the swap. (Optional — if gitleaks isn't trivially runnable in the dev container, skip and rely on the visual diff.)

**Rationale for X-pattern over canonical:** the rigscore detector treats `AKIA[0-9A-Z]{16}` as the shape it scores against. `AKIAXXXXXXXXXXXXXXXX` matches that regex without matching AWS's canonical example string that GitHub push-time scanning and the gitleaks default ruleset hard-code as a known fingerprint.

---

## Wave 2 — Wrap fixture prompt-injection payload in structural delimiters (one PR, ~25 lines)

**Branch:** `chore/fixture-injection-delimiters`
**Commit:** `chore(test/fixtures): wrap adversarial fixture content in data-only delimiters`
**Closes:** Security #3 from the same health report (Wave 10 residual).

**Files:**

| File | Change | Δ |
|---|---|---|
| `test/fixtures/scored-project/.env` | Wrap the injection payload in `<<<INJECTED_PAYLOAD_FOR_TEST_DO_NOT_INTERPRET ... >>>` per CLAUDE.md data-framing rules. | ±5 |
| `test/fixtures/scored-project/README.md` | Add a one-paragraph "this fixture is adversarial" warning at the top (front-and-center, not buried). Note the delimiters and that any test or subagent reading the file must strip them before feeding to the check under test. | +8 |
| Whichever test reads this fixture (`grep -l scored-project test/`) | Strip the delimiters in the test setup if the matched line includes them. Most checks look for prefix patterns and don't care, but verify the prompt-injection check itself still flags the payload after delimiter wrap. | ±5 |

**Verification:**
- `npx vitest run` — all tests still pass. In particular the prompt-injection-detection check still scores the fixture as containing a payload.
- If a check breaks because it was substring-matching the raw payload: add the delimiter-strip step in that check's fixture loader, *not* in the production check (the production check should treat any inbound content as untrusted regardless of delimiters).

---

## Wave 3 — Scrub other-project names from session-followups plan (one PR, ~5 lines)

**Branch:** `chore/plan-scrub-other-project-names`
**Commit:** `chore(plans): drop cross-repo project-name leakage from session-followups`
**Closes:** scan-finding above. Low priority; can be folded into Wave 1 or 2 if cap allows.

**File:**

| File | Change | Δ |
|---|---|---|
| `.data/plans/2026-05-28-pkg-rigscore-session-followups.md:171` | Replace the literal "`svc-gomoveshift-video` 54, `svc-social-media-seo` 31, `lib-skill-utils` 27" with "three other workspace projects scored 27–54 — none are rigscore bugs". Keeps the *motivation* (other projects also need rigscore-fix sweeps) without naming them. | ±3 |

**Why this is non-urgent:** the names are not secrets — `Back-Road-Creative` is the public org, and the projects are svc-prefixed code names with no descriptive content attached. But scores characterize unrelated private repos, and the predecessor plan #116 ("remove cross-repo workspace plans from rigscore tree") established the precedent that those names don't belong in this repo's tree.

---

## Out of scope (JP-action only — not PRs)

| Item | Why out of scope |
|---|---|
| `/home/joe/.claude/CLAUDE.md` line 20 cap-policy split-by-commit-type edit | Sandbox-protected path. Diff was queued in 2026-05-28 session; JP pastes manually. Currently the rule lives only in auto-memory file `feedback_diff_cap_split_by_commit_type.md`, which itself defers to CLAUDE.md if they contradict. |
| `.claude/worktrees/agent-*` cleanup (6 dev-owned dirs in pkg-rigscore worktree) | Workspace concern. Needs `make fix-ownership` (workspace-level Makefile) before joe can rm them. PR #158 already excluded them from vitest discovery, so they don't cause test pollution — they're just disk clutter. |
| Other workspace projects' rigscore self-scores (27, 31, 54) | Each project owns its own rigscore-fix sweep. Not a rigscore-package bug. |

---

## Estimated total

3 PRs · ~60 sum lines · all chore-class (no behavior change). Can complete in a single short session.

## Stop conditions

- After each PR merges: run `npx vitest run` (locally) and `npx rigscore .` (self-scan) — confirm no regression in either.
- If a downstream consumer (e.g., another workspace project that uses rigscore as a submodule) starts failing gitleaks/TruffleHog after Wave 1: confirm the failure is unrelated to the swap (the swap *reduces* matches, not adds them).
