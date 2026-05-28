## Summary

Adds `@vitest/coverage-v8@3.2.4` as a devDependency. Required peer dep for `vitest --coverage` with the v8 provider.

Lands as its own PR — with its ~864-line lockfile delta — so the follow-up Wave 6 PR (which actually enables the coverage gate in `vitest.config.js` and adds `--coverage` to `ci.yml`) stays under the 300-sum diff cap.

**No behavior change on its own.** `npm test` still runs without `--coverage`; the dep is dormant until the follow-up PR opts the CI step into it. Splitting this way also keeps the lockfile churn isolated to a pure dep-add commit, easier to audit than a mixed config-and-deps PR.

Wave 6a of the fix plan (split from Wave 6 for diff-cap reasons).

## Test plan

- [x] `npm ci` — clean install from the bumped lockfile, no warnings beyond the pre-existing 2 transitive vulnerabilities
- [x] `npm test` — 1049 passed, 2 skipped, 0 failures (unchanged from main)
- [x] Verified `npm test -- --coverage` works locally; the actual coverage gate lands in Wave 6b
- [x] Diff: 864 insertions, 0 deletions — entirely lockfile add + 1 line of package.json
