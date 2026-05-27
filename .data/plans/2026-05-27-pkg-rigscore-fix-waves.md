# pkg-rigscore Health Fix Plan

**Generated:** 2026-05-27
**Source report:** `.data/health-reports/pkg-rigscore/2026-05-27-health-4.md`
**Strategy verdict:** INCREMENTAL (high confidence) · Overall 7.7/10

## Sequencing rules

- Each wave is one PR, branched from `main`, sized ≤300-sum diff (JP rule).
- Waves are ordered by ROI and by the strategy agent's "avoid rebase pain" guidance — narrow bugfixes land before god-function refactors that rewrite the same files.
- Mechanical test floor: every PR must keep `npx vitest run` green; PRs that change scoring math must include a new test case asserting the new behavior.
- Conventional commit format: `<type>(<scope>): <subject>` matching recent history.

## Wave 1 — Critical user-visible breakage (one PR, ~20 lines)

**Branch:** `fix/explain-dispatch-and-help-catalog`
**Commit:** `fix(cli): wire up explain subcommand dispatch + fill --help check catalog`
**Closes findings:** Completeness #1 (critical), Completeness #2 (warning), Completeness #3 (info), Gaps #1 (info)

| File | Change | Est. lines |
|---|---|---|
| `bin/rigscore.js:29` | Add dispatch block: `if (args[0] === 'explain') { const mod = await import('../src/cli/explain.js'); await mod.runExplainSubcommand(args.slice(1)); process.exit(0); }` | +5 |
| `bin/rigscore.js:89-110` | Append missing check rows to `--help`: `workflow-maturity`, `windows-security`, `network-exposure`, `agent-output-schemas`, `documentation` | +5 |
| `CLAUDE.md` | Add `documentation` and `agent-output-schemas` rows to Check modules table; mark both as advisory (weight 0) | +2 |
| `README.md:8` | Remove obsolete `<!-- TODO: repoint #known-limits ... -->` HTML comment | -1 |
| `test/explain-subcommand.test.js` | Add CLI-route integration test: spawn `node bin/rigscore.js explain <known-id>`, assert exit 0 + non-empty stdout | +15 |

**Test plan:** `npx vitest run test/explain-subcommand.test.js` ; manual smoke `node bin/rigscore.js explain claude-md/missing-claude-md`.

---

## Wave 2 — Score integrity bugs (one PR, ~80 lines)

**Branch:** `fix/dedup-corruption-and-plugin-double-load`
**Commit:** `fix(scanner,plugins): close dedup variant leak and plugin double-registration`
**Closes findings:** Flaws #1 (warning, `scanner.js:39`), Flaws #4 (warning, `checks/index.js:62`)
**Rationale:** Both bugs distort rigscore's own reported scores — they undermine the tool's value before any user-facing fix matters. The strategy agent flagged these as the #2 priority for that reason.

| File | Change | Est. lines |
|---|---|---|
| `src/scanner.js:39 deduplicateFindings` | After the cross-check supersede branch, scan losing-result findings for all entries sharing the same key and add them to `toRemove`. Refactor `seen` to record a list of indices per key instead of overwriting. | +25 / -10 |
| `src/checks/index.js:62 discoverPlugins` | Track loaded plugin module paths in a `Set` keyed by resolved absolute path; skip already-seen entries. Add a final dedup pass by plugin `id` as belt-and-suspenders. | +12 |
| `test/scanner.test.js` | Add fixture: two checks with same normalized-title per-file finding from a losing check; assert deduplicated count. | +20 |
| `test/plugins.test.js` | Add test: plugin present in both `cwd/node_modules` and rigscore's own install dir; assert single registration. | +15 |

**Test plan:** Full `npx vitest run`. Run `node bin/rigscore.js .` before+after on a project with overlapping checks; diff the finding counts.

---

## Wave 3 — Production hardening (one PR, ~50 lines)

**Branch:** `fix/cli-error-handling-symmetry`
**Commit:** `fix(cli): unify error handling — unhandledRejection guard + handleFatal symmetry`
**Closes findings:** Production #1 (warning, `bin/rigscore.js:136`), Flaws #2 (warning, `index.js:251`), Production #2 (warning, `index.js:256`), Production #3 (warning, `index.js:353` — watch-mode early exit)

