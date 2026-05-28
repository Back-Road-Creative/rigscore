## Summary

`src/index.js run()` was 266 lines — flagged as Complexity #4 (god function) in the 2026-05-27 health report. Two of its branches are self-contained sub-commands that don't share state with the main scan/format/exit flow:

1. **`--init-hook` (~58 lines)** moved to new `src/cli/init-hook.js` as `runInitHook(cwd)`. Includes the `.git` presence check, the already-installed / older-pinned-version detection, the `#!/bin/sh` + pinned `npx -y github:Back-Road-Creative/rigscore@v…` write/append path, and `chmod 755`. Same exit-code contract (0 ok, 1 if no `.git`). `run()` collapses to a single `return runInitHook(cwd)`.
2. **`--baseline` (~30 lines)** moved to `src/cli/baseline.js` as `runBaselineMode(scanResult, baselinePath)`. The companion to the already-extracted `runDiffSubcommand` — both now live next to the shared baseline helpers (`buildBaseline`, `loadBaseline`, `diffFindings`, `flattenFindings`) instead of being inlined in `run()`. Same exit-code contract.

**Net:** `run()` goes from **266 → 193 lines**. The plan target was <100; remaining structure (profile hints, scan dispatch, output format dispatch, --fix, --watch, exit handling) is small per-branch and intertwined with the suppress/score/options flow, so further extraction is left for a follow-up rather than forced here. The two largest self-contained branches are out — `run()` is no longer at the top of the file's complexity ranking.

Closes Complexity #4 (partial).

## Test plan

- [x] `test/init-hook.test.js` (7 tests) — all green; tests still drive through `run(['--init-hook', dir])` so dispatch boundary is exercised end-to-end
- [x] Full `npx vitest run` — 1058 passed, 0 skipped (3 consecutive runs; one transient hit on the pre-existing `test/fixer.test.js > each registered fix has required shape` flake from Wave 7 — module-level state leak across parallel test files, unrelated to this PR)
- [x] `run()` length verified — 193 lines (was 266; -73)
- [x] Diff: 126 insertions, 88 deletions (214 sum)
