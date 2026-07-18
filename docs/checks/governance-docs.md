# governance-docs

**Enforcement grade:** `pattern` — regex-matches a fixed catalog of quality and injection markers against governance prose, with structural file-presence and negation-context checks. More than naive keyword matching, but still evadable by semantic reversal; see [`THREAT-MODEL.md`](../../THREAT-MODEL.md) §3.1.

## Purpose

Scans every known AI-client governance file — `CLAUDE.md` (project + `~/.claude/` + `~`), `.cursorrules`, `.windsurfrules`, `.clinerules`, `.continuerules`, `copilot-instructions.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.aider.conf.yml`, plus the directory-form rule sets scanned by default (`.cursor/rules/*.mdc`, `.windsurf/rules/`, `.clinerules/` dir, `.github/instructions/*.instructions.md`) — for presence, length, quality coverage across nine governance patterns, active negation ("never require approval"), embedded instruction-override injection, and git tracking status. Maps to OWASP Agentic Top 10 `ASI01` (Agent Goal Hijack). A passing check guarantees: at least one governance file exists and is substantive (≥50 lines), all nine quality patterns appear non-negated (forbidden actions, approval gates, path restrictions, network restrictions, anti-injection, shell restrictions, test-driven development, definition of done, git workflow rules), no injection pattern appears in a non-defensive context (single-line or 2-line sliding window), no governance file is listed in `.gitignore`, and every governance file that exists is tracked in git.

Failure to detect a governance file is CRITICAL and short-circuits the check — agents without explicit written boundaries operate on whatever their trainer's priors happen to say, which is the root condition for every other AI-specific risk this tool scans for.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| No AI tooling detected anywhere in `cwd` — the check short-circuits before any of the rows below | INFO (N/A) | `governance-docs/no-ai-tooling-detected` | None — a repo that never claimed to be AI-tooled is not scored on governance |
| No governance file found in any known location | CRITICAL | `governance-docs/no-governance-file` | Create CLAUDE.md (or equivalent) with boundaries, forbidden actions, approval gates |
| Multiple governance files detected | PASS | — | None — informational positive signal |
| Longest governance file < 50 lines | WARNING | `governance-docs/governance-file-short` | Add forbidden actions, approval gates, path restrictions, anti-injection rules |
| Governance header names a quality pattern but a line within 5 of it dismantles it ("no restrictions", "skip approval") | WARNING | `governance-docs/governance-reversal-detected` | Rewrite the section body to enforce the rule, or drop the keyword-stuffed header |
| Quality pattern MISSING (no match anywhere) — `forbidden actions` | WARNING | `governance-docs/missing-forbidden-actions` | Add forbidden-action rules |
| Quality pattern MISSING — `approval gates` | WARNING | `governance-docs/missing-approval-gates` | Add approval / human-in-the-loop rules |
| Quality pattern MISSING — `path restrictions` | WARNING | `governance-docs/missing-path-restrictions` | Declare allowed working directories |
| Quality pattern MISSING — `network restrictions` | WARNING | `governance-docs/missing-network-restrictions` | Declare external-network policy |
| Quality pattern MISSING — `anti-injection` | WARNING | `governance-docs/missing-anti-injection` | Add prompt-injection defense rules |
| Quality pattern MISSING — `shell restrictions` | WARNING | `governance-docs/missing-shell-restrictions` | Add bash/shell policy |
| Quality pattern MISSING — `test-driven development` | WARNING | `governance-docs/missing-test-driven-development` | Declare test-first workflow |
| Quality pattern MISSING — `definition of done` | WARNING | `governance-docs/missing-definition-of-done` | Declare what "done" means |
| Quality pattern MISSING — `git workflow rules` | WARNING | `governance-docs/missing-git-workflow-rules` | Declare branch / PR workflow |
| Quality pattern present but every match is NEGATED (a negation word precedes it in the same sentence, e.g. "never require approval") — `forbidden actions` | CRITICAL | `governance-docs/actively-negates-forbidden-actions` | Remove the negated statement; write a genuine forbidden-action rule |
| Quality pattern present but NEGATED — `approval gates` | CRITICAL | `governance-docs/actively-negates-approval-gates` | Replace with a genuine approval / human-in-the-loop rule |
| Quality pattern present but NEGATED — `path restrictions` | CRITICAL | `governance-docs/actively-negates-path-restrictions` | Replace with genuine allowed-directory rules |
| Quality pattern present but NEGATED — `network restrictions` | CRITICAL | `governance-docs/actively-negates-network-restrictions` | Replace with a genuine external-network policy |
| Quality pattern present but NEGATED — `anti-injection` | CRITICAL | `governance-docs/actively-negates-anti-injection` | Replace with genuine prompt-injection defense rules |
| Quality pattern present but NEGATED — `shell restrictions` | CRITICAL | `governance-docs/actively-negates-shell-restrictions` | Replace with a genuine bash/shell policy |
| Quality pattern present but NEGATED — `test-driven development` | CRITICAL | `governance-docs/actively-negates-test-driven-development` | Replace with a genuine test-first workflow rule |
| Quality pattern present but NEGATED — `definition of done` | CRITICAL | `governance-docs/actively-negates-definition-of-done` | Replace with a genuine definition of "done" |
| Quality pattern present but NEGATED — `git workflow rules` | CRITICAL | `governance-docs/actively-negates-git-workflow-rules` | Replace with a genuine branch / PR workflow rule |
| Injection pattern ("ignore previous instructions", "you are now", "from now on you…") in governance, non-defensive | CRITICAL | `governance-docs/injection-pattern` | Remove override pattern or rephrase as defensive |
| Governance file ignored by `.gitignore` — any git-honored pattern: bare name, anchored (`/CLAUDE.md`), glob (`*.md`), or recursive (`**`) | CRITICAL | `governance-docs/governance-file-gitignored` | Remove from `.gitignore` and commit |
| Governance file exists but `git ls-files` shows untracked | WARNING | `governance-docs/governance-file-untracked` | `git add <file>` |
| All checks pass | PASS | — | — |