| File | Change | Est. lines |
|---|---|---|
| `bin/rigscore.js` (top) | `process.on('unhandledRejection', err => { process.stderr.write('rigscore: unexpected error: ' + (err?.message ?? err) + '\n'); process.exit(2); })` | +3 |
| `bin/rigscore.js:136` | Change `run(args)` to `await run(args).catch(handleFatalTopLevel)` where `handleFatalTopLevel` writes a clean message + exits 2 | +6 |
| `src/index.js:251` | Replace inline try/catch in non-recursive path with `handleFatal(err)` call (matches recursive path symmetry) | +3 / -8 |
| `src/index.js:256` | In non-recursive catch, use `const msg = err instanceof Error ? err.message : String(err);` | +2 / -1 |
| `src/index.js:353` | In watch-mode init, downgrade below-threshold initial scan from `process.exit(1)` to `console.warn` + continue into watch loop. Comment cites watcher.js:47 "warn-only in loop" intent. | +5 / -3 |
| `test/cli-flags.test.js` or new `test/error-handling.test.js` | Add test: spawn CLI on a path that throws (e.g., chmod 000 a config file), assert exit code 2 + sanitized stderr. | +25 |

**Test plan:** Full vitest. Manual: `node bin/rigscore.js /nonexistent` should produce a clean message, not a stack trace. `node bin/rigscore.js . --watch --min-score 95` should print warning and enter watch loop.

---

## Wave 4 — Targeted security fixes (one PR, ~60 lines)

**Branch:** `fix/security-narrow-mcp-buffer-cve-protocol`
**Commit:** `fix(security): cap npm registry buffer, reconcile CVE refs, tighten protocol/env checks`
**Closes findings:** Security #1 (warning, npm registry buffer), Security #2 (uncertain, CVE id mismatch), Security #3 (info, deep-secrets pattern leak), Security #4 (info, XDG_CACHE_HOME sanitization), Security #5 (info, https:// strict prefix)
**Watch:** This PR touches `mcp-config.js`. Must land BEFORE Wave 9 (god-function decomposition) per strategy agent guidance.

| File | Change | Est. lines |
|---|---|---|
| `src/checks/mcp-config.js:119 checkNpmRegistry` | Add byte counter in `res.on('data')`; abort with `req.destroy(); resolve(null)` when `data.length > 512 * 1024`. Add `MAX_REGISTRY_BYTES` constant. | +12 |
| `src/checks/mcp-config.js:378` | Audit CVE block: pick the correct ID for ANTHROPIC_BASE_URL-redirect class. Update comment + learnMore URL to match. (Requires reading the linked post.) | +3 / -3 |
| `src/checks/deep-secrets.js:158` | Replace `result.pattern.source.slice(0, 30)` in finding `detail` with a stable label from a pattern-name map (or `result.patternId`). | +6 / -2 |
| `src/mcp-registry.js:37 getDefaultCachePath` | Validate XDG_CACHE_HOME stays under `os.homedir()`; fall back to default if not. | +8 |
| `src/http.js:22 fetchHeaders` | `url.startsWith('https')` → `url.startsWith('https://')` (include slashes); apply to all protocol dispatch sites. | +2 / -2 |
| `test/mcp-config.test.js` | Add test: mock https stream that emits >512KB; assert request is aborted and finding is null/handled. | +20 |
| `test/secret-patterns.test.js` | Assert finding `detail` does not contain raw regex source. | +5 |

**Test plan:** Full vitest. Online-mode probe: confirm npm registry fetch still works on a small package and aborts on a synthetic large response.

---

## Wave 5 — Remaining independent flaws (one PR, ~70 lines)

**Branch:** `fix/independent-flaws-cleanup`
**Commit:** `fix(scanner,checks,cli): close env-exposure ambiguity, baseline slugify drift, registryResult shadow, dead ternary, loadChecks reset race`
**Closes findings:** Flaws #3 (registryResult shadow rename), Flaws #5 (dead ternary), Flaws #6 (env-exposure ambiguity), Flaws #7 (baseline slugify divergence), Flaws #8 (loadChecks reset)

