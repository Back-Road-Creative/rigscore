# <check-id>

Replace `<check-id>` above with the exact id from `src/checks/<id>.js` (kebab-case, matching `WEIGHTS` in `src/constants.js`). The `verify-docs` gate checks the H1 matches the filename.

## Purpose

One paragraph. What this check is for, what threat it maps to (include OWASP Agentic Top 10 code from `OWASP_AGENTIC_MAP` in `src/constants.js` if applicable, e.g. "ASI04 — Agentic Supply Chain"). What a passing check guarantees. What a failure usually means in practice.

## Triggers

Table of finding conditions and severities. One row per distinct finding the check can emit. `ruleId` is the SARIF identifier emitted in `--sarif` output; keep in sync with `src/sarif.js`.

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Example: `.env` tracked by git | CRITICAL | `env-exposure/env-tracked` | Add to `.gitignore` and `git rm --cached` |
| Example: `.env` world-readable | WARNING | `env-exposure/env-perms` | `chmod 600 .env` |
| Example: no `.env` file present | PASS | — | — |

## Weight rationale

Why this weight vs. its siblings in the same category. If advisory, say "advisory — weight 0" and justify why it isn't scored (e.g. false-positive rate, site-specific signal, informational only).

Example: "Weight 8 — mid-tier hygiene. Higher than `docker-security` (6) because `.env` leaks are historically the single most common credential-exposure vector in AI dev repos; lower than `claude-md` (10) because the moat-first scoring reserves top weights for AI-specific governance."

## Fix semantics

What `--fix --yes` does for this check, finding by finding. If no auto-fix is supported, state so explicitly and say why (often: "the finding requires a human decision," "touches governance content," or "fix is out of scope for a local scanner").

- `<finding-id>` → `<what fix does on disk>` (fix id from module's `fixes` export)
- Out of scope: `<what the check will NOT auto-fix>`

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: per-finding `<checkId>/<slug-or-findingId>` (as of Moat & Ship, 2026-04-20). The bare `<checkId>` remains registered as a tool-component rule fallback for consumers that key on check-level ids. See `src/sarif.js` → `deriveFindingRuleId()`.
- The `SARIF ruleId` column in the Triggers table above matches the `findingId` shown in terminal / JSON output and used by `.rigscorerc.json` `suppress[]` entries.
- Level mapping: CRITICAL→`error`, WARNING→`warning`, INFO→`note`.
- Location data: relative path + line number when available; otherwise project root.
- Evidence: when the finding emits an `evidence` field, it appears as `properties.evidence` on the SARIF result (≤120 char snippet).

## Example

Short before/after or terminal snippet showing the check's human output. One or two findings is enough — this section documents what the check *looks like*, not every edge case.

```
✗ env-exposure — 0/100 (weight 8)
  CRITICAL .env tracked by git
    .env is committed at HEAD~0. Remove with: git rm --cached .env
  WARNING .env world-readable
    .env has mode 644. Run: chmod 600 .env
```

## Scope and limitations (optional)

Optional H2. Files/paths scanned, platform gates (Windows short-circuits? needs `--deep`? needs `--online`?), known evasions, config overrides in `.rigscorerc.json`. Include if non-obvious.
