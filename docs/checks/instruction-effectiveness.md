# instruction-effectiveness

**Enforcement grade:** `keyword` — detects vague directives, contradictions, and forbidden-action language via phrase / substring presence against instruction-file prose. Evadable by rewording; advisory only.

## Purpose

Audits the quality and cost of instruction files — `CLAUDE.md` chains, `.claude/skills/*/SKILL.md`, `.claude/commands/*`, project `MEMORY.md` and files it links — along three axes: context-budget consumption, internal coherence, and link integrity. The check estimates token cost against a 200K reference window, flags files that cross bloat thresholds, catches within-file contradictions ("always X" vs. "never X"), finds dead markdown references, detects vague directives that delegate decisions without criteria, and surfaces instruction lines duplicated across files. Maps to OWASP Agentic Top 10 **ASI01 — Agent Authorization & Control Hijacking** in the sense that incoherent or bloated instruction context creates surface area for hijacking (contradictions become exploitable ambiguity), but the primary framing is quality-of-instructions, not a concrete vulnerability. A passing check means instruction files are within budget, internally consistent, and referentially intact.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| No instruction files found | SKIPPED | — | — |
| Single file > 5,000 estimated tokens (char-count / 4) | WARNING | `instruction-effectiveness` (level `warning`) | Condense sections or move detail to on-demand references. |
| Aggregate instruction tokens > 20% of 200K window | WARNING | `instruction-effectiveness` (level `warning`) | Consolidate redundant instructions; split rarely-needed ones out. |
| Aggregate 10–20% of 200K window | INFO | `instruction-effectiveness` (level `note`) | Review large files for optimization. |
| Contradiction: "always/must X" vs. "never/must not X" with Jaccard ≥0.5 and ≥2 overlapping terms (same file) | INFO | `instruction-effectiveness` (level `note`) | Reconcile the conflicting directives. |
| Dead file reference in backtick path or markdown link | WARNING | `instruction-effectiveness` (level `warning`) | Update or remove the reference. |
| Vague directive (`use your judgment`, `as appropriate`, `figure it out`, `be smart about`, `when it makes sense`, `where applicable`, `as necessary`, `do what you think`, `up to you`) without colon-criteria or bulleted follow-up | INFO | `instruction-effectiveness` (level `note`) | Add concrete criteria, examples, or decision rules. First 3 per file reported individually, then one summary row. |
| Governance/skill file > 500 lines (`BLOAT_WARN`) | WARNING | `instruction-effectiveness` (level `warning`) | Split into focused files; archive obsolete sections. |
| Governance/skill file 300–500 lines (`BLOAT_INFO`) | INFO | `instruction-effectiveness` (level `note`) | Review for condensation opportunities. |
| Identical normalized line ≥20 chars present in 2+ distinct files | INFO | `instruction-effectiveness` (level `note`) | Consolidate duplicated rules into a single source. First 10 reported individually, then a summary row with the overflow count. |
| All files clean | PASS | — | — |

Thresholds (from `src/checks/instruction-effectiveness.js`):

- `REFERENCE_CONTEXT = 200_000` tokens
- `BUDGET_INFO_PCT = 0.10`, `BUDGET_WARN_PCT = 0.20`
- `SINGLE_FILE_TOKEN_WARN = 5000`
- `BLOAT_INFO = 300` lines, `BLOAT_WARN = 500` lines
- `MAX_FILE_SIZE = 1,048,576` bytes (files larger are skipped)
- `MAX_REDUNDANCY_FINDINGS = 10` (then one summary row)
- Bloat skipped for `category: 'memory'` files — memory is expected to grow.
- Code-fenced blocks (triple-backtick) are excluded from contradiction / dead-ref / vague / redundancy scans.

## Weight rationale

Advisory — weight 0. This check is **quality, not security**: bloated or contradictory instructions degrade agent performance and waste context budget, but they aren't a vulnerability the way a tracked `.env` or a compromised MCP server is. The signals are also heuristic by construction (Jaccard similarity for contradictions, regex pattern matching for vague language, char-count/4 token estimation) and produce a higher false-positive rate than the scored hygiene checks. Keeping it weight-0 lets the signal be surfaced without polluting the scored moat, and avoids the perverse incentive of optimizing instruction files for a linter rather than for the model.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op.