| File | Change | Est. lines |
|---|---|---|
| `src/checks/mcp-config.js:510` | Rename inner `registryResult` → `npmFinding` (variable shadowing) | +1 / -1 |
| `src/index.js:349` | Replace `process.exit(added.length > 0 ? 1 : 0)` with `process.exit(1)` + comment citing the guard at line 334 | +2 / -1 |
| `src/checks/env-exposure.js:178` | Track which `.env*` file failed `isInGitignore`; include in finding title + `evidence` field | +8 / -3 |
| `src/utils.js` | Extract canonical `slugify` from `scanner.js:81`; export as `slugify(title)`. | +6 |
| `src/scanner.js:81` | Replace local `slugify` with import from utils | +1 / -5 |
| `src/cli/baseline.js:19 flattenFindings` | Use imported `slugify` instead of inline `replace().slice()` | +1 / -1 |
| `src/checks/index.js:8 loadChecks` | Move `_registeredFixes = {}` reset BEFORE the `await fs.promises.readdir` to close the concurrent-load race. Add assertion in `findApplicableFixes` that `_registeredFixes` was populated. | +5 / -2 |
| `test/env-exposure.test.js` | Assert finding title contains the specific filename when multiple .env files exist. | +15 |
| `test/baseline.test.js` | Add finding-id consistency test: same title → same id via both `assignFindingIds` and `flattenFindings`. | +15 |

**Test plan:** Full vitest. Manual: run `rigscore` against a project with `.env` and `.env.local` where only `.env` is gitignored; confirm output names the offender.

---

## Wave 6 — CI/Docker production polish (one PR, ~50 lines)

**Branch:** `chore/ci-docker-coverage-and-pinning`
**Commit:** `chore(ci): pin Dockerfile base, enforce coverage gate, add verify:docs to release`
**Closes findings:** Production #4 (Dockerfile pin), Production #5 (coverage gate), Production #6 (release verify:docs), Production #7 (headlessmode PAT scope), Production #8 (vitest timeout doc)

| File | Change | Est. lines |
|---|---|---|
| `Dockerfile:7` | Pin `FROM node:20-alpine@sha256:<resolved-digest>` (resolve via `docker pull` first); add comment with refresh procedure | +2 / -1 |
| `vitest.config.js` | Add `coverage: { provider: 'v8', thresholds: { lines: 40 } }` | +6 |
| `.github/workflows/ci.yml` | Change test step to `npm test -- --coverage` | +1 / -1 |
| `.github/workflows/release.yml:54` | Add `Run verify:docs` step after test, mirroring ci.yml gate | +4 |
| `.github/workflows/release.yml:101` | Move headlessmode clone-and-execute into a separate job with `permissions: { contents: read }`; require explicit `if: env.HEADLESSMODE_PAT != ''` guard | +15 / -10 |
| `vitest.config.js` | Add comment documenting the 10s `testTimeout` rationale; add `per-test override` example | +4 |

**Test plan:** Confirm `npm test -- --coverage` reports ≥40% locally. CI: push branch, verify all gates run.

---

## Wave 7 — Documentation + minor quality (one PR, ~40 lines)

**Branch:** `docs/jsdoc-and-quality-cleanups`
**Commit:** `docs(src): add JSDoc to public entry points; simplify static constants`
**Closes findings:** Gaps #5 (`parseArgs` JSDoc), Gaps #6 (`run` JSDoc), Quality #1 (`MCP_CONFIG_FILENAME` concat), Quality #2 (for-loop style consistency), Quality #3 (createRequire workaround note)

| File | Change | Est. lines |
|---|---|---|
| `src/index.js:13 parseArgs` | Add JSDoc: `@param {string[]} args @returns {Options}` | +5 |
| `src/index.js:100 run` | Add JSDoc documenting profile hint application, output dispatch, exit codes | +8 |
| `src/utils.js:134` | `'.mcp' + '.' + 'json'` → `'.mcp.json'` | +1 / -1 |
| `src/checks/mcp-config.js:74 extractPathsFromArgs` | Convert `for(let i=0; i<flagPatterns.length; i++)` to `for...of` for style consistency | +3 / -5 |
| `src/reporter.js:5` | Inline comment documenting why `createRequire` is used (Node ESM JSON-import flag history); no code change | +2 |

