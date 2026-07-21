# staged-copy-drift

## Purpose

Some repos track a *copy* of assets whose live original is deployed under the operator's home config dir — skills, agents, hooks, settings. That creates two sources of truth, and they diverge silently: a redeploy that never lands a commit leaves the tracked copy stale, which is worse than an untracked file because it still reads as committed and reviewable. This check hashes each tracked file against its deployed twin and reports the pairs that no longer match. A pass means every configured staged copy is byte-identical to what is deployed.

The live side lives in `$HOME`, so a verdict would depend on whose machine ran the scan. The check is therefore **inert by construction**: with no `--include-home-skills` it returns N/A before reading anything from the home directory (`src/lib/home-scope.js`).

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Tracked file and its deployed twin both exist with different sha256 | WARNING | `staged-copy-drift/content-drift` | Diff both copies, then commit the deployed version or redeploy the tracked one |
| Tracked file with no deployed twin | — | — | Not a finding — tracked-only files (installers, fixtures) are normal |
| No `stagedCopies` rows configured, or every pair matches | PASS | — | — |
| `--include-home-skills` not set | N/A | — | — |

## Weight rationale

**Advisory — weight 0.** The signal is operator-machine-specific: it is only meaningful under `--include-home-skills`, and its verdict depends on a home directory CI never has. A finding that a CI runner structurally cannot reproduce must never move the Security score, so this check reports and never scores, like `documentation` and `agent-output-schemas`.

## Fix semantics

**No auto-fix, deliberately.** Which side is authoritative is a human decision — the deployed file may be the newer version, or the tracked one may be a reviewed change awaiting deployment. A fixer would have to guess a direction and would silently destroy one of the two versions.

- `staged-copy-drift/content-drift` → manual: diff the two paths named in the finding, then commit or redeploy on purpose.
- Out of scope: creating missing deployments, deleting tracked-only files, reconciling permissions or mtimes.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: `staged-copy-drift/content-drift`; the bare `staged-copy-drift` stays registered as a check-level fallback.
- Level mapping: CRITICAL→`error`, WARNING→`warning`, INFO→`note`. `properties.evidence` carries both short hashes (`tracked <8 hex> != deployed <8 hex>`).

## Example

```
⚠ staged-copy-drift — 85/100 (weight 0, advisory)
  WARNING Staged copy drifted from the deployed file: staged/skills/ship/SKILL.md
    tracked 4f2a91c0 != deployed 9b30ee71
```

## Scope and limitations

Configured in `.rigscorerc.json`:

```json
{ "stagedCopies": [{ "tracked": "staged/skills", "deployed": ".claude/skills", "exclude": ["**/*.log"] }] }
```

`tracked` is project-relative, `deployed` is homedir-relative; both must be plain relative paths (absolute or `..` rows are ignored). The walk skips `node_modules`, `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, anything matching a row's `exclude` globs (`*` within a segment, `**` across), and caps at 5000 files per row. Comparison is byte-level sha256 — it says the copies differ, never which is newer.
