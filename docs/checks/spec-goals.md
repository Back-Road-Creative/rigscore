# spec-goals

## Purpose

Scores whether a repo actually drives its agents from written goals and specs, rather than from vibes. Maps to **ASI01 — Agent Goal Hijack**: an agent with no stated goal, or one pointed at an unfilled template, has nothing to be hijacked *away from*. A pass means the governing goal file is real rather than boilerplate, and every spec the repo carries was decomposed into executable tasks. A failure usually means spec-driven development was adopted and then abandoned halfway — the scaffolding is on disk, the discipline is not.

Four layouts are recognised, each confirmed against its primary source. Each is gated on its **marker dir**, never on a spec dir alone — a bare `specs/` is far too common (RSpec suites, OpenAPI bundles, prose design docs) to read as spec-driven development on its own.

| Framework | Detected by | Primary source |
|---|---|---|
| GitHub Spec Kit | `.specify/` + `specs/<NNN-name>/spec.md` | [github/spec-kit README](https://raw.githubusercontent.com/github/spec-kit/main/README.md) |
| AGENTS.md | `AGENTS.md` at repo root | [agents.md](https://agents.md/) |
| Kiro | `.kiro/` + `.kiro/specs/<name>/` with `requirements.md` (bug specs use `bugfix.md`), `design.md`, `tasks.md` | [kiro.dev/docs/cli/v3/specs](https://kiro.dev/docs/cli/v3/specs/) |
| OpenSpec | `openspec/` + `openspec/changes/<name>/` with `proposal.md`, `design.md`, `tasks.md`; `openspec/specs/<domain>/spec.md`; shipped work parked under `changes/archive/` | [OpenSpec getting-started](https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/getting-started.md) |

Liveness is answered by one INFO trigger: the goal file (Spec Kit's constitution, else `AGENTS.md`) is compared against the newest spec by **local git committer date** (`git log -1 --format=%cI -- <path>`, offline, read-only) and flagged at a **90-day** gap. The comparison is *relative*, so a whole-repo rebase — which rewrites every committer date together — cannot manufacture a finding.

## Not covered (yet)

- **Requirement grammar is not read.** A Kiro `requirements.md` counts by existing; its EARS-style `WHEN … THE SYSTEM SHALL …` sentences are never parsed, so a file of freeform prose passes.
- **OpenSpec's living specs are dated, not audited.** `openspec/specs/<domain>/spec.md` feeds the drift comparison but is never completeness-checked — an empty or missing domain spec raises nothing.
- **Per-spec staleness and archive hygiene.** Only the *goal* file's liveness is measured. A spec tree that has itself been abandoned wholesale, or an archive that never gets swept, reads as fine.
- **The drift window is not tunable** — see "No config surface" below.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.specify/` exists but `.specify/memory/constitution.md` does not | WARNING | `spec-goals/constitution-missing` | Run `/speckit.constitution` or author the file |
| Constitution still carries ≥2 template tokens (`[PROJECT_NAME]`, …) or is under 100 chars | WARNING | `spec-goals/constitution-placeholder` | Replace placeholders with real principles |
| A spec dir has a spec but no `tasks.md` | INFO | `spec-goals/spec-dir-no-tasks` | Decompose the spec into tasks, or archive it |
| A Kiro/OpenSpec spec dir has a spec but no `design.md` | INFO | `spec-goals/spec-dir-no-design` | Write the design, or archive the change |
| The goal file's last commit trails the newest spec's by ≥90 days | INFO | `spec-goals/goal-file-stale` | Re-read the goal file against the newest specs and update what no longer holds |
| `AGENTS.md` names no runnable setup/test/build command | INFO | `spec-goals/agents-md-hollow` | Add the concrete commands an agent must run |
| Spec artifacts present and complete | PASS | — | — |
| No spec layout at all (`.specify/` and `AGENTS.md` both absent) | N/A | — | — |

**Severity rationale.** The two WARNINGs are the zero-false-positive cases: a missing file is mechanical, and a constitution still containing `[PROJECT_NAME]` is *provably* the untouched template — no honest repo emits that string on purpose. The rest are INFO because a legitimate repo can explain them: a spec with no `tasks.md` or `design.md` may simply be mid-flight, an `AGENTS.md` may deliberately delegate its commands to `CONTRIBUTING.md` or a `Makefile`, and a goal file can be both current and untouched — dates proxy attention rather than measure it, and a false "your goal file is stale" is worse than a miss. Incompleteness is reported, never punished.

## Weight rationale

**Advisory — weight 0.** Deliberate: spec-driven development is a young, fast-moving convention, and the healthy-repo baseline for "should this project have a constitution?" is not yet established. Report first, score later — the check earns a weight once its finding rate on real repos is known. Advisory checks are excluded from the applicable set in `src/scoring.js`, so this cannot move an overall score.

## Fix semantics

No auto-fix. The module exports no `fixes` array, so `--fix --yes` is a no-op for every finding here.

- `spec-goals/constitution-missing` and `-placeholder` → not auto-fixed: only maintainers know the principles, and generating an empty constitution would satisfy the check while defeating it.
- `spec-goals/spec-dir-no-tasks` and `-no-design` → not auto-fixed: decomposition and design are authoring work, not file-shape repairs.
- `spec-goals/agents-md-hollow` → not auto-fixed: rigscore cannot know the project's real build and test commands.
- `spec-goals/goal-file-stale` → not auto-fixed: the repair is re-reading the goal file, and a no-op commit that resets the clock would defeat the check.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: the six `spec-goals/*` findingIds in the Triggers table, verbatim.
- Level mapping: WARNING→`warning`, INFO→`note`. The check emits no CRITICAL.
- Location data: project root. Findings carry the offending path in `properties.context` (`file` or `specDir`) rather than a line number — each is about a file's existence or whole-file content, not a specific line. `goal-file-stale` also carries `newestSpec`, `gapDays`, and `thresholdDays` so a reader can audit the comparison without re-running git.

## Example

```
✓ spec-goals ...................... [keyword] advisory
  WARNING Constitution is still an unfilled template
    .specify/memory/constitution.md still holds 6 unreplaced template tokens
    ([PROJECT_NAME], [PRINCIPLE_1_NAME], [PRINCIPLE_1_DESCRIPTION]) — agents
    are pointed at boilerplate.
  INFO Spec `specs/001-example` has no `tasks.md`
    specs/001-example/ holds a spec but no tasks.md — it was never decomposed
    into executable work, so agents improvise around it.
```

## Scope and limitations

- **Root-scoped.** Only the scan root is inspected (`<cwd>/.specify`, `<cwd>/specs`, `<cwd>/AGENTS.md`). Nested per-package `AGENTS.md` files — which agents.md explicitly supports — are not walked, so a monorepo whose only `AGENTS.md` sits in a sub-package reads as N/A.
- **The drift heuristic measures commits, not attention.** Committer dates are a weak proxy in both directions. A one-word typo fix to the goal file resets the clock without anyone re-reading it, so the check is trivially defeated by anyone who wants to; conversely a goal file that is genuinely correct and therefore untouched reads as stale — which is why it is INFO and never scores. Squash-merge and rebase workflows compress unrelated edits onto one date; a repo that vendors its specs from elsewhere dates them by the import, not the authoring. Where git cannot answer at all — no `.git`, no `git` on PATH, a shallow clone, or an uncommitted goal file — the check **skips silently rather than guessing**, so absence of the finding is never evidence of freshness.
- **One goal file, root-scoped.** Drift dates the constitution when Spec Kit is installed, otherwise `AGENTS.md` — never both, and never a Kiro steering doc.
- **Hollow-AGENTS.md detection is content-based, not heading-based**, because agents.md states outright that headings are not normative ("use any headings you like"). The check looks for a runnable command token (`npm`, `pytest`, `make`, `cargo`, `docker`, …) anywhere in the file. A repo whose commands genuinely live elsewhere will be flagged — suppress `spec-goals/agents-md-hollow` in `.rigscorerc.json`.
- **No config surface.** `src/config.js` merges an allowlist of known keys, so a user-supplied `specGoals` block would be silently dropped rather than honoured. The 90-day drift window is therefore a module constant, not a setting; making it tunable needs a `DEFAULTS` entry in that shared file. Suppression via `.rigscorerc.json` works today.
- **OpenSpec `project.md` is not a real path.** It appears in secondhand write-ups but in no primary source — OpenSpec's own repo and docs use `openspec/config.yaml`. Noted so the Kiro/OpenSpec follow-up does not encode it by mistake.
