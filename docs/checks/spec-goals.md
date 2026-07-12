# spec-goals

## Purpose

Scores whether a repo actually drives its agents from written goals and specs, rather than from vibes. Maps to **ASI01 — Agent Goal Hijack**: an agent with no stated goal, or one pointed at an unfilled template, has nothing to be hijacked *away from*. A pass means the governing goal file is real rather than boilerplate, and every spec the repo carries was decomposed into executable tasks. A failure usually means spec-driven development was adopted and then abandoned halfway — the scaffolding is on disk, the discipline is not.

Two layouts are recognised, each confirmed against its primary source:

| Framework | Detected by | Primary source |
|---|---|---|
| GitHub Spec Kit | `.specify/` + `specs/<NNN-name>/spec.md` | [github/spec-kit README](https://raw.githubusercontent.com/github/spec-kit/main/README.md) |
| AGENTS.md | `AGENTS.md` at repo root | [agents.md](https://agents.md/) |

A bare `specs/` dir is **not** enough to trigger Spec Kit detection — `specs/` is far too common (RSpec suites, OpenAPI bundles, prose design docs). It counts only when `.specify/` sits beside it.

## Not covered (yet)

This check answers **completeness** — is the spec scaffolding real and finished? It does not yet answer **liveness** — are those artifacts still being maintained? Nor does it read two further layouts whose conventions are confirmed. All three are follow-ups against this now-existing module; the omissions are scope, not oversight.

**Goal-file drift (liveness).** Deferred, with its design settled: compare the goal file's last-commit date against the newest spec's last-commit date, both from local git (`git log -1 --format=%cI -- <path>`, offline and read-only). Flag at a **90-day** gap — one quarter, long enough that the goal file has demonstrably sat out a planning cycle while specs kept moving, short enough to catch drift while it is cheap to fix. The comparison must be *relative*, so a whole-repo rebase (which rewrites every committer date together) cannot manufacture a finding. Where git history is unavailable — no `.git`, no `git` on PATH, or a shallow clone that dates every file to one commit — **skip, never guess**. Severity INFO: dates proxy attention rather than measure it, and a false "your spec is stale" is worse than a miss.

| Framework | Confirmed layout | Primary source |
|---|---|---|
| Kiro | `.kiro/specs/<name>/` with `requirements.md` (bug specs use `bugfix.md`), `design.md`, `tasks.md`; EARS-style `WHEN … THE SYSTEM SHALL …` | [kiro.dev/docs/cli/v3/specs](https://kiro.dev/docs/cli/v3/specs/) |
| OpenSpec | `openspec/changes/<name>/` with `proposal.md`, `design.md`, `tasks.md`; `openspec/specs/<domain>/spec.md`; shipped work parked under `changes/archive/` | [OpenSpec getting-started](https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/getting-started.md) |

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.specify/` exists but `.specify/memory/constitution.md` does not | WARNING | `spec-goals/constitution-missing` | Run `/speckit.constitution` or author the file |
| Constitution still carries ≥2 template tokens (`[PROJECT_NAME]`, …) or is under 100 chars | WARNING | `spec-goals/constitution-placeholder` | Replace placeholders with real principles |
| A spec dir has a spec but no `tasks.md` | INFO | `spec-goals/spec-dir-no-tasks` | Decompose the spec into tasks, or archive it |
| `AGENTS.md` names no runnable setup/test/build command | INFO | `spec-goals/agents-md-hollow` | Add the concrete commands an agent must run |
| Spec artifacts present and complete | PASS | — | — |
| No spec layout at all (`.specify/` and `AGENTS.md` both absent) | N/A | — | — |

**Severity rationale.** The two WARNINGs are the zero-false-positive cases: a missing file is mechanical, and a constitution still containing `[PROJECT_NAME]` is *provably* the untouched template — no honest repo emits that string on purpose. The other two are INFO because a legitimate repo can explain them: a spec with no `tasks.md` may simply be mid-flight, and an `AGENTS.md` may deliberately delegate its commands to `CONTRIBUTING.md` or a `Makefile`. Incompleteness is reported, never punished.

## Weight rationale

**Advisory — weight 0.** Deliberate: spec-driven development is a young, fast-moving convention, and the healthy-repo baseline for "should this project have a constitution?" is not yet established. Report first, score later — the check earns a weight once its finding rate on real repos is known. Advisory checks are excluded from the applicable set in `src/scoring.js`, so this cannot move an overall score.

## Fix semantics

No auto-fix. The module exports no `fixes` array, so `--fix --yes` is a no-op for every finding here.

- `spec-goals/constitution-missing` and `-placeholder` → not auto-fixed: only maintainers know the principles, and generating an empty constitution would satisfy the check while defeating it.
- `spec-goals/spec-dir-no-tasks` → not auto-fixed: task decomposition is authoring work, not a file-shape repair.
- `spec-goals/agents-md-hollow` → not auto-fixed: rigscore cannot know the project's real build and test commands.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: the four `spec-goals/*` findingIds in the Triggers table, verbatim.
- Level mapping: WARNING→`warning`, INFO→`note`. The check emits no CRITICAL.
- Location data: project root. Findings carry the offending path in `properties.context` (`file` or `specDir`) rather than a line number — each is about a file's existence or whole-file content, not a specific line.

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
- **Completeness only, not liveness.** The check reads what is on disk; it never asks whether the artifacts are still maintained. A fully-populated but long-abandoned spec tree passes. Drift detection is the deferred follow-up — see "Not covered (yet)".
- **Hollow-AGENTS.md detection is content-based, not heading-based**, because agents.md states outright that headings are not normative ("use any headings you like"). The check looks for a runnable command token (`npm`, `pytest`, `make`, `cargo`, `docker`, …) anywhere in the file. A repo whose commands genuinely live elsewhere will be flagged — suppress `spec-goals/agents-md-hollow` in `.rigscorerc.json`.
- **No config surface.** `src/config.js` merges an allowlist of known keys, so a user-supplied `specGoals` block would be silently dropped rather than honoured; any future threshold (e.g. the deferred 90-day drift window) needs a `DEFAULTS` entry in that shared file. Suppression via `.rigscorerc.json` works today.
- **OpenSpec `project.md` is not a real path.** It appears in secondhand write-ups but in no primary source — OpenSpec's own repo and docs use `openspec/config.yaml`. Noted so the Kiro/OpenSpec follow-up does not encode it by mistake.
