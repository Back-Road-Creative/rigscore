## Summary

Phase 2a of the `skill-files.js` god-function decomposition (Complexity #2, critical). Extracts three pattern-scanning helpers from `run()` into exported functions:

- **`checkInjection(file)`** — single-line + 2-line sliding window injection detection with defensive-context downgrade. Returns up to 1 finding.
- **`checkShellExec(file, allowlist)`** — aggregated per-file shell-exec finding using `accumulatePatternMatches` (from Phase 1); severity escalates to CRITICAL at 3+ distinct patterns; honors per-file shell-exec allowlist.
- **`checkExfiltration(file, allowlist)`** — first-match-wins exfiltration detection, suppressed by defensive context or per-file allowlist.

**`run()` shrinks from 434 to 318 lines (-116).** The per-file body is now a short sequence of `findings.push(...checkX(file, allowlist))` calls for the extracted families. `checkUnicode` + `checkPosixPermissions` extraction will follow in Phase 2b to keep this PR's diff in budget.

**Behavior is bit-identical** — same findings, severities, evidence strings, context payloads. All 94 existing skill-file end-to-end tests still pass.

Closes Complexity #2 (partial — Phase 2b finishes the `run()` reduction).

## Diff-cap note

Split from a larger Phase 2 change that was 557 sum (had all 5 helpers + 13 unit tests in one PR). This PR lands 3 helpers + 7 unit tests at **331 sum (208 ins, 123 del)** — slightly over the 300 cap but a pure code-motion refactor with no logic change, well within JP's documented "2-3× for refactors / lock refreshes" tolerance. The remaining 2 helpers + their tests ship as Phase 2b.

## Test plan

- [x] 7 new direct unit tests for the extracted helpers:
    - `checkInjection`: single-line CRITICAL, defensive-context downgrade to info, 2-line sliding window
    - `checkShellExec`: 3+ distinct patterns → CRITICAL with matches count; allowlist entry suppresses entirely
    - `checkExfiltration`: first-match WARNING; allowlist entry suppresses entirely
- [x] All 94 skill-file end-to-end tests still green (`test/skill-files.test.js` 30, `test/skill-hardening.test.js` 36, `test/injection-evasion.test.js` 8, `test/skill-files-project-scope.test.js` 7, `test/unicode-steganography.test.js` 13)
- [x] Full `npx vitest run` — 1079 passed (was 1072 + 7 new), 0 skipped, 0 failures
- [x] `run()` length: 434 → 318 lines (-116)