**Test plan:** Full vitest (no behavior change). Visual review of generated JSDoc.

---

## Wave 8 — Enable skipped tests (one PR, ~80 lines)

**Branch:** `test/verify-docs-cwd-support`
**Commit:** `test(docs): add --cwd/--root to verify-docs.js and unskip 2 documentation-check tests`
**Closes findings:** Gaps #2 (skipped test 316), Gaps #3 (skipped test 320)

| File | Change | Est. lines |
|---|---|---|
| `src/lib/verify-docs.js` or `scripts/verify-docs.js` | Add `--cwd` and `--root` flag parsing; default to `process.cwd()`; resolve all relative paths against `--cwd` | +25 / -5 |
| `test/documentation-check.test.js:316,320` | Remove `.skip`; update fixtures to invoke with `--cwd` | +5 / -2 |
| `test/documentation-check.test.js` | Add 1-2 new tests exercising `--cwd` parameter validation | +20 |

**Test plan:** Both previously-skipped tests pass. Run `node scripts/verify-docs.js --cwd /tmp/some-fixture` manually.

---

## Wave 9 — utils.js walk consolidation (one PR, ~80 lines)

**Branch:** `refactor/utils-walk-merge`
**Commit:** `refactor(utils): merge walkUnder into walk via skipRootInode parameter`
**Closes findings:** Complexity #5 (`utils.js:321 walkUnder` near-duplicate)
**Why before Wave 10:** Smaller, lower-risk refactor — establishes the "no-behavior-change refactor under test" workflow before tackling the god-functions.

| File | Change | Est. lines |
|---|---|---|
| `src/utils.js:246-365` | Merge `walkUnder` into `walk(current, depth, opts = { skipRootInode: false })`. Update both call sites. | +20 / -44 |
| `test/scanner.test.js` or new `test/walk.test.js` | Snapshot test: walk a fixture tree, assert identical output before/after merge. Include symlink loop, hidden dir, maxFiles cap. | +40 |

**Test plan:** Full vitest. Before+after diff of `node bin/rigscore.js` finding output on a real repo — must be identical.

---

## Wave 10 — `src/index.js` `run()` decomposition (one PR, ~150 lines)

**Branch:** `refactor/index-run-decompose`
**Commit:** `refactor(index): extract init-hook + baseline branches from run()`
**Closes findings:** Complexity #4 (`run()` 266 lines)

| File | Change | Est. lines |
|---|---|---|
| `src/cli/init-hook.js` (new) | Extract init-hook installation logic (lines 133-190 of src/index.js, ~57 lines). Export `initHook(cwd, args)`. | +60 |
| `src/index.js` | `run()` early-returns `if (options.initHook) return initHook(cwd, args)`. Move baseline-mode invocation through `src/cli/baseline.js` if not already. Trim `run()` to <100 lines. | +10 / -60 |
| `test/init-hook.test.js` (existing) | Update imports; assert behavior unchanged. | +10 / -5 |

**Test plan:** Full vitest. Manual: `rigscore --init-hook` from a fresh git repo; confirm `.git/hooks/pre-commit` is installed.

---

## Wave 11 — `parseArgs` table-driven (one PR, ~100 lines)

**Branch:** `refactor/parse-args-table-driven`
**Commit:** `refactor(cli): replace 21-branch arg parser with table-driven dispatch`
**Closes findings:** Complexity #7 (`parseArgs` 85-line if/else)

| File | Change | Est. lines |
|---|---|---|
| `src/index.js:39 parseArgs` | Define `FLAG_DEFS = { '--check': { key: 'checkFilter', type: 'string' }, '--ci': { implies: ['quiet','json','noColor'] }, ... }`. Loop through args, look up flag, dispatch by type. | +50 / -58 |
| `test/cli-flags.test.js` | Add coverage for `--no-*` form, alias chain (`--ci` implies), unknown flag → error. | +30 |

