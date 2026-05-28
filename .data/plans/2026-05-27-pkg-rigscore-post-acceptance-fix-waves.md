# pkg-rigscore Post-Acceptance Health Fix Plan

**Generated:** 2026-05-27
**Source report:** `.data/health-reports/pkg-rigscore/2026-05-27-health.md`
**Strategy verdict:** INCREMENTAL (high confidence) · Overall 7.5/10
**Predecessor:** `.data/plans/2026-05-27-pkg-rigscore-fix-waves.md` (executed as PRs #118-#136)

## Why this plan exists

The first fix-waves plan closed every finding it targeted (15 PRs, ~290 lines moved out of god functions, 17 helpers extracted with direct unit tests). But the post-acceptance health check reported Overall **7.5** (target was ≥9.0) and surfaced **6 new findings the original audit missed** — most importantly a critical bug in `coherence.js` that has been silently zeroing a 14-point weight on every prior scan, including every score baseline used during plan execution.

The codebase is structurally sound. The strategy agent kept the INCREMENTAL verdict at high confidence. No module needs to be discarded. The findings fall into independent sequenceable clusters; each cluster maps cleanly to one PR (or, where the diff cap requires, a stacked pair).

## Sequencing rules

- Wave 1 ships **alone** and **first**. It is a single-line bug fix that materially changes every project's score; no other wave should land on top of an unknown scoring baseline.
- After Wave 1 merges, re-run rigscore against itself (`node bin/rigscore.js .`) and against a couple of other tracked projects to see what the real score baseline now is. Some projects may surface new findings that were previously masked by the inflated coherence score.
- Subsequent waves follow the same rules as the predecessor plan: each is one PR, branched from `main`, sized ≤300-sum diff, conventional-commit subject, no Claude/Anthropic attribution. Refactors that need to exceed 300 sum split into stacked-after-merge PRs (never branch-stacked).
- Mechanical test floor: every PR must keep `npx vitest run` green; PRs that change scoring math must include a new test case asserting the new behavior.

---

## Wave 1 — CRITICAL: coherence check has been silently disabled (one PR, ~5 lines)

**Branch:** `fix/coherence-pass-2-routing`
**Commit:** `fix(checks/coherence): declare pass: 2 so scan() actually runs it`
**Closes findings:** Flaws #1 (critical)

The `coherence` check export is missing `pass: 2`. `scanner.js:282` filters `pass1Checks = checks.filter(c => !c.pass || c.pass === 1)`, so coherence lands in pass 1, where `priorResults` is never populated, so `run()` immediately returns `{ score: NOT_APPLICABLE_SCORE, findings: [] }`. The 14-point coherence weight has been silently zeroed on every real scan since `pass: 2` routing was introduced. Unit tests mask the bug by calling `check.run({ priorResults: [...] })` directly, bypassing the scanner's pass routing entirely.

| File | Change | Est. lines |
|---|---|---|
| `src/checks/coherence.js` | Add `pass: 2,` to the default export alongside `id`, `name`, `category`, `enforcementGrade`. Pattern matches `src/checks/skill-coherence.js:230` and `src/checks/network-exposure.js:374`. | +1 |
| `test/coherence.test.js` (or new `test/coherence-pass-routing.test.js`) | Add an integration test that drives the check via `scan()` (not `check.run()` directly) against a fixture with at least one coherence-detectable contradiction; assert the finding appears. This is the test that should have caught the bug originally. | +25 |

**Test plan:**
- `npx vitest run test/coherence*.test.js`
- Manual: `node bin/rigscore.js .` (pkg-rigscore against itself) — record the new overall score so the post-Wave-1 baseline is known.
- Manual: run against 2-3 other tracked projects (any `_active/svc-*` will do); note any new findings that surface.

**Watch:** Any project with cross-config contradictions has been silently awarded an extra 14 points on every prior scan. Re-establishing the baseline may surface new findings in downstream consumers. Do not land any other wave until this lands and the new baseline is observed.

---

## Wave 2 — Complete the mcp-config refactor + fix bugs the inline state was hiding (likely 2 PRs)

**Branches:**
- `refactor/mcp-config-extract-remaining-server-checks` (Phase A)
- `fix/mcp-config-extracted-helper-bugs` (Phase B)

**Closes findings:** Complexity #1 (warning), Flaws #2 (warning), Flaws #3 (warning), Flaws #5 (info), Quality #1 (warning)

Session-1's Wave 13 stopped at ~70% of the mcp-config decomposition. The strategy agent flagged the remaining inline blocks plus three bugs that earlier extractions inherited from the original inline code (and that became more legible — and more obviously wrong — once they were named functions instead of buried in `run()`).

### Phase A: extract the remaining 6 per-server inline blocks (~250 lines)

Run() in `src/checks/mcp-config.js` still has 6 inline check blocks inside the per-server loop that follow the exact pattern already used for `checkTransportType` / `checkSensitiveEnv` / `checkAnthropicBaseUrl` etc. Extract them:

| Helper | Inline source (current main) | Notes |
|---|---|---|
| `checkBroadFilesystemAccess(server, name, relPath)` → `{ findings, hasBroadFilesystemAccess }` | Sensitive-paths-in-args block | Returns the boolean so the outer loop rolls it into `data`. |
| `checkPathTraversal(server, name, relPath)` → `findings` | `args.some(a => a.includes('../'))` | One-liner detection, ~10-line finding. |
| `checkUnsafePermissionFlag(server, name, relPath)` → `findings` | UNSAFE_PERMISSION_FLAGS loop with first-match break | Pure mapping. |
| `checkUnpinnedVersion(server, name, relPath)` → `findings` | UNSTABLE_TAGS loop on `@tag` | Pure mapping. |
| `checkNpxPin(server, name, relPath)` → `findings` | Uses `findPackagePositionArg` + `argHasStableVersionPin` | Pure mapping. |
| `checkInlineCredentials(server, name, relPath)` → `findings` | KEY_PATTERNS scan over `[command, ...args].join(' ')` | Pure mapping. |

| Tests | New direct-unit coverage per helper |
|---|---|
| `test/mcp-config.test.js` | 1 happy + 1 negative test per helper (~12 tests) following the pattern from Wave 13 a/b/c/d test blocks. |

After this Phase A lands, `run()` should drop from 297 to ~150 lines and the per-server loop body becomes a flat sequence of `findings.push(...checkX(server, name, relPath))` calls.

**Diff budget:** likely ~250-300 sum. If it crosses cap, split into "structural extractions" + "tests" PRs.

### Phase B: fix the bugs the named helpers exposed (~80 lines)

Three bugs are inherited from the original inline code; the Wave 13 extractions preserved them verbatim. They became obvious once named and unit-testable:

| File | Change | Est. lines |
|---|---|---|
| `src/checks/mcp-config.js` `extractPackageName` (line ~293) | Regex `[a-z0-9-]+` excludes `_` and `.` (both valid npm chars: `lodash.set`, `babel_register`). Widen to `[a-z0-9_.\-]+`. Add unit test asserting `extractPackageName(['lodash.set'])` returns `'lodash.set'`. | +1 / -1 + 15 test |
| `src/checks/mcp-config.js` `checkAnthropicBaseUrl` | `envBaseUrl.includes('api.anthropic.com')` is bypassable by `https://evil.com/proxy/api.anthropic.com` or `https://api.anthropic.com.evil.com/`. Parse with `new URL(envBaseUrl)` (use `extractHost` already in file) and compare `.hostname` against an allowlist set. Same for `localhost` / `127.0.0.1`. Add unit tests for both bypass shapes. | +10 / -3 + 25 test |
| `src/checks/mcp-config.js` `checkHashPinning` | `writeState === false` currently bails the whole function, suppressing drift findings too. Separate: always run the hash comparison and produce findings; only gate the `saveState` side-effect on `writeState !== false`. Add a unit test that passes `writeState: false` and asserts drift findings are still produced when hashes differ. | +5 / -3 + 20 test |
| `src/checks/mcp-config.js` (Quality #1) | Consolidate the 3 places that parse `@scope/pkg@version` (`argHasStableVersionPin`, `extractPackageName`, the inline unpinned-version check) into one `parseNpmPackageSpec(arg) → { scope, name, version }` helper. | +20 / -25 |

**Watch:** Phase A and Phase B both touch `src/checks/mcp-config.js`. Phase A must land before Phase B (Phase B's bug fixes target the extracted helpers' bodies — not the inline code). If Phase A is split into stacked PRs, only the final one is a prereq for Phase B.

---

## Wave 3 — Recursive-mode flag parity (one PR, ~60 lines)

**Branch:** `fix/index-recursive-flag-parity`
**Commit:** `fix(index): wire --ignore/--fix/--baseline/--badge/--verbose into recursive mode`
**Closes findings:** Completeness #1 #2 #3 #4 (warnings), Completeness #5 (info), Flaws #6 (info — diff subcommand return guard)

Four CLI flags silently no-op when combined with `-r`/`--recursive` because their handler blocks live in the non-recursive `else` branch only. Plus `--verbose` is dropped from the recursive formatter call.

| Flag | Current behavior | Fix |
|---|---|---|
| `--ignore` | Silently ignored in recursive scans | After `scanRecursive()` returns, iterate `result.projects` and call `suppressFindings(project.results, options.ignore)` before formatting. |
| `--fix` | Silently applies zero fixes | Either iterate projects and apply fixes per-project, OR emit `rigscore: --fix is not supported in --recursive mode\n` to stderr and exit 2. Recommend the stderr warning — per-project fix output is noisy and the user almost certainly wants to scope fix runs anyway. |
| `--baseline` | Silently ignored | Detect `recursive && baseline` early in `run()` and exit 2 with `rigscore: --baseline is not supported in --recursive mode\n`. Per-project baseline files would require a new file-path convention; defer to a follow-up if requested. |
| `--badge` | Falls through to terminal output | Add an `else if (options.badge)` branch in the recursive path, or stderr-warn and exit 2 (badge of an aggregate doesn't have a clean semantic anyway — recommend stderr-warn). |
| `--verbose` | Dropped from `formatTerminalRecursive` call | One-line: `{ noCta: options.noCta, verbose: options.verbose }`. |

Also folded in here (same file, trivial): add `return;` after `mod.runDiffSubcommand(args.slice(1));` in `bin/rigscore.js:36` so a future code path that returns without exiting can't silently fall through into `run(args)`. +1 line.

**Tests:** `test/recursive.test.js` extension (or new `test/recursive-flag-parity.test.js`) covering each flag-combination: --ignore actually suppresses, --fix prints the stderr warning + exits 2, --baseline prints the stderr warning + exits 2, --badge prints the stderr warning + exits 2, --verbose forwards to formatter.

---

## Wave 4 — CLI file-I/O error handling (one PR, ~70 lines)

**Branch:** `fix/cli-fs-error-handling`
**Commit:** `fix(cli): wrap fs writes in baseline/init/init-hook with user-facing error messages`
**Closes findings:** Gaps #1 #2 #3 #4 (warnings), Gaps #5 (info)

Three CLI command modules call `fs.writeFileSync` / `mkdirSync` / `appendFileSync` / `chmodSync` without try-catch. Permission errors or disk-full will surface as Node stack traces — the same UX gap session-1 Wave 3 fixed for the main scan path.

| File | Lines to wrap | Pattern |
|---|---|---|
| `src/cli/baseline.js` `writeBaseline` (lines 60-61) | `mkdirSync` + `writeFileSync` | `try/catch` → `process.stderr.write('rigscore: could not write baseline: <msg>\n'); process.exit(2);` |
| `src/cli/init.js` `runInitSubcommand` (line 51) | `writeFileSync` | Same pattern. |
| `src/cli/init.js` `scaffoldExample` (line 211) | `writeFileSync` | Same pattern. |
| `src/cli/init.js` `writeFileSafe` (lines 188-189) | `mkdirSync` + `writeFileSync` | Move the try/catch into `writeFileSafe` so its name actually matches its contract. Caller's `scaffoldExample` try-catch can be removed. (Gaps #5 — info — folded in here since the same lines are touched.) |
| `src/cli/init-hook.js` `runInitHook` (lines 64, 70, 72, 75) | `mkdirSync` + `appendFileSync`/`writeFileSync` + `chmodSync` | Same pattern. The hook is installed for the user's benefit; failures should be friendly, not stack-traced. |

**Tests:** New `test/cli-fs-errors.test.js` with spawn-based tests pointing each command at an unwriteable target (e.g. chmod 555 a parent dir) and asserting clean stderr + exit 2. Mirror the pattern from session-1 Wave 3's `test/error-handling.test.js`.

---

## Wave 5 — HTTP online-mode safety (one PR, ~60 lines)

**Branch:** `fix/http-online-mode-safety`
**Commit:** `fix(http,site-security): cap response buffer + scheme-validate site URLs`
**Closes findings:** Security #1 (warning, http.js fetchBody buffer), Security #2 (warning, site-security URL scheme bypass), Production #4 (info, fetchBody size cap — same line, folded here), Security #7 (info, mcp-registry fetch body cap)

All findings are gated behind `--online`, so blast radius is low — but they're conceptually related and the fix surface is one file (`src/http.js`) plus a tiny guard in `site-security.js` and `mcp-registry.js`.

| File | Change | Est. lines |
|---|---|---|
| `src/http.js` `fetchBody` | Add `MAX_RESPONSE_BYTES = 10 * 1024 * 1024` (mirror session-1 Wave-4's `MAX_REGISTRY_BYTES` pattern in `mcp-config.js`); track `bytesRead` per chunk; on overflow: `req.destroy(); resolve(null)`. Same pattern for `fetchHeaders` / `probeStatus` if they ever read bodies (currently don't — `res.resume()` drains). | +15 |
| `src/checks/site-security.js` `run` (line ~322) | Before calling `fetchHeaders/Body/probeStatus`, do `try { new URL(url) } catch { skip + emit info finding "invalid URL in sites: config" }`. Then assert `parsed.protocol === 'http:' || 'https:'` — reject `file:`, `ftp:`, `javascript:`. Optional: add an RFC-1918 / localhost denylist guarded by a config opt-in (defer if it grows the PR). | +15 |
| `src/mcp-registry.js` `defaultFetch` (line 148) | Add a Content-Length check before reading the response body, or stream-cap consistent with `MAX_RESPONSE_BYTES`. | +8 |
| `test/http.test.js` (new) or extend `test/network-timeout.test.js` | Mock `httpGet` emitting >10MB; assert `fetchBody` returns null and the request is destroyed. Mirror session-1 Wave-4's pattern in `test/mcp-config.test.js`. | +25 |
| `test/site-security.test.js` | Add fixtures for `file://` and malformed URLs; assert they're rejected with an INFO finding rather than dispatched to `fetch*`. | +15 |

---

## Wave 6 — GitHub Actions SHA pinning (one PR, ~80 lines)

**Branch:** `chore/ci-pin-actions-to-sha`
**Commit:** `chore(ci): pin all GitHub Actions to immutable commit SHAs`
**Closes findings:** Production #1 (warning)

All four workflow files (`ci.yml`, `release.yml`, `docker-publish.yml`, `release-provenance.yml`) reference actions by mutable tag (`actions/checkout@v4`). For a tool whose tagline is "MCP supply-chain drift detection", this is a self-inconsistency.

| File | Action references to pin |
|---|---|
| `.github/workflows/ci.yml` | actions/checkout, actions/setup-node |
| `.github/workflows/release.yml` | actions/checkout, actions/setup-node |
| `.github/workflows/docker-publish.yml` | actions/checkout, docker/setup-buildx-action, docker/login-action, docker/build-push-action |
| `.github/workflows/release-provenance.yml` | (audit during PR) |

Pin every action to its full commit SHA with a trailing `# vX.Y.Z` comment for legibility. Pattern:
```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

Add a Dependabot config (`.github/dependabot.yml`) for `package-ecosystem: github-actions` so the SHAs stay current automatically. Without this, the pinning becomes stale and CI bit-rots.

**Test plan:** Push the branch; verify CI / docker-publish / release dry-runs still execute on the pinned SHAs. No code-level test surface.

---

## Wave 7 — scanner.js god-file split (likely 2 PRs)

**Branches:**
- `refactor/scanner-extract-findings-module` (Phase A)
- `refactor/scanner-extract-runner-module` (Phase B)

**Closes findings:** Complexity #3 (warning)

`src/scanner.js` is 458 lines mixing 6+ concerns: dedup, ID assignment, suppression, check orchestration, single-project scan, project discovery, recursive scan. Split into three files following the strategy agent's recommendation:

### Phase A: extract `src/findings.js`

Move `deduplicateFindings`, `assignFindingIds`, `slugify`, `suppressFindings` (with its `compileSuppressPattern` + `globToRegExp` helpers) into `src/findings.js`. Re-export from `scanner.js` to preserve the existing import contract. Tests stay where they are; no API change.

### Phase B: extract `src/runner.js`

Move `runChecks` into `src/runner.js`. Same re-export shim from `scanner.js`. After both phases, `scanner.js` is ~150 lines covering only `scan`, `discoverProjects`, `scanRecursive` plus its config-merge boilerplate.

**Watch:** Both phases are pure code motion behind a re-export. The 86 test files that import from `scanner.js` should not need to change. If any do, treat that as a signal that the import surface wasn't actually re-exported correctly.

---

## Wave 8 — skill-files escalation accumulator extraction (one PR, ~80 lines)

**Branch:** `refactor/skill-files-extract-escalation`
**Commit:** `refactor(skill-files): extract checkEscalation matching the other check* helpers`
**Closes findings:** Complexity #2 (warning)

Session-1 Wave 12 extracted 5 of the 6 per-pattern-family checks in `skill-files.js` but left the escalation accumulator inline (it uses `forEachPatternMatch` already, but the Map-based accumulation and per-patternId allowlist check live in `run()`). Strategy agent specifically called this out as a pattern-consistency win.

| File | Change | Est. lines |
|---|---|---|
| `src/checks/skill-files.js` | Extract `checkEscalation(file, allowlist)` → `findings`. Move the `escalationAcc = new Map()` + `forEachPatternMatch` + `findAllowlistMatch` + per-patternId severity-escalation logic into the helper. `run()` loop becomes one more `findings.push(...checkEscalation(file, allowlist))`. | ~+45 / -30 |
| `test/skill-files.test.js` | Direct unit tests: 1 pattern → WARNING, 3 distinct patterns → CRITICAL (each-with-its-own-finding), allowlist suppression. | +35 |

---

## Wave 9 — Remaining Complexity + Production polish (one PR, ~100 lines)

**Branch:** `refactor/post-acceptance-misc-cleanups`
**Commit:** `refactor(misc): flatten checkNpmRegistry, split discoverFiles + detectDeadReferences, fix output discipline`
**Closes findings:** Complexity #4 #5 #6 #7 (warning/info), Production #3 (info)

Smaller cleanups, each one too small for its own PR:

| File | Change |
|---|---|
| `src/checks/mcp-config.js` `checkNpmRegistry` (Complexity #4) | Refactor the 5-level-deep Promise+stream+try/catch into a promisified `streamCappedBody(req, max)` helper, then flatten the response handler. Preserve the `httpGet`/`maxBytes` injection points used by tests. |
| `src/checks/instruction-effectiveness.js` `detectDeadReferences` (Complexity #5) | Pre-compile `btRe`/`mlRe` as module-level constants with the `g` flag. Extract candidate resolution into `resolveRef(ref, cwd, filePath)` to flatten the inner loop. |
| `src/checks/instruction-effectiveness.js` `discoverFiles` (Complexity #7) | Split into `collectGovernanceFiles`, `collectSkillFiles`, `collectMemoryFiles` helpers; `discoverFiles` becomes the orchestrator. |
| `src/checks/skill-files.js` `checkInjection` (Complexity #6) | Extract `buildInjectionFinding(file, line, isDefensive)` helper called from both the single-line and 2-line-window passes. |
| `src/fixer.js:50` (Production #3) | Replace the lone `console.warn(...)` with `process.stderr.write('...\n')` for output-discipline consistency. One line. |

**Tests:** Existing `instruction-effectiveness.test.js`, `skill-files.test.js`, `mcp-config.test.js` should stay green; no new tests required unless a behavior change is inadvertently introduced (which it shouldn't — all pure extraction).

---

## Wave 10 — Test-fixture & repo-hygiene cleanups (one PR, ~40 lines)

**Branch:** `chore/test-fixtures-and-repo-hygiene`
**Commit:** `chore(test,repo): neutralize fixture prompt-injection, replace AWS example key, add .env gitignore`
**Closes findings:** Security #3 (warning, fixture prompt-injection), Security #4 (info, .gitignore missing .env), Security #5 (info, fixture AWS/OpenAI keys flagged by gitleaks), Security #6 (info, prototype pollution in mcp-pin)

| File | Change |
|---|---|
| `test/fixtures/scored-project/.env` (Security #3) | Wrap the prompt-injection payload in structural delimiters (`<<<INJECTED_PAYLOAD_FOR_TEST_DO_NOT_INTERPRET ... >>>`) per CLAUDE.md data-framing rules. Add `test/fixtures/scored-project/README.md` warning that fixture content is adversarial. Update any test reading the file to strip delimiters before passing content to the check. |
| `test/fixtures/scored-project/.env` (Security #5) | Replace `AKIAIOSFODNN7EXAMPLE` and `sk-proj-FIXTURE000…` with patterns that don't match GitHub's push-time secret scanning (e.g. `AKIAXXXXXXXXXXXXXXXX`). Add inline gitleaks allowlist annotations if the rigscore detector still needs the canonical-looking shape. |
| `.gitignore` (Security #4) | Add `.env` and `.env.*` (with a negative pattern for `.env.example`). |
| `src/cli/mcp-subcommands.js` `runMcpPin` (Security #6) | Validate `serverName` against `/^[\w@/.-]+$/` before use as an object key, or switch the `servers` map to `Object.create(null)`. Add a unit test passing `__proto__` and asserting it's rejected. |

---

## Wave 11 — Pre-existing test flake (one PR, ~30 lines)

**Branch:** `fix/fixer-test-state-isolation`
**Commit:** `fix(test/fixer): relax strict-shape assertion to accept findingIds-only fixers`

This isn't in the health report — it's a flake noted across session-1 PRs #125, #128, #133, #135. `test/fixer.test.js > each registered fix has required shape` passes when run alone but fails ~1-in-3 times in the full suite. Module-level `_registeredFixes` state in `src/checks/index.js` leaks between parallel test workers when `test/fixer-registration-findingids.test.js` registers findingIds-only fixers and the strict-shape test in `test/fixer.test.js` iterates them.

Two options:
- Update the strict-shape test to accept findingIds-only fixers (recognize that `match` is optional after PR #112 added findingIds support). Probably the right call — the test's contract is stale.
- Or move `_registeredFixes` from module-level to a worker-scoped store and pass it through explicitly. Bigger change.

Recommend the first option: 1-line test fix + comment explaining the contract change.

---

## Deferred / not in scope

- **Production #2** (vitest coverage floor at 40%) — intentional baseline; raise incrementally as new tests are added. Not actionable as one PR.
- **Production #4** (fetchBody size cap) — folded into Wave 5 alongside the related security findings.
- **Quality #1** (duplicated npm parsing) — folded into Wave 2 Phase B alongside the regex-gap fix in the same file.
- **Strategy agent's hint about re-baselining downstream consumers** after Wave 1 — that's a check-the-effects step in Wave 1's test plan, not its own wave.

## Acceptance

Plan complete when:
1. All waves above merged to main.
2. Re-run `python3 ~/.claude/skill-utils/health-check.py --categories all --cwd /home/dev/workspaces/_active/pkg-rigscore`.
3. **Expected scores** (the original plan's targets, now realistic to hit because the coherence weight is no longer silently zeroed and the mcp-config decomposition is actually finished):
   - Flaws ≥ 9.0 (was 6.0)
   - Completeness ≥ 9.0 (was 7.5)
   - Complexity ≥ 8.0 (was 6.0)
   - Security ≥ 9.0 (was 8.5)
   - Production ≥ 9.0 (was 8.5)
   - Overall ≥ 9.0 (was 7.5)

Estimated total: **~11-13 PRs** (some waves split), **~1100-1400 sum lines** changed (split roughly half code motion, half net additions). Sequential dependencies: Wave 1 must land before any other wave (re-baselines scoring); Wave 2 Phase A before Phase B (same file); Wave 7 Phase A before Phase B (same file); everything else is independent and can interleave.

## Honest reckoning vs. the predecessor plan

The first plan's "Acceptance" section claimed an Overall ≥9.0 target was achievable from the 7.7 baseline by closing the listed findings. The post-execution score landed at 7.5 — flat, not up. Two reasons:

1. **The original audit understated complexity.** `mcp-config.js` was treated as one Complexity finding (~580-line god function); the post-acceptance audit broke it into 6 still-inline blocks plus 3 bug-shaped findings that became obvious *only after* Wave 13's extractions made them named functions instead of buried inline. Net result: the predecessor's Wave 13 "fully resolved Complexity #1" claim was numerically wrong (target was ~60 lines, actual was 297). This plan finishes the job.
2. **The original audit missed the `coherence.js pass: 2` bug entirely.** Every score baseline used during the predecessor plan was inflated by up to 14 points. The post-acceptance audit caught it; it's Wave 1 here because nothing else is interpretable until the scoring is honest.

Both surprises were verifiable in code from the start — no new evidence surfaced between the two audits. The second audit just looked harder. Treat the predecessor plan as ~70% of the real work, this plan as the remaining ~30%, and expect post-Wave-1 to surface *more* findings as the now-active coherence check fires for the first time.

---

## How to pick this up in a new session

Recommended opening prompt:

> Pick up the pkg-rigscore post-acceptance fix waves. Plan: `.data/plans/2026-05-27-pkg-rigscore-post-acceptance-fix-waves.md`. Source health report: `.data/health-reports/pkg-rigscore/2026-05-27-health.md`. Predecessor plan (already-shipped context): `.data/plans/2026-05-27-pkg-rigscore-fix-waves.md`.
>
> Start with Wave 1 (`fix/coherence-pass-2-routing`) and ship in isolation. After it merges, run `node bin/rigscore.js .` and report the new baseline overall score before continuing to Wave 2.
>
> All my standard rules apply: branch off main, ≤300-sum diff (refactor tolerance allowed), conventional commits with no Claude/Anthropic attribution, I merge PRs manually — open with `gh pr create --base main` and emit `sudo gh-merge-approved <PR-url> --repo Back-Road-Creative/rigscore` as a paste-ready one-liner.
