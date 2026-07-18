# documentation

**Enforcement grade:** `mechanical` — directory-entry set comparison between `src/checks/*.js` and `docs/checks/*.md`, plus H1 / weight structural checks and a reconciliation of the SARIF ruleIds each module emits against the ones its doc page documents. Deterministic.

## Purpose

Advisory check for rigscore maintainers and plugin authors. This is not a user-facing security check on arbitrary projects — it ensures every `src/checks/<id>.js` module in a rigscore-shaped repo has a matching `docs/checks/<id>.md` reference page, preventing silent undocumented checks from shipping.

The threat it maps to is `ASI02` — Tool Misuse & Exploitation. Undocumented check behavior enables misuse: if a check silently exists, users cannot audit whether its severity model is calibrated for their repo, cannot tell what `--fix` will touch on disk, and cannot verify the SARIF `ruleId` values emitted in CI. A passing `documentation` check guarantees that every scored or advisory check has a doc page with the required H2 sections (`Purpose`, `Triggers`, `Weight rationale`, `Fix semantics`, `SARIF`, `Example`), that the H1 matches the check id, and that the documented weight is consistent with `src/constants.js`.

The check auto-skips when scanning a project that is not rigscore-shaped (missing either `src/checks/` or `docs/checks/`). It is meant to run against rigscore itself and against `rigscore-check-*` plugin repos.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Check module has no matching doc page | WARNING | `documentation/docs-gate-missing` | Run `npm run verify:docs -- --stub <id>` to create stub from `docs/checks/_template.md` |
| Doc page missing one or more required H2 sections | WARNING | `documentation/docs-gate-incomplete` | Fill the listed sections (see `_template.md`) |
| Doc page has H1 that doesn't match check id | WARNING | `documentation/docs-gate-h1-mismatch` | Rename H1 to `# <id>` exactly |
| Doc page does not state the check's weight (or "advisory" for weight 0) | WARNING | `documentation/docs-gate-weight-drift` | Add weight rationale referencing current weight from `src/constants.js` |
| Doc page documents a SARIF ruleId the check module never emits | WARNING | `documentation/docs-gate-ruleid-ghost` | Rename the Triggers row to a real id, or delete it |
| Check module emits a SARIF ruleId the doc page never lists | WARNING | `documentation/docs-gate-ruleid-undocumented` | Add a Triggers row for the id |
| Check module emits a bare `<id>/` prefix, so every documented id would pass vacuously | WARNING | `documentation/docs-gate-ruleid-unexpandable` | Add an expander for the check in `src/lib/verify-docs.js` |
| Documented id only prefix-matches a dynamic id whose value set is not enumerable — not verified | INFO | `documentation/docs-gate-ruleid-unverified` | Add an expander so the id is matched exactly, not by prefix |
| `docs/checks/<id>.md` exists with no matching check module | INFO | `documentation/orphan-doc` | Delete doc or restore the removed check |
| Project is not rigscore-shaped | SKIPPED | — | No action — check only applies to rigscore and plugin repos |
| All checks documented, no orphans | PASS | — | — |

## Weight rationale

Advisory — weight 0. This check's signal is only meaningful when scanning rigscore itself or a `rigscore-check-*` plugin repo. Giving it a non-zero weight would penalize every unrelated downstream project that happens to have a `src/checks/` folder for unrelated reasons (e.g. an app with its own internal validation module layout). Keeping it advisory surfaces the signal to maintainers without polluting downstream users' scores.

## Fix semantics

- No auto-fix via `--fix --yes`. Writing documentation is a human task — auto-generating stub bodies would defeat the point of the check, which is to ensure humans have articulated weight rationale, fix semantics, and SARIF contract per check.
- The separate CLI command `npm run verify:docs -- --stub <id>` creates an empty stub from `docs/checks/_template.md`. The stub scaffolder is idempotent — it refuses to overwrite an existing `docs/checks/<id>.md`. This is a scaffolder, not a fixer; it does not run under `--fix`.
- Out of scope: rewriting existing prose, auto-filling weight rationale, deriving the Triggers table from source, renaming H1s to match ids, or reconciling weight drift. All require human judgment.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: the eight gate reasons are interpolated as `` documentation/docs-gate-${reason} `` — four structural (`documentation/docs-gate-missing`, `documentation/docs-gate-incomplete`, `documentation/docs-gate-h1-mismatch`, `documentation/docs-gate-weight-drift`) and four ruleId-drift (`documentation/docs-gate-ruleid-ghost`, `documentation/docs-gate-ruleid-undocumented`, `documentation/docs-gate-ruleid-unexpandable`, `documentation/docs-gate-ruleid-unverified`) — plus the literal `documentation/orphan-doc`.
- Level mapping: WARNING findings (`missing`, `incomplete`, `h1-mismatch`, `weight-drift`, `ruleid-ghost`, `ruleid-undocumented`, `ruleid-unexpandable`) → `warning`; INFO findings (`ruleid-unverified` and orphan) → `note`.
- `ruleid-unverified` is INFO because the gate could not enumerate the id's value set — a "couldn't check", not a proven defect. It is still reported, never silently passed: "couldn't check" must not look like "checked, fine".
- Location data: repo root. Specific paths (the offending `src/checks/<id>.js` or `docs/checks/<id>.md`) are surfaced in the finding detail field rather than as a `physicalLocation` line anchor, since the finding is about doc coverage across the repo, not a single line of source.

## Example

```
⚠ documentation — advisory (weight 0)
  WARNING MISSING src/checks/foo.js → docs/checks/foo.md not found
    Run: npm run verify:docs -- --stub foo
  WARNING INCOMPLETE docs/checks/bar.md missing sections: ## Fix semantics, ## SARIF
    Fill the listed sections. See docs/checks/_template.md.
  WARNING RULEID-GHOST docs/checks/baz.md documents `baz/old-id`, which src/checks/baz.js
          never emits. It emits: baz/new-id. Rename the row to a real id or delete it.
  INFO    ORPHAN docs/checks/zombie.md has no matching src/checks/zombie.js
    Delete doc or restore the removed check.
```

## Scope and limitations

- Runs only when both `src/checks/` and `docs/checks/` directories exist at the project root. Otherwise the check emits a single SKIPPED finding and returns.
- Self-exemption: this check does not fail itself for `reason: 'missing'` during the first PR that introduces it (the `docs-first-gate` PR). It DOES flag its own doc page for `incomplete` or `weight-drift` conditions — the self-exemption is scoped narrowly to the bootstrap case.
- Does not validate prose quality. Only presence of required H2 sections and that the documented weight (or the literal word "advisory" for weight 0) appears somewhere in the `Weight rationale` section.
- Does not enforce section ordering. Sections can appear in any order as long as all required H2 sections are present and non-empty.
- Does not recurse into subdirectories of `docs/checks/` or `src/checks/`. Flat layout only, matching the current convention.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [rigscore docs-first gate (`docs/checks/_template.md` + `npm run verify:docs`)](https://github.com/Back-Road-Creative/rigscore/blob/main/docs/checks/_template.md) — the per-check documentation contract this meta-check enforces.