**Test plan:** Full vitest. Run `rigscore` with each flag combination from existing tests; output must match.

---

## Wave 12 — `skill-files.js` god-function decomposition (likely 2 PRs, ~250 lines each)

**Branches:**
- `refactor/skill-files-helpers-phase1` — extract `accumulatePatternMatches`
- `refactor/skill-files-helpers-phase2` — extract per-pattern-family helpers

**Closes findings:** Complexity #2 (critical, `run()` 472 lines), Complexity #6 (warning, accumulation duplication)

### Phase 1: extract `accumulatePatternMatches`

| File | Change | Est. lines |
|---|---|---|
| `src/checks/skill-files.js` | New helper `accumulatePatternMatches(content, patterns, isDefensiveContext) → { lines, patternSources }`. Replace 3 copy-paste loops (escalation 461-495, persistence 498-530, indirect-injection 533-563) with helper calls. | +30 / -90 |
| `test/skill-files.test.js` | Add direct unit tests for `accumulatePatternMatches`. | +40 |

### Phase 2: extract pattern-family helpers

| File | Change | Est. lines |
|---|---|---|
| `src/checks/skill-files.js` | Extract: `checkInjection(file, content)`, `checkShellExec(file, content, allowlist)`, `checkExfiltration(file, content)`, `checkUnicode(file, content)`, `checkPosixPermissions(file)`. `run()` becomes a file-loop calling each. | +120 / -200 |
| `test/skill-files.test.js` | Direct tests for each extracted helper (smoke + edge case). | +80 |

**Test plan per phase:** Full vitest must remain green. Run rigscore on `test/fixtures/scored-project` before+after; finding counts and IDs must be identical.

---

## Wave 13 — `mcp-config.js` god-function decomposition (likely 3-4 PRs, ~300 lines each)

**Branches:**
- `refactor/mcp-config-extract-transport-and-env`
- `refactor/mcp-config-extract-typosquat-and-registry`
- `refactor/mcp-config-extract-hooks-and-cve`
- `refactor/mcp-config-extract-hash-drift`

**Closes findings:** Complexity #1 (critical, `run()` 578 lines), Complexity #3 (warning, 6-level nesting)

Each PR extracts 3-5 of the 15 sub-concerns into helpers; `run()` shrinks by ~100 lines per PR. Final `run()` should be ~60 lines: load configs, iterate servers, call helpers, collect findings.

Sub-concerns (per strategy agent): config-path scanning, transport-type detection, filesystem-path extraction, permission-flag checks, env passthrough, inline-credential detection, version-pin checks, offline typosquat, online typosquat, npm registry, settings/hook scanning, CVE-2025-59536 compound detection, cross-client drift, hash-pinning, runtime pin status.

**Test plan per PR:** Full vitest. Snapshot test: run all `test/mcp-*.test.js` and assert finding outputs are identical before+after.

---

## Deferred / not in scope

Findings deliberately skipped:

- **Gaps #4** (test fixture TODO `.cursorrules:41`, "lock down approval-gate script") — fixture is intentionally a "bad project" for testing; the TODO is part of its design as a test artifact.
- **Gaps #7** (THREAT-MODEL.md Stream-E backlog) — these are already-tracked future-work items, not gaps in shipped functionality.
- **Complexity #8** (`instruction-effectiveness.js` 751 lines) — file is long but well-decomposed internally. Strategy agent explicitly marks "no immediate action required."
- **Watch-mode UX (Production #3)** — included in Wave 3 but flag for review; the behavior change may surprise existing users.

## Acceptance

Plan complete when:
1. All 12 waves merged to main.
2. Re-run `python3 ~/.claude/skill-utils/health-check.py --categories all --cwd /home/dev/workspaces/_active/pkg-rigscore`.
3. New report shows: Flaws ≥8.5, Completeness ≥9, Complexity ≥8, Security ≥9, Production ≥9. Overall ≥9.0.

Estimated total: **~12 PRs** (some waves split), **~1500-2000 sum lines** changed (mostly net-reductions from refactors). Sequential dependency only between Waves 4→13 (security narrow before mcp-config decomposition) and Wave 1→all (broken explain dispatch blocks all integration testing).
