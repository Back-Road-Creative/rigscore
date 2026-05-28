## Summary

`scripts/verify-docs.js` previously hardcoded `REPO_ROOT` from `__filename`, so it could only verify the rigscore install itself. The test suite documented this limit by `.skip`-ing two integration tests that wanted to spawn the script against a synthetic tmp fixture.

- **CLI: `--cwd <path>` (alias `--root <path>`).** Default unchanged — `REPO_ROOT` resolved from `__filename`, so `npm run verify:docs` and the CI/release workflows behave bit-identically. When `--cwd` is passed, the verify run uses that root for both `src/checks/` scan and `docs/checks/` scan, and `--stub` writes into `<cwd>/docs/checks/`. The stub template is always read from the rigscore install (a user's repo may not ship `_template.md`). Validates the path is a real directory before invoking the library; cleaner error than a downstream `readdir ENOENT`.
- **Library: graceful weights fallback.** `src/lib/verify-docs.js` was hard-failing on repos without `src/constants.js` (the auto-import threw). Wrapped in `try/catch`; falls back to `{}` so weight-drift detection is skipped for fixture and third-party repos that don't ship rigscore's `WEIGHTS` registry. Self-verify still loads rigscore's own WEIGHTS as before.
- **Tests:** unskipped both previously-skipped tests with real `spawn` against a tmp fixture, plus two new tests covering `--cwd` validation (nonexistent target → exit 2, missing path value → exit 2). The suite now reports 1053 passing / 0 skipped (was 1049 / 2 skipped).

Closes Gaps #2 (skipped test 316), Gaps #3 (skipped test 320).

## Test plan

- [x] `npx vitest run test/documentation-check.test.js` — 17 passed (was 15 + 2 skipped)
- [x] Full `npx vitest run` — 1053 passed, **0 skipped**, 0 failures
- [x] Manual: `node scripts/verify-docs.js --cwd /tmp/<fixture>` against a tmp dir with `src/checks/orphan.js` and no docs — exits 1 with `MISSING orphan` line
- [x] Manual: `node scripts/verify-docs.js --cwd /tmp/<fixture> --stub fresh-check` — exits 0 and writes `<fixture>/docs/checks/fresh-check.md` from the template
- [x] Manual: `npm run verify:docs` (no flags) — `docs-gate: OK (21 checks, 21 docs)`, behavior unchanged
- [x] Diff: 125 insertions, 31 deletions (156 sum, under cap)
