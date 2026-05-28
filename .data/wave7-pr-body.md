## Summary

Three docs/quality polish items from the 2026-05-27 health report. No behavior change — JSDoc + one comment.

1. **`src/index.js parseArgs` JSDoc.** Recognized flags (with implication chains for `--ci`, `--depth`, `--refresh-mcp-registry`), how bare positionals are treated as the target directory (last positional wins), and that unknown flags are ignored because subcommands are dispatched in `bin/rigscore.js` before parseArgs sees them. (Gaps #5)
2. **`src/index.js run` JSDoc.** Entry-point flow, exit code contract (0 clean / 1 below-threshold or new-vs-baseline / 2 argument-or-scan error), and the three short-circuit modes (`--init-hook`, `--baseline`, `--watch`) that don't follow the normal scan→format→exit path. (Gaps #6)
3. **`src/reporter.js createRequire` rationale.** Inline comment explains the shim: `import pkg from '../package.json' with { type: 'json' }` is stable on Node ≥20.10 but still gated behind a flag on the project's 18.17 engine floor (see `package.json#engines`). Notes the upgrade path. (Quality #3)

## Plan items I did not change (with reasons)

- **Quality #1** — `'.mcp' + '.' + 'json'` concat in `src/utils.js:134`. Load-bearing: the T2.9 grep guard in `test/mcp-runtime-hash.test.js` fails any `src/` file that both imports `child_process` and references `.mcp.json` literally. `utils.js` imports `child_process` via `execSafe`. The existing in-file comment already documents this; inlining the literal would trip the guard.
- **Quality #2** — for-loop → for...of style consistency. The three c-style loops still in tree (`src/index.js:39`, `src/scanner.js:427`, `src/checks/mcp-config.js:76`) all use `i + 1` lookahead or `i += CONCURRENCY` chunking; none convert cleanly to `for...of`. The original plan referenced `flagPatterns.length`, but no such loop exists in the current code — that style migration happened in a prior PR.

## Test plan

- [x] Full `npx vitest run` — 1049 passed, 2 skipped, 0 failures (3 consecutive green runs)
- [x] Noted a pre-existing flake in `test/fixer.test.js > fixer self-registration > each registered fix has required shape` that surfaced once during this session (1 failure in a single run, then 3 consecutive clean runs). Module-level `_registeredFixes` state leaking across parallel test files when `fixer-registration-findingids.test.js`'s `loadChecks` adds findingIds-only fixers and the strict-shape test in `fixer.test.js` iterates them. Not introduced by this PR; worth a dedicated fix in a future wave.
- [x] Diff: 47 insertions, 0 deletions (47 sum)
