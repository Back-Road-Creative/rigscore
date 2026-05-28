# pkg-rigscore Session Follow-Ups (post 2026-05-27 fix-waves)

**Generated:** 2026-05-28
**Source:** issues surfaced during execution of `.data/plans/2026-05-27-pkg-rigscore-post-acceptance-fix-waves.md` (PRs #137-#157) that weren't in the original health report.
**Strategy verdict:** INCREMENTAL · most items are workflow/infra polish, two are real correctness gaps.

## Why this plan exists

Executing the post-acceptance plan over ~17 PRs surfaced operational friction and a small number of genuine project gaps that weren't visible from the static health-check. Each item below has a verifiable trigger (file + line, or reproducible command) — no "we should think about X" entries.

Scope discipline: rigscore-actionable items only. Cross-project issues (workspace cron, devcontainer ownership, other projects' scores) are noted in `## Out of scope` so they don't get sucked into this plan.

## Sequencing rules

- Wave 1 ships first (mechanical, blocking — every future `npx vitest run` is 3× slower without it).
- Wave 2-5 are independent and can interleave / parallelize via subagent worktrees.
- Wave 6 is a *decision*, not code — a 5-minute call from JP, not a PR.
- Same JP rules as before: branch off `main`, ≤300 sum, conventional commits, no Claude/Anthropic attribution, JP merges manually.

---

## Wave 1 — vitest ignores `.claude/worktrees/**` (one PR, ~10 lines)

**Branch:** `fix/vitest-exclude-agent-worktrees`
**Commit:** `fix(vitest): exclude .claude/worktrees/** from test discovery`
**Closes:** session-observed issue — vitest pulls in every parallel-agent worktree's `test/*.test.js`.

**Reproducer (before fix):**
```
$ ls .claude/worktrees/ | wc -l    # any non-zero
$ npx vitest run test/site-security
```
You'll see `.claude/worktrees/agent-X/test/site-security.test.js (4 tests)` lines duplicated per worktree.

**The fix:**
Create or extend `vitest.config.js` with:
```js
test: { exclude: ['.claude/worktrees/**', 'node_modules/**', 'dist/**'] }
```
(Or whatever the current shape is — check `vitest.config.js` first; it already loads, just doesn't have an explicit `exclude`.)

**Why this is Wave 1:** during the post-acceptance session, every test invocation needed `--exclude '.claude/**'` manually. Easy to forget; one missed exclusion makes the dogfood test fixture-clash with 6 worktree clones and run 6× the tests. Permanent fix lives in one config line.

**Test plan:**
- `npx vitest run` after creating at least one agent worktree — assert it runs once, not N+1 times
- `npx vitest run` against an empty `.claude/` (default state) — no behavior change
- `make test` (if it exists) honors the exclusion

---

## Wave 2 — regression test for "rigscore's own .gitignore doesn't shadow fixture detection" (one PR, ~50 lines)

**Branch:** `test/fixture-gitignore-isolation`
**Commit:** `test(fixture-dogfood): assert rigscore's own .gitignore doesn't shadow env-exposure fixtures`
**Closes:** session-observed issue — PR #145 went CI red across 6 jobs because unanchored `.env` in root `.gitignore` cascaded to `test/fixtures/env-exposed/.env` via `git check-ignore`'s parent-chain lookup. Fix was anchoring to `/.env` (PR #152), but there's no test pinning that invariant.

**The fix:**
New test file `test/fixture-gitignore-isolation.test.js`. For each `.env` under `test/fixtures/`, run `git check-ignore --no-index <path>` from the repo root and assert it reports the file as NOT ignored. Use a small data-driven loop so any new fixture .env automatically gets covered.

Mirror pattern: `test/error-handling.test.js` already uses `spawnSync` against the bin.

**Why this matters:** the .env-pattern-cascading bug took an hour to root-cause because the failure looked like an env-exposure check change, not a gitignore change. A direct test would have failed before the PR shipped.

**Watch:** this test will fail if a future fixture .env is added with the wrong relative path or if someone re-introduces an unanchored `.env` to root `.gitignore`. That's the contract.

---

## Wave 3 — `.data/health-reports/` policy decision + .gitignore (one PR, ~10 lines)

**Branch:** `chore/data-health-reports-policy`
**Commit:** `chore(repo): track .data/health-reports/ or ignore — pick one`
**Closes:** session-observed issue — `.data/health-reports/pkg-rigscore/2026-05-27-health.md` is joe-owned (created by `python3 ~/.claude/skill-utils/health-check.py`), untracked, and surfaces as a permission-denied warning on every `git checkout` between branches. Also referenced by the post-acceptance plan but never committed.

**The decision (1 question, then 1 PR):**
Either:
(a) Track health-reports in git (they're the source of truth that plans reference) → add nothing to gitignore; commit existing reports as a separate dedicated PR.
(b) Treat them as ephemeral artifacts → add `.data/health-reports/` to `.gitignore`; have the health-check skill write to `~/.cache/rigscore-health-reports/` instead.

Recommend **(a)** — plans already reference them by path, and they're small (~20KB each). The chmod 644 + joe-ownership is a separate devcontainer fix-ownership issue, not a rigscore concern. Tracking them makes the reference durable.

**Test plan:**
- If (a): `git ls-files .data/health-reports/` lists the existing reports; future health-check runs produce diff-able output
- If (b): newly-generated reports do NOT show in `git status -uall`

---

## Wave 4 — Dependabot major-version bump triage (no PR — review session)

**Closes:** session-observed issue — PR #144 (Wave 6) added `.github/dependabot.yml` with `package-ecosystem: github-actions, interval: weekly`. Dependabot's initial-sync opened 5 PRs immediately (#147-#151), all major-version bumps:

| PR | Action | Bump |
|---|---|---|
| #147 | docker/setup-buildx-action | v3.12.0 → v4.1.0 |
| #148 | docker/build-push-action | v6.19.2 → v7.2.0 |
| #149 | actions/setup-node | v4.4.0 → v6.0.0 |
| #150 | actions/checkout | v4.3.1 → v6.0.0 |
| #151 | github/codeql-action | v3 → v4 |

**The work:** read each action's release notes for breaking changes, run CI on each, merge or close. Or batch them into a single "GHA major-version sweep" PR cherry-picked from each branch.

**Why this is a separate wave:** each PR needs upstream-release-notes reading. That's research, not code. Don't bundle with mechanical fixes.

**Watch:** `actions/checkout@v6` (Node 24 runtime requirement) is the most likely to break CI. Test it last.

---

## Wave 5 — refactor JSON-stripping output discipline audit (one PR, ~30 lines)

**Branch:** `fix/output-discipline-sweep`
**Commit:** `fix(misc): replace remaining console.{log,warn,error} with process.std{out,err}.write`
**Closes:** continuation of Wave 9 Production #3. PR #156 fixed one `console.warn` in `src/fixer.js:50` but there may be more.

**The audit command:**
```
$ grep -rn "console\.\(log\|warn\|error\)" src/ bin/
```

For each hit:
- `console.error` / `console.warn` → `process.stderr.write(... + '\n')`
- `console.log` (only for actual stdout output like JSON / scores) → `process.stdout.write(... + '\n')`
- `console.log` used as a diagnostic → `process.stderr.write(... + '\n')`

**Why this matters:** rigscore's CLI contract is "stdout = scored output (terminal/JSON/SARIF/badge); stderr = everything else." `console.warn` writes to stderr in Node, so the bug isn't *behavioral*, it's a *convention violation* that future readers will copy. One sweep, done.

**Diff budget:** depends on how many hits the grep produces. If 0-3 hits, fold into another small PR. If 4+, ship as its own.

---

## Wave 6 — clarify the 300-sum cap policy for pure code-motion refactors (no PR — JP decision)

**Closes:** session-observed friction — Wave 7 Phase A (PR #141) shipped at 382-sum. JP merged it. The subagent observed that recent refactor PRs (#136 at 418, #135 at 422, #132 at 408) were also over-cap. Either the cap is being silently relaxed for pure-motion refactors, or these were rule-violations.

**The decision (record in CLAUDE.md or workspace process doc):**
- (a) **Cap stays 300 sum, period.** Refactors that exceed get split into "extract" + "tests" or "extract A" + "extract B" PRs. Subagent prompts get updated to enforce.
- (b) **Cap is 300 net (insertions − deletions), not sum,** for pure-motion PRs. Sum will be 2-3× net for refactors because every move is one delete + one add.
- (c) **Cap is 300 sum for behavior changes, 500 sum for pure-motion refactors verified by a git-format-patch round-trip.** Most permissive; requires the verifier.

JP's pre-push hook currently enforces (a) but lets force-push or manual overrides through, which is what's happening for refactors. Pick (a) and tighten, (b) and re-document, or (c) and add the verifier.

**Recommend (b)** — matches the practical pattern, and the explanation already lives in JP's CLAUDE.md: *"refactors / lock refreshes can be 2-3× net."* Make that an explicit policy, not folklore.

**Deliverable:** one CLAUDE.md edit (or workspace process doc), no rigscore code change.

---

## Wave 7 — instruction-effectiveness skips its own session's worktrees (one PR, ~15 lines)

**Branch:** `fix/instruction-effectiveness-exclude-worktrees`
**Commit:** `fix(checks/instruction-effectiveness): skip .claude/worktrees/** during discoverFiles`
**Closes:** session-observed issue — rigscore-self scores 55/100 right now, dragged down to 0 on instruction-effectiveness because 37 dead-file-reference findings fire against fixture paths inside `.claude/worktrees/agent-*/test/fixtures/`. None of those references are real — they're transient copies of the project that any agent isolation:worktree run creates and the harness never auto-unlocks.

**The fix:**
In `src/checks/instruction-effectiveness.js` `collectGovernanceFiles` / `collectSkillFiles` / `collectMemoryFiles` (the three helpers PR #157 introduced), add an early-skip on paths matching `/.claude/worktrees/` so we don't walk into agent-worktree clones during self-scan. Same with `detectDeadReferences` if it gets reached anyway.

Note: this is *not* the same as the user's `cleanup-worktrees` skill (which removes the worktrees physically). This is making rigscore's *check* robust against the worktrees being present.

**Test:** create a fake `.claude/worktrees/agent-fake/CLAUDE.md` containing a deliberately-broken file ref; assert `instruction-effectiveness` does NOT flag it.

**Why now:** every parallel-agent run during a fix-wave session inflates this check until JP runs cleanup-worktrees. Three findings × six worktrees × 37 dead refs is the difference between "55/100" and "≥80/100" on self-scan. The check should be self-cleaning.

---

## Out of scope (note for future)

These came up during the session but belong to other repos / processes:

- **`buddy-prod` WIP-cron contamination:** the auto-checkpoint cron commits whatever's in the working tree every 30 minutes onto whatever branch HEAD is on. During this session it bundled my unrelated edits with worktree pseudo-submodule pointers and an untracked health report (PR #157's branch had to be soft-reset and re-staged to recover a clean diff). Cron should either scope itself to a known WIP branch, use `git stash` semantics, or skip when on a branch matching `^(fix|feat|refactor|chore|docs)/`. **Workspace-cron issue, not rigscore.**

- **devcontainer fix-ownership UX:** post-session `.claude/worktrees/agent-*` dirs are `dev`-owned and joe can't `rm -rf` them without sudo. JP's CLAUDE.md says "suggest `make fix-ownership`" but the workspace Makefile target may not handle this case (worktrees aren't ordinary files; they have `.git/worktrees/` metadata mirrored). **Workspace devcontainer issue.**

- **Other projects' rigscore self-scores:** three other workspace projects scored in the 27–54 range when self-scanned. None are rigscore bugs; they're indicators that those projects need their own rigscore-fix sweeps. **Per-project work.**

- **Claude Code worktree auto-unlock-on-merge:** `cleanup-worktrees` SKILL.md notes "The harness locks these worktrees to protect agent work pre-merge, but never unlocks them post-merge — they accumulate forever otherwise." Structural issue with `Agent(isolation: "worktree")` — every parallel run leaks one locked worktree. **Claude Code harness issue.**

- **LLM-generated audits can confabulate exploit observations:** the original health report claimed a "live prompt-injection demonstration payload" in `test/fixtures/scored-project/.env` that caused a forged `<system-reminder>` block to appear during analysis advertising suspicious skills. Verified non-reproducible (the .env is plain key=value pairs; no injection content; the alleged skills are documented fixtures). Wave 10 in the predecessor plan tasked me to "wrap the prompt-injection payload" — there was no payload to wrap. **Claude Code health-check skill issue: audits authored by LLMs can hallucinate dynamic side effects, and downstream plans built on those audits inherit the hallucination.**

## Acceptance

Plan complete when:
1. Waves 1, 2, 3, 5, 7 merged. (Wave 4 is a triage session, Wave 6 is a doc decision.)
2. `npx vitest run` (no `--exclude`) returns 1149+ tests passed in <8s on a fresh worktree-free repo.
3. `node bin/rigscore.js .` on rigscore itself returns ≥80/100 (instruction-effectiveness no longer bottoming out the score).
4. JP has picked (a/b/c) for Wave 6 and the workspace CLAUDE.md reflects it.

Total estimate: ~5 small PRs + 1 triage session + 1 process decision. **~150-200 sum lines** of actual code change.

## How to pick this up in a new session

> Pick up the pkg-rigscore session follow-ups. Plan: `.data/plans/2026-05-28-pkg-rigscore-session-followups.md`. Predecessor plans (already shipped): `.data/plans/2026-05-27-pkg-rigscore-fix-waves.md` and `.data/plans/2026-05-27-pkg-rigscore-post-acceptance-fix-waves.md`.
>
> Start with Wave 1 (`fix/vitest-exclude-agent-worktrees`). Every other wave is independent and can interleave; the only dependencies are Wave 4 (Dependabot triage — your call) and Wave 6 (cap-policy decision — your call) before related work resumes.
>
> All my standard rules: branch off `main`, ≤300-sum diff, conventional commits, no Claude/Anthropic attribution, I merge PRs manually, emit `sudo gh-merge-approved <PR-url> --repo Back-Road-Creative/rigscore` as a paste-ready one-liner.