## Weight rationale

Weight 10 — tied with `skill-files` at the lower moat tier. Governance is the root of every AI-specific boundary rigscore checks for downstream, which argues for a higher weight, but the weighting is capped at 10 for a specific reason: the coherence check (14) compounds on top of governance-docs findings — a weak governance file that contradicts actual config gets flagged twice (once in `governance-docs`, once in `coherence`), so loading all the penalty into `governance-docs` would double-count. It sits equal to `skill-files` (10) because a well-written CLAUDE.md with malicious skills, or a clean skill set with empty governance, are approximately equally dangerous. It sits below `mcp-config` (14) and `coherence` (14) because supply-chain and contradiction failures act even when governance is perfect. It sits above `claude-settings` (8) because settings are machine-readable policy while CLAUDE.md is the intent that policy is supposed to implement — the intent layer is the source of truth.

The `negated` variants are CRITICAL rather than WARNING (unlike the `missing` variants) because an active contradiction is more dangerous than an omission: agents penalize missing guidance with default behavior, but negation is legible, authoritative instruction to misbehave.

## Fix semantics

No auto-fix. The `governance-docs.js` module does not export a `fixes` array. This is a governance surface — the project constraint in CLAUDE.md is explicit that `--fix` never modifies governance content. Every finding needs human authorship:

- A missing pattern requires an author to write rules that actually reflect project policy. Auto-inserting "never run shell commands" into any repo that happens to be missing shell restrictions would produce text that lies about what the project does.
- Negated patterns require diagnosis — is the negation adversarial, or is it defensive prose the negation heuristic over-fired on?
- Embedded injection patterns might be defensive rules that the defensive-phrase detector missed; removing them silently could destroy an explicit anti-hijack rule.
- `.gitignore` and untracked-file findings can be auto-fixed in theory but are intentionally not — the user's repo hygiene policy governs `git add` decisions, not rigscore.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: see Triggers — all prefixed `governance-docs/`.
- Deprecated alias: this check was formerly `claude-md`; the check-level rule carries `deprecatedIds: ["claude-md"]` (SARIF 2.1.0 §3.49.4) so consumers keyed on the old id learn it was renamed. See [`../FINDING_IDS.md`](../FINDING_IDS.md#renamed-ids-working-aliases).
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS → omitted.
- OWASP tag: `owasp-agentic:ASI01` on every finding via `properties.tags`.
- Location: findings reference the governance file in the detail text; SARIF's `extractFilePath` helper pulls the path (e.g. `CLAUDE.md is in .gitignore`) into `physicalLocation.artifactLocation.uri` when the text matches the leading-file-reference regex. The "no governance file found" finding emits no physical location — there's nothing to anchor.

## Example

```
✗ governance-docs — 0/100 (weight 10)
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
- The `.gitignore` check asks git itself (`git check-ignore --no-index`), so anchored (`/CLAUDE.md`), glob (`*.md`), and recursive-double-star patterns are caught, not just the bare filename. When git is unavailable or `cwd` is not a git repo it falls back to an exact-string match against the local `.gitignore` — a degraded matcher fails toward the old miss, never a false CRITICAL.
- The `git ls-files` tracking check is skipped when no `.git` directory is present.
- Config override: `.rigscorerc.json` key `paths.claudeMd` adds extra files to the candidate list.
- Exports `data.matchedPatterns` and `data.governanceText` for the `coherence` check; other checks should not depend on this internal shape.