- Every finding here is an edit to human-authored prose. Auto-rewriting governance or skill content is explicitly excluded by rigscore's "--fix never modifies governance content" constraint. Dead references could in principle be auto-removed, but removal is almost never the right fix — the reference usually needs to be redirected, not deleted — so the check emits diagnostics only.

## SARIF

- Tool component: `rigscore`
- Rule ID emitted: `instruction-effectiveness` (check-level; per-finding discrimination via message text, which names the file and line number).
- Level mapping: WARNING → `warning`, INFO → `note`, PASS/SKIPPED → `none`.
- Location data: each finding carries the relative path of the offending file in its title/detail; line numbers are embedded in the message for contradictions, dead refs, and vague directives.

## Example

```
ⓘ instruction-effectiveness — advisory (12 files, ~34.7K tokens, 17.3% of 200K)
  INFO  Instruction files consume 17.3% of context window
  WARNING Large instruction file: .claude/skills/ship/SKILL.md
    ~6,100 estimated tokens.
  WARNING Dead file reference in CLAUDE.md
    Line 42: "docs/old-layout.md" — referenced file not found.
  INFO  Vague instruction in .claude/skills/triage/SKILL.md
    Line 17: "Use your judgment when escalating." — delegates without criteria.
  INFO  Redundant instruction (3 files): "always use absolute paths..."
```

## Scope and limitations

- Files discovered: project `GOVERNANCE_FILES`, `~/.claude/CLAUDE.md`, `~/CLAUDE.md`, `.claude/commands/**`, `.claude/skills/**` in both cwd and homedir, `MEMORY.md` (in cwd and `.claude/`), and any `.md` linked from project-scoped `~/.claude/projects/*/memory/MEMORY.md`.
- Extra governance paths via `config.paths.claudeMd` and `config.paths.governanceDirs`.
- Token estimation is char-count / 4 — a rough conservative heuristic, not a tokenizer.
- Contradiction detection is intra-file only; it does not catch "CLAUDE.md says always X, skill.md says never X."

### Dead-reference noise controls (added 2026-04-20)

- **Line-range suffix stripping** — refs of the form `foo.py:123`, `foo.py:123-456`, and `foo.md#L10-L20` have the suffix stripped before the filesystem existence check, so a valid file with a cited line range is not flagged.
- **Cross-repo exemption via config** — add globs to `.rigscorerc.json`:

  ```json
  {
    "instructionEffectiveness": {
      "crossRepoRefs": ["_active/**", "lib-skill-utils/**", "_foundation/**"]
    }
  }
  ```

  Refs matching any pattern are suppressed even if they don't resolve from the current cwd. Supports `*` (segment) and `**` (any).
- **Project-scoped memory files are exempt** — dead-ref scanning is skipped for files under `~/.claude/projects/<slug>/memory/`. Those describe OTHER projects by design; their references live outside the scanner's cwd.
- **Slash-command + skill-eval exemption** — `.claude/commands/*` and `.claude/skills/*/evals/*` files describe operations over arbitrary target projects. Their references (`pyproject.toml`, `SKILL.md`, `lib-skill-utils/*.sh`) exist in invocation context, not here.
- **Tighter path heuristics** — bare extensions (`.md`, `.sh`), JS property-access strings (`data.filesDiscovered`, `r.findings`), and `python3`/`pip3`/`node22` shell fragments no longer register as file references.

### Known noise modes

- **`instruction-effectiveness/dead-file-reference` across skill `SKILL.md` files** — skills often reference report output paths like `./skill-audit-report.md` that don't exist until the skill runs. These remain flagged. Add the relative form (or a glob) to `crossRepoRefs` if intentional.
- **`Redundant instruction` cross-skill** — sibling skills (e.g. `workflow-maturity` + `instruction-audit`) that share a prelude (`detect project`, `parse the json output`) produce INFO noise proportional to how many skills share prose. Advisory only; consider consolidating into a shared include.
- **`Possible contradiction` from memory file titles** — memory file titles that embed keywords ("Always cache, never recall when rate-limited") match the contradiction regex against themselves. Jaccard threshold catches most of these but a same-line always/never trips the current detector.
