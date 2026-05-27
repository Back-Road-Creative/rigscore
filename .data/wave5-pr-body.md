## Summary

Five independent quality/correctness flaws from the 2026-05-27 health report. Each is small on its own but compounding — the slugify drift and the env-exposure ambiguity both surfaced as user-facing surprises.

1. **`mcp-config` shadow variable.** Inner `const registryResult` at line 538 shadowed the outer `registryResult` (the MCP registry fetch result captured at line 221). The shadow made the downstream registry-fallback INFO finding evaluate the loop's last-iteration npm-finding instead of the registry result. Renamed inner to `npmFinding`. (Flaws #3)
2. **`src/index.js` baseline branch — dead ternary.** `process.exit(added.length > 0 ? 1 : 0)` was dead — the early-return at line 334 guarantees `added.length > 0` by the time the ternary runs. Replaced with `process.exit(1)` and added a comment citing the guard. (Flaws #5)
3. **`env-exposure` generic finding when multiple .env files exist.** When `.env`, `.env.local`, and `.env.production` were all present and only `.env` was gitignored, the finding read ".env file found but NOT in .gitignore" — generic and wrong. Collects the unignored files by name, includes them in title + evidence + remediation. (Flaws #6)
4. **`utils` + `scanner` + `cli/baseline` slugify divergence.** Scanner's local `slugify()` and `cli/baseline.js`'s inline slug expression were almost identical, but baseline omitted the `replace(/^-|-$/g, '')` step. Titles with non-alphanumeric bookends produced divergent findingIds across the two paths. Extracted canonical `slugify` to `utils.js`, imported from both call sites, deleted the inline copies. (Flaws #7)
5. **`loadChecks` reset race / silent empty fixer cache.** `_registeredFixes = {}` ran AFTER `await fs.promises.readdir`, so a downstream consumer could observe a stale populated cache during the I/O yield. Moved the reset to entry, before any await. Initial value changed to null so `getRegisteredFixes()` throws a clear error when called before loadChecks (the previous silent empty-map return made `--fix` look like "no fixes available"). (Flaws #8)

## Test plan

- [x] New `test/env-exposure.test.js`: real git-init fixture with `.env` (gitignored) + `.env.production` (not gitignored); asserts finding title contains `.env.production` and evidence lists it
- [x] New `test/baseline.test.js`: 4-case parametrized assertion that `flattenFindings` and `assignFindingIds` produce identical findingIds for titles with non-alphanumeric bookends, whitespace wrap, and punctuation
- [x] Existing fixer tests (`test/fixer.test.js`, `test/fixer-registration-findingids.test.js`) still pass — both call `loadChecks` in `beforeAll`, so the new null-init / throw path doesn't bite
- [x] Full `npx vitest run` — 1049 passed (was 1047), 2 skipped, 0 failures
- [x] Diff: 104 insertions, 34 deletions (138 sum, under 300 cap)
