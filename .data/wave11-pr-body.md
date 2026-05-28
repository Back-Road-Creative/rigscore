## Summary

`src/index.js parseArgs()` was a 56-line if/else chain — Complexity #7 in the 2026-05-27 health report. Each branch followed one of a handful of shapes (plain bool, override-bool, string-value, parsed-int, comma-list, implication chain), but the chain mixed them all together so every new flag added linear if/else weight.

**Replaced with `FLAG_DEFS` lookup table:**
- Map keyed by literal arg (`'--json'`, `'--check'`, …) for O(1) dispatch.
- Each entry: `{ takesValue?: bool, handler: (options[, value]) => void }`.
- Aliases (`--verbose`/`-v`, `--recursive`/`-r`, `--yes`/`-y`) share one handler object reference so they stay trivially in sync.
- Implication chains (`--ci` → sarif + noColor + noCta; `--refresh-mcp-registry` → online; `--depth` → recursive) live inside the handler closures, same as before.

**Behavior is bit-identical:** same option defaults, same silent-skip for a value-taking flag at end of argv, same silent-ignore for unknown `--flag` (preserves forward-compat for CI scripts that pass through extra flags), same "bare positional → cwd; last positional wins" rule.

Closes Complexity #7.

## Test plan

Test surface widened from 14 to 23. New regressions for:
- [x] `--no-color` isolation (doesn't bleed into noCta)
- [x] `--refresh-mcp-registry` implies `--online`
- [x] `--depth N` implies `--recursive`, parses the integer, falls back to 1 on non-numeric value
- [x] `-v` / `-r` / `-y` short aliases resolve to the same options as their long forms
- [x] Unknown `--flag` is silently tolerated (no crash, no cwd pollution)
- [x] Bare positional becomes cwd; last positional wins when mixed with flags
- [x] Value-taking flag at the end of argv (`--check` with nothing after) is tolerated without crash
- [x] `--ignore` comma list drops empty entries

Also:
- [x] Full `npx vitest run` — 1067 passed (was 1058 + 9 new), 0 skipped, 0 failures
- [x] Diff: 133 insertions, 51 deletions (184 sum)
