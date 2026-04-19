# Rigscore + Headlessmode Site Sync — Multi-Agent Plan

Handoff doc for a fresh session. Goals:

1. **Docs-first rigscore** — every check (scored + advisory) has complete docs at all times; CI blocks merges that add/change a check without doc updates. No "develop then fail docs validation" — docs are part of the unit of work.
2. **Site pivot** — headlessmode site shifts from mixed blog/journal to a rigscore-focused product site. Homepage leads with rigscore. Journal entries are re-evaluated: keep what supports rigscore narrative (repurposed as case studies / "why this check exists" posts), delete the rest.
3. **Mechanical sync** — site content about rigscore is generated from `src/constants.js` + check metadata. Drift fails CI.

Repos in scope:
- `/home/dev/workspaces/_active/pkg-rigscore`
- `/home/dev/workspaces/_active/site-headlessmode`

---

## Phase 1 — Discovery (spawn all four in parallel)

Each runs as a `general-purpose` subagent. Data-framing rules from CLAUDE.md apply.

### R1 · rigscore-docs-audit
Inventory every check in `src/checks/*.js` (13 scored + 6 advisory per CLAUDE.md). For each: doc location? Coverage of purpose, what triggers CRITICAL vs WARN vs INFO, exit codes, fix semantics, weight rationale? Produce a gap matrix keyed by check id.

### R2 · rigscore-enforcement-audit
Verify rigscore is dogfooded correctly. Current score on itself? `--fail-under` threshold and buffer? Do README claims match actual tool behavior? Which `--fix` fixes are real vs advertised? Produce an enforcement gap list with severity.

### S1 · site-content-audit
Read the entire headlessmode site: homepage, rigscore page, **all** journal entries, nav, footer. For each journal entry judge: (a) quality as-is, (b) can it be repurposed as rigscore support content (case study, "why this check"), (c) delete. Produce `site-pivot-plan.md` with per-page verdicts + homepage rewrite direction.

### D1 · docs-first-design
Design the enforcement mechanism. Options:
- New rigscore check (e.g. `check-self-documentation`) that flags `src/checks/*.js` without matching docs
- CI-only step that diffs check modules ↔ docs
- Pre-commit hook
Pick one, spec signature (inputs, outputs, exit codes), integration point. Must be dogfoodable on rigscore itself.

---

## Phase 2 — Synthesis (main session)

Consolidate R1/R2/S1/D1 outputs:
- Unified gap list (tool docs + enforcement + site)
- Prioritized backlog, branch strategy (separate PRs: docs-first gate → doc fills → site pivot → sync mechanism)
- **User review + approval gate here.** Do not proceed without sign-off.

---

## Phase 3 — Execution (sequential, each with a gate)

### 3A · Implement docs-first gate
Build D1's spec. Ship as check or CI step. Add tests. Gate: mechanism passes current rigscore head; if it fails, 3B becomes mandatory before merge.

### 3B · Fill rigscore documentation gaps
Work through R1's matrix. Write missing sections. Gate: docs-first gate passes cleanly; rigscore score on itself ≥ pre-change baseline.

### 3C · Site pivot
Worktree on `site-headlessmode`. Execute S1's pivot plan: homepage rewrite, journal repurposing, deletions. Gate: `make publish SITE=site-headlessmode` dry-run clean, user preview approval.

### 3D · Sync mechanism
Generate site rigscore content from `src/constants.js` + check metadata. Add cross-repo drift check — CI in either repo fails if site content diverges from tool source of truth. Gate: drift check green on both repos.

---

## Phase 4 — Validation

- `node bin/rigscore.js .` on pkg-rigscore — all gates pass, score ≥ baseline + expected deltas
- Site preview deployed; user signs off on pivot
- Merge order: docs-first PR → doc fills PR → site pivot PR → sync mechanism PR

---

## Session kickoff prompt

```
Read PLAN-rigscore-site-sync.md, then launch Phase 1 agents (R1, R2, S1, D1) in parallel. Report back with synthesis before touching code.
```

## Non-goals
- No rigscore feature work outside the docs-first gate
- No site redesign beyond the rigscore pivot
- Do not chase journal quality — it's being repurposed or removed, not polished
