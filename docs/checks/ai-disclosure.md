# ai-disclosure

## Purpose

Projects that accept AI-assisted contributions are increasingly expected to *say so*. MicroPython now requires a generative-AI declaration on every PR ([micropython#18842](https://github.com/micropython/micropython/pull/18842)), and repo-root policy files are appearing in major projects ([pypa/pip `AI_POLICY.md`](https://github.com/pypa/pip/blob/main/AI_POLICY.md), [modelcontextprotocol `AI_POLICY.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/AI_POLICY.md)). A repo that visibly runs agents but tells contributors nothing carries an avoidable trust and procurement gap. Applicable **only when the repo shows an AI surface** — a governance file (`GOVERNANCE_FILES` in `src/constants.js`), a `.claude/` dir, an MCP config, or an agent CI job. A repo with no AI surface owes no disclosure and returns N/A. Maps only loosely to ASI01 (Agent Goal Hijack): the subject is governance transparency, not exploitability — hence advisory.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| AI surface present, but no AI-use policy anywhere | WARNING | `ai-disclosure/no-ai-policy` | Add `AI_POLICY.md` or a "Generative AI policy" section in `CONTRIBUTING.md` |
| A PR template exists but no template mentions AI | WARNING | `ai-disclosure/pr-template-no-ai-field` | Add a generative-AI declaration to the PR template |
| Policy present (and any PR template carries an AI field) | PASS | — | — |
| No AI surface at all | N/A | — | — |

**Severity rationale.** `no-ai-policy` is a WARNING: it is the point of the check, and the maintainer controls it completely — one file fixes it. `pr-template-no-ai-field` is also a WARNING, because a project that already has a contribution funnel yet omits the disclosure checkpoint is exactly the gap MicroPython closed; the fix is a two-line checkbox. Neither is CRITICAL — a missing disclosure is a transparency gap, not an exploitable vulnerability, and rigscore reserves CRITICAL for findings that leak credentials or execute code.

## Weight rationale

Advisory — weight 0. Registered at `0` in `WEIGHTS`, so it contributes nothing to the overall score or to coverage math (`src/scoring.js` skips weight-0 checks). The row is not optional: `test/scanner.test.js` asserts every auto-discovered check has a numeric `WEIGHTS` entry. It ships advisory because the conventions are still forming — no single filename dominates, no standards body has ratified one, and detection is necessarily presence-based (below). Scoring a repo down against a convention this young would be overreach. It reports; it does not punish.

## Fix semantics

No auto-fix — every finding needs a human decision, and rigscore's `--fix` never writes governance content.

- `ai-disclosure/no-ai-policy` → **not auto-fixed.** Whether a project accepts AI-assisted contributions is a governance decision; a generated placeholder would satisfy the check while telling contributors nothing true.
- `ai-disclosure/pr-template-no-ai-field` → **not auto-fixed.** The declaration's wording is the maintainer's call. Out of scope generally: rigscore will never author, reword, or "improve" a project's AI policy.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: the explicit `findingId` per finding — `ai-disclosure/no-ai-policy`, `ai-disclosure/pr-template-no-ai-field`. See `src/sarif.js` → `deriveFindingRuleId()`.
- Level mapping: CRITICAL→`error`, WARNING→`warning`, INFO→`note`; this check emits only WARNING. Location data is the project root — the findings are about repo-level *absence*, so there is no meaningful line number. The ruleId column above matches the `findingId` in terminal/JSON output and in `.rigscorerc.json` `suppress[]` entries.

## Example

```
✗ ai-disclosure — 85/100 (advisory) [keyword]
  WARNING No AI-use policy for a repo that runs AI agents
    AI surface present (CLAUDE.md); no CONTRIBUTING.md policy, no AI_POLICY.md.
```

## Scope and limitations

**This is a presence check, not a semantic one.** It cannot judge whether a policy is a *good* policy, or even whether it genuinely concerns disclosure — it matches keywords. rigscore's governance checks are presence-based across the board; this one is no exception. Do not read a PASS as "this project has an adequate AI policy," only as "this project has text that looks like one." Detection is deliberately biased toward **not** flagging:

- **Policy.** Counts if (a) a file named (case-insensitively) `AI_POLICY.md`, `ai-policy.md`, `aipolicy.md`, `AI.md`, `AI_COVENANT.md`, or `AI_CONTRIBUTING.md` exists in `.`, `docs/`, or `.github/`; or (b) `CONTRIBUTING.md` (root/`.github/`/`docs/`) or a governance file names an AI tool *within 400 characters of* disclosure/policy language (`disclose`, `declare`, `attribution`, `co-author`, `policy`, `transparency`, `prohibited`, `human review`, …). The proximity window stops a `CLAUDE.md` — which mentions "Claude" by definition — from counting as a policy merely because "policy" appears elsewhere in the file. A policy phrased entirely outside this vocabulary is missed; that is the intended direction of error. Of these filenames **only `AI_POLICY.md` is confirmed against primary sources**; the rest are accepted generously as plausible variants, not asserted as established conventions.
- **PR template.** Both the single-file form (`.github/`, root, `docs/`) and the directory form (`.github/PULL_REQUEST_TEMPLATE/*.md`) are read. A template set counts as disclosing if **any** template mentions AI at all — mentioning AI in a PR template is near-conclusive evidence of a disclosure field, and demanding more would produce false flags. Cost: a repo with several templates where only one asks the question still passes. Conservative by choice.

## Not covered (yet)

This is the first slice of the check, held to the repo's ≤300-line PR cap. The check module now exists on `main`, so each item below is a small ordinary follow-up PR — the cap forced the first slice to be thin, not the capability to be small.

- **"No PR template at all" (deferred signal).** A repo that clearly runs agents but has no `.github/PULL_REQUEST_TEMPLATE.md` currently passes the template arm; only a template that *exists* and skips the question is flagged. Deferred rather than dropped because it is the weakest of the three signals — plenty of legitimate repos (solo projects, mirrors, non-GitHub hosting) have no PR template at all — so it would have shipped as INFO. Intended finding id: `ai-disclosure/no-pr-template`.
- **Wiki-hosted policies.** MicroPython's policy *text* lives in its GitHub wiki; only the template declaration is in-tree. rigscore is offline and static, so a wiki-only policy reads as absent and no in-repo signal can distinguish it.
- **No "AI manifest" standard.** No ratified machine-readable AI-manifest format (an `ai.txt`-style well-known descriptor) could be confirmed as an adopted convention, so none is matched. If one emerges, add it to `POLICY_FILENAMES`.
- **Per-PR enforcement.** The check verifies the repo *asks* for a disclosure, never that a merged PR actually carried one — that needs the GitHub API, out of scope for an offline scanner.
