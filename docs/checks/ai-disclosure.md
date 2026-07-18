# ai-disclosure

## Purpose

Projects that accept AI-assisted contributions are increasingly expected to *say so*. MicroPython now requires a generative-AI declaration on every PR ([micropython#18842](https://github.com/micropython/micropython/pull/18842)), and repo-root policy files are appearing in major projects ([pypa/pip `AI_POLICY.md`](https://github.com/pypa/pip/blob/main/AI_POLICY.md), [modelcontextprotocol `AI_POLICY.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/AI_POLICY.md)). A repo that visibly runs agents but tells contributors nothing carries an avoidable trust and procurement gap. Applicable **only when the repo shows an AI surface** — a governance file (`GOVERNANCE_FILES` in `src/constants.js`), a `.claude/` dir, an MCP config, or an agent CI job. A repo with no AI surface owes no disclosure and returns N/A. Maps only loosely to ASI01 (Agent Goal Hijack): the subject is governance transparency, not exploitability — hence advisory.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| AI surface present, but no AI-use policy anywhere | WARNING | `ai-disclosure/no-ai-policy` | Add `AI_POLICY.md` or a "Generative AI policy" section in `CONTRIBUTING.md` |
| A PR template exists but no template mentions AI | WARNING | `ai-disclosure/pr-template-no-ai-field` | Add a generative-AI declaration to the PR template |
| No PR template in any location GitHub reads | INFO | `ai-disclosure/no-pr-template` | Add `.github/pull_request_template.md` carrying a generative-AI declaration |
| The repo asks for a disclosure, but no committed mechanism could fail a PR that ignored the ask | INFO | `ai-disclosure/disclosure-not-enforced` | Gate the PR body in CI (a `pull_request` job that reads `github.event.pull_request.body` and exits non-zero, or a checklist enforcer) |
| Policy present (and any PR template carries an AI field) | PASS | — | — |
| No AI surface at all | N/A | — | — |

**Severity rationale.** `no-ai-policy` is a WARNING: it is the point of the check, and the maintainer controls it completely — one file fixes it. `pr-template-no-ai-field` is also a WARNING, because a project that already has a contribution funnel yet omits the disclosure checkpoint is exactly the gap MicroPython closed; the fix is a two-line checkbox. `no-pr-template` is only INFO: it is the weakest of the three signals — plenty of legitimate repos (solo projects, mirrors, non-GitHub hosting) run agents and have no PR template at all, and telling them to grow a contribution funnel is not this check's business. It reports the absent disclosure point; it does not insist on one. The two template arms are mutually exclusive: templates exist → `pr-template-no-ai-field` is the live arm; none exist → `no-pr-template`. `disclosure-not-enforced` is INFO, deliberately *below* the two ask-arms: the repo has already done the primary thing — it asks — and CI-gating a PR-body checkbox is not yet a settled convention, so an unenforced ask is a governance weakness (honour-system disclosure), not a vulnerability. Ranking it WARNING would also be perverse: adding the disclosure checkbox would merely swap one WARNING for another, so a maintainer who fixed `pr-template-no-ai-field` would see no improvement. It is gated on the ask — a repo with no disclosure requirement at all gets `no-ai-policy` / `pr-template-no-ai-field` and is never double-reported here. Nothing here is CRITICAL — a missing disclosure is a transparency gap, not an exploitable vulnerability, and rigscore reserves CRITICAL for findings that leak credentials or execute code.

## Weight rationale

Advisory — weight 0. Registered at `0` in `WEIGHTS`, so it contributes nothing to the overall score or to coverage math (`src/scoring.js` skips weight-0 checks). The row is not optional: `test/scanner.test.js` asserts every auto-discovered check has a numeric `WEIGHTS` entry. It ships advisory because the conventions are still forming — no single filename dominates, no standards body has ratified one, and detection is necessarily presence-based (below). Scoring a repo down against a convention this young would be overreach. It reports; it does not punish.

## Fix semantics

No auto-fix — every finding needs a human decision, and rigscore's `--fix` never writes governance content.

- `ai-disclosure/no-ai-policy` → **not auto-fixed.** Whether a project accepts AI-assisted contributions is a governance decision; a generated placeholder would satisfy the check while telling contributors nothing true.
- `ai-disclosure/pr-template-no-ai-field` → **not auto-fixed.** The declaration's wording is the maintainer's call. Out of scope generally: rigscore will never author, reword, or "improve" a project's AI policy.
- `ai-disclosure/no-pr-template` → **not auto-fixed.** Whether a repo wants a PR template at all is a workflow decision, not a hygiene defect; generating one would impose a contribution funnel the maintainer never asked for.
- `ai-disclosure/disclosure-not-enforced` → **not auto-fixed.** Writing a CI job that can block every incoming PR is a maintainer decision with real blast radius; rigscore will not add a merge gate to someone's repo unasked.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: the explicit `findingId` per finding — `ai-disclosure/no-ai-policy`, `ai-disclosure/pr-template-no-ai-field`, `ai-disclosure/no-pr-template`, `ai-disclosure/disclosure-not-enforced`. See `src/sarif.js` → `deriveFindingRuleId()`.
- Level mapping: CRITICAL→`error`, WARNING→`warning`, INFO→`note`; this check emits WARNING and INFO. Location data is the project root — the findings are about repo-level *absence*, so there is no meaningful line number. The ruleId column above matches the `findingId` in terminal/JSON output and in `.rigscorerc.json` `suppress[]` entries.

## Example

```
✗ ai-disclosure — 83/100 (advisory) [keyword]
  WARNING No AI-use policy for a repo that runs AI agents
    AI surface present (CLAUDE.md); no CONTRIBUTING.md policy, no AI_POLICY.md.
  INFO No PR template for a repo that runs AI agents
    No pull-request template in any location GitHub reads, so a contributor is
    never asked to declare AI assistance.
```

## Scope and limitations

**This is a presence check, not a semantic one.** It cannot judge whether a policy is a *good* policy, or even whether it genuinely concerns disclosure — it matches keywords. rigscore's governance checks are presence-based across the board; this one is no exception. Do not read a PASS as "this project has an adequate AI policy," only as "this project has text that looks like one." Detection is deliberately biased toward **not** flagging:

- **Policy.** Counts if (a) a file named (case-insensitively) `AI_POLICY.md`, `ai-policy.md`, `aipolicy.md`, `AI.md`, `AI_COVENANT.md`, or `AI_CONTRIBUTING.md` exists in `.`, `docs/`, or `.github/`; or (b) `CONTRIBUTING.md` (root/`.github/`/`docs/`) or a governance file names an AI tool *within 400 characters of* disclosure/policy language (`disclose`, `declare`, `attribution`, `co-author`, `policy`, `transparency`, `prohibited`, `human review`, …). The proximity window stops a `CLAUDE.md` — which mentions "Claude" by definition — from counting as a policy merely because "policy" appears elsewhere in the file. A policy phrased entirely outside this vocabulary is missed; that is the intended direction of error. Of these filenames **only `AI_POLICY.md` is confirmed against primary sources**; the rest are accepted generously as plausible variants, not asserted as established conventions.
- **Enforcement.** Asking is not enforcing, and the difference is visible on disk: a mechanism counts only if it could *fail a pull request on the strength of that PR's own body*. Two accepted forms: (a) a file under `.github/workflows/` (or a root/`.github` `Dangerfile`) that **references the PR body** (`github.event.pull_request.body`, `payload.pull_request.body`, `danger.github.pr.body`) **and** contains a failure signal (`exit 1`, `setFailed`, `::error`, `throw new Error`, `fail(`, a `grep` assertion); (b) a named checklist / PR-body linter (`require-checklist`, `pr-lint`, `pull-request-lint`, Danger), which fails by construction. Both halves are required in form (a): a workflow that merely *mentions* an AI tool — even one that runs a coding agent — gates nothing, and a job that prints the body without asserting on it fails no one. Deliberately **not** enforcement: a CODEOWNERS entry plus a review requirement (a human reviewer is not a disclosure gate), and commitlint (it reads commit messages, never the PR body). Bias is toward *accepting* a mechanism — falsely telling a repo that built the gate that it has none is the expensive failure. Missed, therefore: a gate that lives in non-GitHub CI, and branch protection configured through the GitHub UI rather than committed to the repo (rigscore is offline; it cannot read the API).
- **PR template.** Every location [GitHub honours](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository) is read: the single-file form in the repo root, `.github/`, or `docs/` (either casing — `PULL_REQUEST_TEMPLATE.md` / `pull_request_template.md`), and the multi-template directory form `PULL_REQUEST_TEMPLATE/` under any of those same three roots. Reading fewer locations would mean telling a repo that *does* have a template that it has none — the expensive failure for `no-pr-template`. A template set counts as disclosing if **any** template mentions AI at all — mentioning AI in a PR template is near-conclusive evidence of a disclosure field, and demanding more would produce false flags. Cost: a repo with several templates where only one asks the question still passes. Conservative by choice.

## Not covered (yet)

This is the first slice of the check, held to the repo's ≤300-line PR cap. The check module now exists on `main`, so each item below is a small ordinary follow-up PR — the cap forced the first slice to be thin, not the capability to be small.

- **Wiki-hosted policies.** MicroPython's policy *text* lives in its GitHub wiki; only the template declaration is in-tree. rigscore is offline and static, so a wiki-only policy reads as absent and no in-repo signal can distinguish it.
- **No "AI manifest" standard.** No ratified machine-readable AI-manifest format (an `ai.txt`-style well-known descriptor) could be confirmed as an adopted convention, so none is matched. If one emerges, add it to `POLICY_FILENAMES`.
- **Per-PR compliance.** The check now reports whether an *enforcement mechanism exists* (`disclosure-not-enforced`), but it still cannot confirm that any particular merged PR actually carried a disclosure — that needs the GitHub API to enumerate merged PRs and read their bodies, out of scope for an offline scanner. A repo whose gate is committed but disabled, or bypassed by admin merge, reads as enforced.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [GitHub — Creating a pull request template](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository) — the PR-template surface this check reads for a disclosure gate.
- [pip — Generative AI policy](https://pip.pypa.io/en/stable/development/contributing/#generative-ai) — a primary-source AI-contribution policy the check is calibrated against.
