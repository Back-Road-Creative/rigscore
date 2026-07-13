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

Liveness is answered by **local git committer date** (`git log -1 --format=%cI -- <path>`, offline, read-only), against a **drift window** that defaults to 90 days and is tunable (see [Configuration](#configuration)). Three things are dated, and **every date compared is one the scanned tree already carries** — the wall clock is never consulted, so a whole-repo rebase (which rewrites every committer date together) cannot manufacture a finding, and no finding can start firing merely because time passed:

- the **goal file** (Spec Kit's constitution, else `AGENTS.md`), flagged when it trails the newest spec by a window;
- each **unfinished spec** — one still missing `tasks.md`/`design.md` — flagged when it trails the newest spec by a window. Staleness is what separates *mid-flight* from *abandoned*: a spec missing its tasks is unremarkable this week and damning a quarter later. A spec that is old but **complete** is finished work and is never flagged.
- the **spec tree as a whole**, against the **scan root's own pulse** — the newest commit touching the scan root (`git log -1 -- .`). A tree where every spec is equally ancient trails nothing, so the two spec-relative findings above are silent on a tree abandoned *wholesale*; this second yardstick catches it. It fires only when both halves of "adopted, then dropped" hold: the repo kept committing for a window while **no** spec moved, **and** unfinished specs are still sitting in the tree.

Archive hygiene is answered without git: an OpenSpec change whose `tasks.md` boxes are **all ticked with none left open** has shipped by the tool's own convention, and belongs under `changes/archive/`.

Two artifacts are read for **content**, not merely counted by existing:

- a **Kiro requirements file** is parsed for [EARS](https://alistairmavin.com/ears/) — the grammar Kiro mandates. Every EARS form (ubiquitous, event-driven `WHEN`, state-driven `WHILE`, optional-feature `WHERE`, unwanted-behaviour `IF … THEN`) bottoms out in the same clause, `THE <system> SHALL <response>`, so that clause is what is matched; clause *order* is not policed. Only lines carrying a normative verb (`shall`, `must`) are judged — a user story or a background paragraph is not a requirement and is never held to the grammar.
- an **OpenSpec living spec** (`openspec/specs/<domain>/spec.md`) is audited against its documented skeleton: `## Purpose`, then `### Requirement:` blocks each carrying at least one `#### Scenario:`. OpenSpec's own authoring guide makes the scenario the testable half — "Every requirement has at least one scenario that actually exercises it" ([writing-specs](https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/writing-specs.md), skeleton in [concepts](https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/concepts.md)).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `specGoals.driftWindowDays` | `90` | Day gap at which the goal file reads as trailing the specs, an unfinished spec reads as abandoned, and an untouched spec tree reads as dormant. |

```json
{ "specGoals": { "driftWindowDays": 45 } }
```

Set in `.rigscorerc.json` (project beats home). One planning quarter is the default; shorten it for a fast-moving repo that wants the nudge sooner, lengthen it for a long-cycle project that would find 90 days noisy. A non-integer or non-positive value is **dropped, not honoured** — the check falls back to 90 rather than throwing. `DEFAULTS` live in `src/config.js`.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.specify/` exists but `.specify/memory/constitution.md` does not | WARNING | `spec-goals/constitution-missing` | Run `/speckit.constitution` or author the file |
| Constitution still carries ≥2 template tokens (`[PROJECT_NAME]`, …) or is under 100 chars | WARNING | `spec-goals/constitution-placeholder` | Replace placeholders with real principles |
| A spec dir has a spec but no `tasks.md` | INFO | `spec-goals/spec-dir-no-tasks` | Decompose the spec into tasks, or archive it |
| A Kiro/OpenSpec spec dir has a spec but no `design.md` | INFO | `spec-goals/spec-dir-no-design` | Write the design, or archive the change |
| The goal file's last commit trails the newest spec's by ≥ the drift window | INFO | `spec-goals/goal-file-stale` | Re-read the goal file against the newest specs and update what no longer holds |
| An **unfinished** spec's last commit trails the newest spec's by ≥ the drift window | INFO | `spec-goals/spec-abandoned` | Finish the spec or archive it |
| The **newest** spec trails the scan root's last commit by ≥ the drift window, and ≥1 spec is unfinished | INFO | `spec-goals/spec-tree-dormant` | Finish or archive the unfinished specs, or drop the spec scaffolding |
| An OpenSpec change has every task ticked, none open, and still sits outside `changes/archive/` | INFO | `spec-goals/change-unarchived` | Sweep it into `changes/archive/`, or reopen the tasks that are not really done |
| A Kiro requirements file states no EARS requirement at all, or mixes EARS with normative lines outside the grammar | INFO | `spec-goals/requirements-not-ears` | Rewrite the acceptance criteria as `WHEN <trigger> THE <system> SHALL <response>` |
| An OpenSpec `specs/<domain>/spec.md` lacks `## Purpose`, holds no `### Requirement:`, or has a requirement with no `#### Scenario:` | INFO | `spec-goals/domain-spec-incomplete` | Fill the domain spec out to OpenSpec's skeleton |
| `AGENTS.md` names no runnable setup/test/build command | INFO | `spec-goals/agents-md-hollow` | Add the concrete commands an agent must run |
| Spec artifacts present and complete | PASS | — | — |
| No spec layout at all (`.specify/` and `AGENTS.md` both absent) | N/A | — | — |

**Severity rationale.** The two WARNINGs are the zero-false-positive cases: a missing file is mechanical, and a constitution still containing `[PROJECT_NAME]` is *provably* the untouched template — no honest repo emits that string on purpose. The rest are INFO because a legitimate repo can explain them: a spec with no `tasks.md` or `design.md` may simply be mid-flight, an `AGENTS.md` may deliberately delegate its commands to `CONTRIBUTING.md` or a `Makefile`, and a goal file can be both current and untouched — dates proxy attention rather than measure it, and a false "your goal file is stale" is worse than a miss. `spec-abandoned` and `spec-goals/spec-tree-dormant` inherit that caveat (a spec — or a whole tree — can be parked on purpose, and a repo may vendor its specs from elsewhere), and `change-unarchived` stays INFO because a team may batch its archive sweeps or tick tasks ahead of the merge. The two content findings are INFO for the same reason: EARS is a house style a team may have deliberately declined, and a domain spec can be thin because the domain is thin. Incompleteness is reported, never punished.

## Weight rationale

**Advisory — weight 0.** Deliberate: spec-driven development is a young, fast-moving convention, and the healthy-repo baseline for "should this project have a constitution?" is not yet established. Report first, score later — the check earns a weight once its finding rate on real repos is known. Advisory checks are excluded from the applicable set in `src/scoring.js`, so this cannot move an overall score.

## Fix semantics

No auto-fix. The module exports no `fixes` array, so `--fix --yes` is a no-op for every finding here.

- `spec-goals/constitution-missing` and `-placeholder` → not auto-fixed: only maintainers know the principles, and generating an empty constitution would satisfy the check while defeating it.
- `spec-goals/spec-dir-no-tasks` and `-no-design` → not auto-fixed: decomposition and design are authoring work, not file-shape repairs.
- `spec-goals/agents-md-hollow` → not auto-fixed: rigscore cannot know the project's real build and test commands.
- `spec-goals/goal-file-stale`, `-spec-abandoned` and `-spec-tree-dormant` → not auto-fixed: the repair is re-reading (or finishing, or deleting) the spec, and a no-op commit that resets the dates would defeat the check.
- `spec-goals/change-unarchived` → not auto-fixed: moving a change dir is a `git mv` rigscore *could* run, but "all boxes ticked" is the tool's convention, not proof the work shipped — only the team knows, and a wrong sweep hides in-flight work.
- `spec-goals/requirements-not-ears` and `-domain-spec-incomplete` → not auto-fixed: rewriting prose into a trigger-and-response, or authoring the scenario that makes a requirement testable, is the requirements work itself. A generated `#### Scenario:` would silence the finding while leaving the requirement exactly as unverifiable as it was.

## SARIF

- Tool component: `rigscore`. Rule IDs emitted: the eleven `spec-goals/*` findingIds in the Triggers table, verbatim.
- Level mapping: WARNING→`warning`, INFO→`note`. The check emits no CRITICAL.
- Location data: project root. Findings carry the offending path in `properties.context` (`file` or `specDir`) rather than a line number — each is about a file's existence or whole-file content, not a specific line. The three dated findings also carry `gapDays` and `thresholdDays` (plus `newestSpec` / `missing` / `unfinished`) so a reader can audit the comparison without re-running git.

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
- **The dormant-tree yardstick is the scan root's own pulse, never the clock.** `spec-goals/spec-tree-dormant` compares the newest spec against the newest commit *touching the scan root* (`git log -1 -- .`). Both dates live inside the scanned tree, which is deliberate: a wall-clock or repo-`HEAD` window would grow on its own, so a tree that passes today would start failing on a date no one chose — including rigscore's own test fixtures, whose commit dates are fixed. Here the gap is frozen at commit time; only a new commit can change a verdict. The cost of that choice is a **deliberate miss**: a repo archived *wholesale* (code stopped when the specs did) has a zero gap and is silent — dormancy is only visible against activity, and a repo with no activity offers nothing to measure against. The **false positive** it buys is a repo that **vendors** its specs from elsewhere: the import commit dates them, so a quarter of unrelated commits makes the vendored tree read as dormant — suppress `spec-goals/spec-tree-dormant` in `.rigscorerc.json`. Because the pathspec is the scan root and not the repo root, scanning a sub-package measures *that* package's pulse, not the monorepo's; and a tree whose specs are all **complete** never fires, on the same "finished work is not abandoned work" rule as `spec-abandoned`.
- **The drift window is one knob, not three.** `specGoals.driftWindowDays` sets the threshold for `goal-file-stale`, `spec-abandoned` *and* `spec-tree-dormant` together — they are the same question ("has a quarter of work gone by without this being touched?") asked of the goal file, of one spec, and of the tree, and splitting them would be a setting per finding with no evidence anyone wants a different number for each.
- **Archive hygiene trusts the checkboxes.** `change-unarchived` reads `tasks.md` markdown, not git or a tracker: a change whose boxes were ticked optimistically before the work landed is flagged early, and one that shipped without anyone ticking a box is missed entirely. It is OpenSpec-only — Spec Kit and Kiro define no archive convention to sweep into.
- **EARS parsing is line-based, and Kiro-only.** Kiro writes one acceptance criterion per bullet, so a line is the unit; a requirement hard-wrapped across two source lines reads as a stray. Spec Kit and OpenSpec mandate no requirement grammar, so their specs are never held to one. The match is deliberately lenient — any `THE … SHALL …` clause counts, whatever the clause order — because a false "your requirements are prose" is worse than missing a malformed one.
- **The domain-spec skeleton is OpenSpec's documented shape, not a validator's schema.** `## Purpose` appears in OpenSpec's own spec example and the requirement→scenario rule is stated outright in its authoring guide, but neither is published as a hard error code, so a team that keeps its living specs deliberately lean will be flagged — suppress `spec-goals/domain-spec-incomplete` in `.rigscorerc.json`.
- **OpenSpec `project.md` is not a real path.** It appears in secondhand write-ups but in no primary source — OpenSpec's own repo and docs use `openspec/config.yaml`. Noted so the Kiro/OpenSpec follow-up does not encode it by mistake.
