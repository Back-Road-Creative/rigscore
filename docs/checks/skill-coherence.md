# skill-coherence

**Enforcement grade:** `keyword` — checks that each skill's SKILL.md contains phrases acknowledging the governance constraints it would exercise. Presence of the right words passes; gameable by stuffing. Advisory only.

## Purpose

Checks that skills and agents act consistently with the governance text that claims to control them, and that permission configurations don't internally contradict themselves. Three sub-checks: (1) **constraint awareness** — when governance declares a rule (e.g. "branch protection enabled"), every skill that performs the corresponding operation (e.g. pushes to git) must reference the rule. (2) **hook↔settings conflicts** — a `PreToolUse` hook that blocks a command pattern while `.claude/settings*.json` `allow` list permits the same pattern is a governance conflict. (3) **settings allow↔deny overlap** — the same `Bash(cmd:*)` prefix appearing in both lists. Maps to OWASP Agentic Top 10 **ASI01 — Agent Authorization & Control Hijacking**: governance–skill drift is how authorized operations bypass declared controls. A passing check means every configured constraint is acknowledged by every skill that would exercise it, and permission config has no self-contradictions.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Skill matches configured `appliesTo` pattern, governance matches `governancePattern`, skill content matches no `awarenessPatterns` | configurable (default WARNING) | `skill-coherence/constraint-unaware-${constraint.id}` † | Add awareness language to the skill, or relax the constraint. |
| Hook content matches `hookPattern` while settings `allow`/`localAllow` contains a match for `settingsPattern` | configurable (default WARNING) | `skill-coherence/hook-settings-allow-conflict` † | Remove the allow entry or update the hook. |
| `Bash(cmd:…)` prefix is identical in `allow` and `deny`, or the `allow` entry is the `deny` entry plus a space-separated suffix (a narrower `allow` shadowing a broader `deny`) | INFO | `skill-coherence/settings-allow-deny-conflict` | Remove one side, or document the intentional precedence. |
| No configuration and no settings conflicts | N/A | — | — |
| Configured but clean | PASS | — | — |

† Both ids are **defaults, not guarantees**: the source emits each as a `||` fallback (`findingId: entry.findingId || '…'`), so a `.rigscorerc.json` entry that sets its own `findingId` replaces it. Absent an override, the hook↔settings row emits `skill-coherence/hook-settings-allow-conflict` verbatim. The constraint-awareness row does not: its id interpolates the *user's* constraint `id`, so the set of ids it can emit **cannot be enumerated ahead of time** — the docs gate prefix-matches it and reports it UNVERIFIED rather than resolved, the only such id in the repo.

## Weight rationale

Advisory — weight 0. Two reasons: (1) **config-dependence** — the constraint-awareness check does nothing on a fresh install; it requires users to define `governancePattern` / `appliesTo` / `awarenessPatterns` triples in `.rigscorerc.json`. Scoring a check that's only meaningful after user configuration would penalize projects for not opting in. (2) **platform/project-shape scope** — hook-conflict detection assumes Claude Code `settings.json` permission semantics and a `PreToolUse` hook file (also opt-in via `config.paths.hookFiles`). Projects not using Claude Code permission hooks would report nothing, so the check has inherently uneven applicability. Keeping it advisory lets teams that do configure it surface the signal without forcing a particular governance shape on everyone else.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op.

- Adding awareness language to a skill is a prose edit inside governance-adjacent content, which rigscore's `--fix` never modifies.
- Resolving hook/settings or allow/deny conflicts requires knowing which side is correct — the user's intent isn't recoverable from the text alone.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `skill-coherence/*` ids in the Triggers table, with `skill-coherence` as the check-level fallback rule. Two of the three are `.rigscorerc.json`-overridable defaults, and the constraint-awareness id is user-config-derived (see the note under the table).
- Level mapping: WARNING → `warning`, INFO → `note`, PASS → `none`.
- Location data: findings carry the skill's relative path in the detail field; settings/hook findings reference the conflicting string rather than a line.

## Example

```
ⓘ skill-coherence — advisory (3 skills analyzed, 1 constraint covered)
  WARNING Missing branch-protection awareness: ship
    Skill "ship" runs `git push` but does not mention the protected-branch
    rule declared in ~/.claude/CLAUDE.md. (skill: .claude/skills/ship/SKILL.md)
  INFO  Settings allow/deny conflict: bash(rm)
    "Bash(rm -rf:*)" in allow list overlaps with "Bash(rm:*)" in deny list.
    Resolution depends on specificity and which settings file has precedence.
```

## Scope and limitations

- **Everything here is opt-in.** A stock rigscore install with no `.rigscorerc.json` produces no findings from the constraint-awareness or hook-conflict sub-checks — they return N/A. The allow↔deny overlap sub-check runs whenever any `.claude/settings*.json` is present.
- Config surface:
  - `config.skillCoherence.constraints` — array of `{ id, governancePattern, appliesTo, awarenessPatterns, finding }`. Patterns may be `RegExp`, string, or `{source, flags}`. Malformed entries are silently dropped.
  - `config.skillCoherence.hookSettingsConflicts` — array of `{ hookPattern, settingsPattern, title, detail, remediation, severity }`.
  - `config.paths.hookFiles` — array of absolute paths; first readable file wins.
  - `config.paths.governanceDirs` — **extra** directories scanned for `.md` governance (content concatenated into the governance corpus before constraint matching). This is **additive** on top of the built-in directory-form rule sets below, not a replacement for them.
- **Directory-form governance is read by default.** The governance corpus for constraint matching also includes the built-in directory-form rule sets — `.cursor/rules/*.mdc`, `.windsurf/rules/`, `.clinerules/`, and `.github/instructions/*.instructions.md` — via the shared `collectGovernanceDirFiles` helper (the same one `governance-docs`, `unicode-steganography`, and `instruction-effectiveness` use). So a repo governed **only** by directory-form rules still exercises constraint awareness; before, this check saw no governance text unless a `.rigscorerc.json` set `governanceDirs`. Per-directory extension policy is vendor-exact and lives in the shared helper. Files returned by both sources are read once (deduped by absolute path).
- Skill discovery scans `.claude/skills/*/SKILL.md` and `.claude/commands/*/SKILL.md` under both cwd and homedir. Project-specific conventions (directory names, governance vocabulary) are **not** baked into this check — everything comes from user config.
- Skills whose content doesn't match `appliesTo` are not evaluated against that constraint. One constraint can therefore apply to a subset of skills.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026) — skills that contradict declared governance as an agentic risk.
