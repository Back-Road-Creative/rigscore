# claude-md

## Purpose

Scans every known AI-client governance file — `CLAUDE.md` (project + `~/.claude/` + `~`), `.cursorrules`, `.windsurfrules`, `.clinerules`, `.continuerules`, `copilot-instructions.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.aider.conf.yml` — for presence, length, quality coverage across nine governance patterns, active negation ("never require approval"), embedded instruction-override injection, and git tracking status. Maps to OWASP Agentic Top 10 `ASI01` (Agent Goal Hijack). A passing check guarantees: at least one governance file exists and is substantive (≥50 lines), all nine quality patterns appear non-negated (forbidden actions, approval gates, path restrictions, network restrictions, anti-injection, shell restrictions, test-driven development, definition of done, git workflow rules), no injection pattern appears in a non-defensive context (single-line or 2-line sliding window), no governance file is listed in `.gitignore`, and every governance file that exists is tracked in git.

Failure to detect a governance file is CRITICAL and short-circuits the check — agents without explicit written boundaries operate on whatever their trainer's priors happen to say, which is the root condition for every other AI-specific risk this tool scans for.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| No governance file found in any known location | CRITICAL | `claude-md/missing` | Create CLAUDE.md (or equivalent) with boundaries, forbidden actions, approval gates |
| Multiple governance files detected | PASS | `claude-md/multi-layer` | None — informational positive signal |
| Longest governance file < 50 lines | WARNING | `claude-md/too-short` | Add forbidden actions, approval gates, path restrictions, anti-injection rules |
| Quality pattern MISSING (no match anywhere) — `forbidden actions` | WARNING | `claude-md/missing-forbidden-actions` | Add forbidden-action rules |
| Quality pattern MISSING — `approval gates` | WARNING | `claude-md/missing-approval-gates` | Add approval / human-in-the-loop rules |
| Quality pattern MISSING — `path restrictions` | WARNING | `claude-md/missing-path-restrictions` | Declare allowed working directories |
| Quality pattern MISSING — `network restrictions` | WARNING | `claude-md/missing-network-restrictions` | Declare external-network policy |
| Quality pattern MISSING — `anti-injection` | WARNING | `claude-md/missing-anti-injection` | Add prompt-injection defense rules |
| Quality pattern MISSING — `shell restrictions` | WARNING | `claude-md/missing-shell-restrictions` | Add bash/shell policy |
| Quality pattern MISSING — `test-driven development` | WARNING | `claude-md/missing-tdd` | Declare test-first workflow |
| Quality pattern MISSING — `definition of done` | WARNING | `claude-md/missing-dod` | Declare what "done" means |
| Quality pattern MISSING — `git workflow rules` | WARNING | `claude-md/missing-git-workflow` | Declare branch / PR workflow |
| Quality pattern present BUT NEGATED (e.g. "never require approval") | CRITICAL | `claude-md/negated-<pattern>` | Remove negated statement; replace with genuine enforcement |
| Injection pattern ("ignore previous instructions", "you are now", "from now on you…") in governance, non-defensive | CRITICAL | `claude-md/embedded-injection` | Remove override pattern or rephrase as defensive |
| Governance file listed in `.gitignore` | CRITICAL | `claude-md/gitignored` | Remove from `.gitignore` and commit |
| Governance file exists but `git ls-files` shows untracked | WARNING | `claude-md/untracked` | `git add <file>` |
| All checks pass | PASS | — | — |

## Weight rationale

Weight 10 — tied with `skill-files` at the lower moat tier. Governance is the root of every AI-specific boundary rigscore checks for downstream, which argues for a higher weight, but the weighting is capped at 10 for a specific reason: the coherence check (14) compounds on top of claude-md findings — a weak governance file that contradicts actual config gets flagged twice (once in `claude-md`, once in `coherence`), so loading all the penalty into `claude-md` would double-count. It sits equal to `skill-files` (10) because a well-written CLAUDE.md with malicious skills, or a clean skill set with empty governance, are approximately equally dangerous. It sits below `mcp-config` (14) and `coherence` (14) because supply-chain and contradiction failures act even when governance is perfect. It sits above `claude-settings` (8) because settings are machine-readable policy while CLAUDE.md is the intent that policy is supposed to implement — the intent layer is the source of truth.

The `negated` variants are CRITICAL rather than WARNING (unlike the `missing` variants) because an active contradiction is more dangerous than an omission: agents penalize missing guidance with default behavior, but negation is legible, authoritative instruction to misbehave.

## Fix semantics

No auto-fix. The `claude-md.js` module does not export a `fixes` array. This is a governance surface — the project constraint in CLAUDE.md is explicit that `--fix` never modifies governance content. Every finding needs human authorship:

- A missing pattern requires an author to write rules that actually reflect project policy. Auto-inserting "never run shell commands" into any repo that happens to be missing shell restrictions would produce text that lies about what the project does.
- Negated patterns require diagnosis — is the negation adversarial, or is it defensive prose the negation heuristic over-fired on?
- Embedded injection patterns might be defensive rules that the defensive-phrase detector missed; removing them silently could destroy an explicit anti-hijack rule.
- `.gitignore` and untracked-file findings can be auto-fixed in theory but are intentionally not — the user's repo hygiene policy governs `git add` decisions, not rigscore.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: see Triggers — all prefixed `claude-md/`.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS → omitted.
- OWASP tag: `owasp-agentic:ASI01` on every finding via `properties.tags`.
- Location: findings reference the governance file in the detail text; SARIF's `extractFilePath` helper pulls the path (e.g. `CLAUDE.md is in .gitignore`) into `physicalLocation.artifactLocation.uri` when the text matches the leading-file-reference regex. The "no governance file found" finding emits no physical location — there's nothing to anchor.

## Example

```
✗ claude-md — 0/100 (weight 10)
  CRITICAL Governance file CLAUDE.md is in .gitignore
    Gitignored governance files are ephemeral — they leave no audit trail.
    → Remove CLAUDE.md from .gitignore and commit it to version control.
  CRITICAL Governance file actively negates: approval gates
    Governance contains approval gates keywords in a negated context.
    → Remove negated approval gates statements and replace with genuine enforcement.
  WARNING Governance file is short (under 50 lines)
  WARNING Governance file missing: anti-injection
    → Add anti-injection instructions to your governance file.
  WARNING Governance file CLAUDE.md is not tracked in git
    → Run: git add CLAUDE.md
```

## Scope and limitations

- The union of all governance files is used for quality-pattern matching — having `CLAUDE.md` cover half the patterns and `.cursorrules` cover the other half is treated as passing. Length check (50-line minimum) is measured on the LONGEST single file only, not the union, to prevent padding the score via many short files.
- Negation detection uses a 150-character look-back bounded by sentence punctuation (`.`, `!`, `?`, `\n`). Negations that span a longer distance may be missed; false positives on "never say never"-style prose are possible.
- The defensive-phrase detector `INJECTION_DEFENSIVE_RE` is narrower than skill-files' equivalent — governance files are expected to be authoritative, so borderline phrasings default to flagging.
- Git tracking checks are skipped when no `.git` directory is present.
- Config override: `.rigscorerc.json` key `paths.claudeMd` adds extra files to the candidate list.
- Exports `data.matchedPatterns` and `data.governanceText` for the `coherence` check; other checks should not depend on this internal shape.
