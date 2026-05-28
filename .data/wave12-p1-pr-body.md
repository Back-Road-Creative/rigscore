## Summary

`src/checks/skill-files.js run()` was 472 lines — Complexity #2 (critical) in the 2026-05-27 health report. Three of the inner pattern loops (escalation, persistence, indirect-injection) shared an identical regex-iteration + line-extraction + defensive-context skip body (~13 lines each). Any drift between them was invisible until a fixture test caught a count divergence — flagged separately as Complexity #6.

Phase 1 lands the shared primitives:

- **`forEachPatternMatch(content, patterns, isDefensive, onMatch)`** — handles the g-flag dance, line slicing around `match.index`, and the defensive-context skip. Yields each (pattern, line) pair via callback so callers retain control of their per-match aggregation shape.
- **`accumulatePatternMatches(content, patterns, isDefensive) → { lines, patternSources }`** — convenience wrapper for the simple "collect trimmed line samples + distinct pattern sources" shape used by persistence and indirect-injection.

The escalation loop uses `forEachPatternMatch` directly because its accumulator is keyed by patternId (via `patternIdForEscalation()`) and its per-match work includes a per-patternId allowlist check — `accumulatePatternMatches`'s lines+sources output would discard that information.

**Net: `skill-files.js run()` goes from 472 to 434 lines.** Three of the biggest copy-paste blocks collapse to 5-line calls plus the caller-specific accumulator. Behavior is bit-identical — same findings, same severities, same evidence strings.

Phase 2 will tackle the larger per-pattern-family extractions (`checkInjection`, `checkShellExec`, `checkExfiltration`, `checkUnicode`, `checkPosixPermissions`) targeting a further ~120-line reduction.

Closes Complexity #2 (partial) and Complexity #6 (full).

## Test plan

- [x] 5 new direct unit tests for the helpers:
    - Collects one entry per non-defensive match across multiple patterns
    - `isDefensive` predicate suppresses matches on flagged lines
    - Honors a non-global regex by re-compiling with the `g` flag internally
    - Always-defensive returns empty even when patterns match every line
    - `forEachPatternMatch` yields each `(pattern, line)` pair to the callback
- [x] 4 skill-file end-to-end tests still pass (`test/skill-files.test.js` 23, `test/skill-hardening.test.js` 36, `test/injection-evasion.test.js` 8, `test/skill-files-project-scope.test.js` 7 = **69 passing**)
- [x] Full `npx vitest run` — 1072 passed (was 1067 + 5 new), 0 skipped, 0 failures
- [x] Diff: 122 insertions, 52 deletions (174 sum)
