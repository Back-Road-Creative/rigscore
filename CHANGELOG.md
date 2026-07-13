# Changelog

All notable changes to `rigscore` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Docs
- **Config merging (`~/.rigscorerc.json` + project `.rigscorerc.json`) is now on
  the record.** The behavior has shipped for some time (`src/config.js`
  `loadConfig` / `mergeConfig`) but was never written down anywhere a user would
  look — its only prose description lived in an untracked release-notes scratch
  file, which is now deleted. The semantics: precedence runs DEFAULTS →
  `~/.rigscorerc.json` → project `.rigscorerc.json`; **arrays concatenate and
  deduplicate** across the two files (so personal `suppress` / `safeHosts` /
  `crossRepoRefs` in your home config compose with a project's rules instead of
  being clobbered by them), while **scalars and objects from the
  higher-precedence file override** the lower one. A malformed
  `.rigscorerc.json` raises a `ConfigParseError` and exits 2 rather than silently
  falling back to defaults. (The previously-documented `profile`-key precedence,
  #88, is one instance of this general rule, not a separate one.)
- **The README's GitHub Action recipe is pinned to an exact released tag.** It
  showed `uses: Back-Road-Creative/rigscore@v2.0.0` as `@v1` — a tag that does
  not exist (the published tags are `v0.1.0 … v1.0.0`, `v2.0.0`, `v2.1.0-rc1`;
  no moving major tag is cut). Worse, `action.yml` deliberately rejects any ref
  that is not an exact `vX.Y.Z`, so even a moving `@v1` would have hard-errored
  at the guard — whose own message already says "Pin to a tag like @v1.0.0". A
  user copying the canonical recipe out of the README got an action that could
  not resolve. The docs now match the guard, and `test/action-yml.test.js`
  extracts the guard's regex from `action.yml` itself and asserts every action
  ref shown in `README.md` / `docs/**` satisfies it, so the two cannot drift
  apart again.
- **`--verbose` is described accurately in `--help` and the README.** Both said
  it surfaces info-level (and, in the README, skipped) findings. It does not:
  `src/reporter.js` gates only `pass` findings behind the flag, and `info` and
  `skipped` print on every default scan. The flag adds passing checks and
  nothing else.

### Changed
- **`docs/FINDING_IDS.md` coverage is now enforced per finding ID, not per
  check.** The stability contract claimed to cover every emitted finding, but
  `verify:docs` only checked that each check had *some* documented id, so 39
  literal ids — 3 critical, 15 warning (e.g. `env-exposure/gcp-service-account-key`,
  `claude-settings/http-hook-external-endpoint`, `skill-files/bidi-override`,
  `mcp-config/state-write-disabled`) — drifted off the page with CI green. Those
  ids are exactly what consumers pin for SARIF ruleIds, `--ignore <id>`, and
  baseline diffs. The gate now fails when any literal id a built-in check emits
  is absent from the page and names the missing id; all 39 are backfilled.
  Dynamic-fragment ids keep their `<category>`/`<reason>` shorthand treatment.

### Fixed
- **mcp-config: a corrupt `.rigscore-state.json` no longer silently destroys the
  runtime tool pins.** The realistic trigger is a merge conflict in the pin (two
  branches both re-pinned): the file stops parsing, and the next scan rewrote it
  from scratch — dropping the `servers` map (the `rigscore mcp-pin` runtime tool
  hashes) while the finding said *"No action needed."* The two halves of the file
  are not symmetric: config-shape pins are re-minted from `.mcp.json` for free,
  but runtime tool pins are **not regenerable by a scan** — rigscore refuses to
  execute an MCP server, so only a human with its `tools/list` output can recreate
  them. Losing them silently turned OFF CVE-2025-54136 rug-pull detection
  (`rigscore mcp-verify <name>` exits 3). A corrupt state file now recovers the
  pins from the copy committed at HEAD, and the finding is keyed on the outcome:
  INFO when they were recovered, WARNING (naming the re-pin command) when no
  committed copy could supply them. Same `mcp-config/state-file-corrupted` id in
  both arms — SARIF ruleIds are a stability contract.
- deep-secrets: do not stop at first comment-pattern match — escalate to critical when a real secret follows. Fixes a real critical being downgraded to info.
- `checks/index`: accept fixer registrations that declare `findingIds` without
  a `match` function. Aligns the registration contract with `fixer.js` dispatch,
  which already supports either matching path. Previously, fixers exporting
  only `{ id, findingIds, description, apply }` were silently dropped at load
  time and never reached the dispatcher.
- env-exposure: use `git check-ignore` instead of exact-string match — fixes
  false positives on monorepos with path-prefixed .env entries.
- **constants: anchor `KEY_PATTERNS` with `\b` boundaries and enforce
  realistic minimum lengths.** Several historical patterns were regex
  theatre — `/xoxb-[a-zA-Z0-9-]+/` matched `xoxb-a`, and `/AKIA[0-9A-Z]{16}/`
  fired on an `AKIA…` substring buried inside a JWT or base64 blob. Every
  pattern is now anchored with `\b` on both sides where the prefix/suffix
  are word-shaped, and Slack tokens (`xoxb-`, `xoxp-`, `xox[aers]-`) require
  at least 30 trailing chars in line with real Slack token formats. Reduces
  false positives on base64 blobs / JWTs / identifiers that happen to
  contain a prefix substring.
- **deep-secrets: stream-scan files over the per-file size cap instead of
  skipping them unread.** A file larger than `limits.maxFileBytes` (default
  512 KB) was skipped and never opened, yet the scan still emitted the PASS
  "Deep scan clean" finding — a live AWS key in a 600 KB bundle scored 98 and
  passed CI at `--fail-under 80`, while the same key in a 100 KB file scored 0
  and blocked. Large files are now read via fixed-size chunk streaming with an
  overlap window sized from the longest credential pattern, so a secret in a
  large or minified (single-line) bundle is detected with memory bounded by
  chunk + overlap (not the file size — the reason a readline-based fix was
  rejected). The `deep-secrets/oversize-skipped` id is retained for SARIF
  contract stability and now reports the stream-scanned count.
- **deep-secrets: `--deep` no longer scans the Action's own vendored checkout.**
  The GitHub Action checks rigscore's source out to `.rigscore-action-src/`, which
  `actions/checkout` forces to be a leading-dot SUBDIRECTORY of the caller's scan
  root (its `path:` is constrained to `$GITHUB_WORKSPACE` — a true sibling is
  impossible, despite the old `action.yml` comment's claim). Because the deep walk
  runs with `skipHidden: false`, it descended into that dir and scanned ~161 of
  rigscore's OWN files as if they were the caller's — surfacing phantom
  `deep-secrets` findings about `.rigscore-action-src/...` in the caller's SARIF
  (files the caller can't act on, minted during CI and invisible in their PR diff),
  and consuming the caller's `deepScan.maxFiles` budget. `.rigscore-action-src` is
  now in the hardcoded `SKIP_DIRS` set, so the walk never descends into it and the
  `action.yml` comment states the real path.
- **`walkDirSafe`: the depth cap now discloses truncation like the file cap
  does.** `truncated` fired only when `maxFiles` cut the walk; the `maxDepth` cut
  returned silently, so a depth-truncated walk was indistinguishable from a
  complete one — violating the walker's own stated invariant that "a scan that
  gave up must never be indistinguishable from a clean one." The realistic
  trigger is `claude-settings`, which walks plugin/skill hook sources at a low
  `maxDepth: 6`: a `.claude/settings.json` or hooks file nested deeper in a
  monorepo was silently skipped while the check read as complete, so its
  `hook-file-cap-reached` WARNING — the disclosure that keeps an unread (possibly
  dangerous) hook from passing as clean — was dead for the depth path. A new
  distinct `depthTruncated` flag now fires at the depth cut, and every caller that
  disclosed `truncated` (`claude-settings`, `loop-governance`, `deep-secrets`,
  `sandbox-posture`, `memory-hygiene`) discloses it too, with wording naming both
  causes. Finding
  ids are unchanged (SARIF ruleId stability); `truncated` keeps meaning "hit
  maxFiles" so the file-cap detail never misreports the cause.
- **claude-md: a governance file hidden by a *parent* `.gitignore` no longer
  slips through, and the untracked warning now works in nested packages.** Both
  arms of the check's git block re-implemented git off the filesystem at `cwd`,
  so both went blind in a monorepo sub-project — the exact shape `--recursive`
  and the `monorepo` profile exist to scan. (1) The `git check-ignore` query sat
  behind `if (gitignoreContent)`, a test for a `.gitignore` **file at cwd**; when
  the ignore rule lived in the repo-root `.gitignore` (or `.git/info/exclude`,
  which appears in no diff at all, or `core.excludesFile`) the check never asked
  git, and the `governance-file-gitignored` **CRITICAL vanished** — with
  `--fail-under 70` the CI gate flipped from FAIL to PASS purely because the
  sub-project had no `.gitignore` of its own. (2) `hasGit` was
  `fs.access(cwd/.git)`, so in a nested package — where `.git` sits at the repo
  root — the gate blocked a `git ls-files` call that resolves the repo fine from
  any subdirectory, and `governance-file-untracked` never fired. The check now
  asks git both questions (`git check-ignore` unconditionally, as sibling
  `env-exposure` already did, and `git rev-parse --is-inside-work-tree`), keeping
  the legacy exact-string match only as a fallback for when git cannot answer.
  No finding ids change.

- **Suppressing a finding can no longer promote a NOT-APPLICABLE check into
  scoring coverage.** Muting a check's cosmetic "nothing here" INFO (e.g.
  `mcp-config/no-config-found`) recalculated that check's score from an empty
  finding list, and `calculateCheckScore([])` is `100` — so the check flipped
  `-1` (N/A) to `100` and handed its full weight to the applicable-coverage set.
  A repo could mute one INFO and watch its score climb; muting the cosmetic INFO
  on all seven such checks moved a test repo from 16 to 68, turning a failing
  `--fail-under` gate green. N/A is a property of the project, not of the finding
  list, so an N/A check now stays N/A no matter what is removed from it.
  Suppressing findings on an *applicable* check still rescores exactly as before.

- **MCP rug-pull detection (CVE-2025-54136) now covers every committed repo-level MCP
  config, not just `.mcp.json`.** rigscore scans four `base: 'cwd'` configs — `.mcp.json`,
  `.vscode/mcp.json`, `.gemini/settings.json`, `opencode.json` — but pinned only the first.
  A repo whose servers lived in any of the other three got **no pin at all**, so
  `--verify-state` compared an empty set against an empty pin and printed `PASS: 0 pinned
  MCP server(s) verified` (exit 0) over a rug-pulled server, while `mcp-config` scored the
  repo clean. The scan and the gate now mint and verify through the same `repoMcpPaths()` /
  `readRepoServers()` helpers, so they cannot disagree about scope. Home-dir configs stay
  unpinned (per-user, not committed, unreachable from a PR). Pin format is unchanged
  (`STATE_VERSION` 1, name → hash); a name declared in two configs pins the first bare and
  each later one as `<name>@<relpath>`, so a rug-pull in the shadowed copy still fails.
  **Behavior change:** such a repo now reports `unpinned` (exit 2) until it commits a
  `.rigscore-state.json` — previously a vacuous pass.

- **VS Code MCP configs are read with VS Code's own key.** `.vscode/mcp.json` declares
  servers under `servers`, but rigscore looked only for `mcpServers` — so every real VS Code
  config scanned as empty (`mcp-config`, `network-exposure`, `credential-storage`,
  `workflow-maturity`, CycloneDX). Both keys are read now, `servers` winning.

- **baseline: a committed baseline REMOVED at HEAD no longer launders new
  findings through a silent re-mint.** The git-HEAD provenance gate promised that
  a deleted/corrupt *working-tree* baseline "cannot launder findings" — but a PR
  that `git rm`s the baseline AT HEAD (not just the working tree) slipped through:
  `readCommittedBaseline` returned `status:'absent'` for BOTH a genuine first run
  (never tracked) and a deletion attack (tracked, then `git rm`'d + committed),
  because `git show HEAD:<path>` fails identically in both cases. The gate then
  fell through to the working-tree loader, which — seeing no file — re-minted a
  fresh baseline that absorbed the PR's new findings and exited `0`. A live AWS
  key sailed through. The two cases are now split by git history (`git log -1 --
  <path>`): a path with history but absent at HEAD is `removed` and fails closed
  (exit `2`, the same provenance-error tier as corrupt), while a never-tracked
  path stays `absent` and still mints on first run (exit `0`). Exit `2` — not `1`
  — because it is a provenance/config error CI must not confuse with a real
  below-baseline regression. This closes the same asymmetry `--verify-state`
  already covers for MCP pins.

- **`suppress:` is honored (and rescored) in `--recursive` / `--profile monorepo` mode.**
  The recursive path applied only `--ignore`, never a project's own `.rigscorerc.json`
  `suppress:`, and never recomputed scores — so the escape hatch was inert exactly where
  monorepos run, and the report printed findings the exit code had already forgiven. Now
  applied and rescored per project; per-project `suppressedCount`/`suppressedIds` in SARIF.

- **`--check <id>` where the check is N/A for the repo now reports `n/a` and exits 0**, not a
  fabricated `0/100` Grade F with exit 1 (which red-failed every service in a
  one-check-per-service CI matrix that has no Dockerfile). JSON carries
  `notApplicable: true` / `score: null`; the badge renders grey `n/a`. A typo'd id stays red.

- **An invalid target directory exits 2 (configuration error), not 1** — matching README's
  exit-code table, so a typo'd path is no longer indistinguishable from a real low score.


### Added
- **Enforcement-grade labels per check.** Every check now carries an
  `enforcementGrade` of `mechanical`, `pattern`, or `keyword`, surfaced as a
  `[grade]` tag in the reporter score line and as
  `properties.enforcementGrade` on every SARIF result. A legend line renders
  below the score box in terminal mode (suppressed in `--json` and `--sarif`
  output). This is a transparency / display change — **no scoring changes**,
  no weight changes, no new dependencies. Users can now see *how* each point
  was earned (deterministic config check vs. regex/structural vs. presence
  detection) and calibrate trust accordingly. `keyword`-graded checks are
  the most gameable surface — see [`THREAT-MODEL.md`](THREAT-MODEL.md) §3.1
  and [`test/keyword-gaming.test.js`](test/keyword-gaming.test.js) for
  specifics. Classification rationale lives in
  `.data/plans/enforcement-grade-classification.md`.

## [2.0.0] - 2026-04-20

Public-release hardening pass. Four parallel tracks landed across PRs
[#95](https://github.com/Back-Road-Creative/rigscore/pull/95),
[#96](https://github.com/Back-Road-Creative/rigscore/pull/96),
[#97](https://github.com/Back-Road-Creative/rigscore/pull/97),
[#98](https://github.com/Back-Road-Creative/rigscore/pull/98),
plus a dogfood-fixture fix in [#94](https://github.com/Back-Road-Creative/rigscore/pull/94).
The scoring change in Track C is the reason this is a major bump.

### Security (Track A)
- **ANSI escape injection closed** in `src/reporter.js` and `src/sarif.js`.
  `stripAnsi` is now applied to every file-sourced `title` / `detail` /
  `evidence` / `remediation` / `learnMore` before Chalk wrapping, blocking
  terminal-hijack payloads (OSC 8, clear-screen, set-title) planted in
  scanned skill files. Track A — A1.
- **Atomic `saveState`** (`src/state.js`): writes go to `<path>.<pid>.<hex>.tmp`
  and are `rename()`'d in place. Prevents SIGINT / concurrent-scan corruption
  of `.rigscore-state.json` and the silent loss of MCP pin hashes that
  followed. Track A — A2.
- **Strict config parsing.** New `ConfigParseError` + `readJsonStrict` in
  `src/utils.js`; `loadConfig`, the `diff` subcommand, and `saveState` all
  propagate the structured error. The CLI catches it and exits `2` with
  `rigscore: <file> is not valid JSON (<err>). Fix and retry.` instead of a
  bare Node stack. Track A — A3.
- **Symlink-loop defense.** A shared `walkDirSafe` (`src/utils.js`) uses
  `lstat` + visited-inode set + `opts.maxDepth` (default 50, overridable via
  `config.limits.maxWalkDepth`). `deep-secrets`, `skill-files`, and the
  `k8s/` enumeration in `docker-security` all use it. An `info` finding
  surfaces once per scan when a cycle is skipped. Track A — A4.
- **Network timeout + per-file cap.** `fetch` calls in `src/http.js` and
  `src/mcp-registry.js` now wrap an `AbortController` with a 5s default
  (`config.limits.networkTimeoutMs`); the deep scanner skips files over 512 KB
  (`config.limits.maxFileBytes`) with an `info` finding. Track A — A5.
- **`windows-security`** replaces synchronous `execSync` with the promisified
  `execSafe` used elsewhere; same 5s timeout, no event-loop blocking. Track A — A6.

### Distribution (Track B)
- **Lockfile regenerated** against `package.json` 1.0.0. `npm ci` is once
  again reproducible; the previous `0.6.3` `lockfileVersion` header is gone.
  Track B — B1.
- **Runtime + dev dependencies pinned** to exact versions — the caret
  ranges on `chalk`, `yaml`, and `vitest` are gone, closing the self-own
  of a supply-chain scanner re-resolving deps on every install. Track B — B2.
- **`engines.node` floor raised to `>=18.17.0`** so `fs.promises.readdir({
  recursive: true })` is guaranteed. Track B — B3.
- **User-Agent derived from `package.json`** via `createRequire` at module
  load. No more hardcoded `rigscore/0.8.0` drift across releases. Track B — B4.
- **`--init-hook` pins `@v${pkg.version}`** when writing `.git/hooks/pre-commit`.
  The installed hook leads with a comment documenting the pin and the
  re-init workflow; older pinned versions found during re-install trigger
  a warning rather than a silent append. Track B — B5.
- **CI expanded:** `.github/workflows/ci.yml` matrices Node `18.17`, `20`, `22`
  across `ubuntu-latest` and `macos-latest`, with a lockfile-drift guard
  (`npm ci && git diff --exit-code package-lock.json`) to prevent future
  B1-class regressions. Track B — B6.
- **Dockerfile hardened.** A non-root `rigscore` user runs the scan,
  `ARG VERSION` + `org.opencontainers.image.*` labels replace the stale
  `v1.1.0` comment, and the image no longer reads the mounted `/workspace`
  as root. Track B — B7.
- **`action.yml`** stops swallowing scan crashes (`2>/dev/null || true`
  removed) and validates that callers pin the action to a semver tag
  rather than `@main`. Track B — B8.

### Docs (Track D)
- New **Platform notes** and **Exit codes** sections in `README.md` so
  WSL / macOS / Git Bash / Docker Desktop behaviour is documented honestly
  and CI authors can branch on exit codes without reading the source.
  Track D — D1, D2.
- New `docs/FINDING_IDS.md` enumerates every explicitly-emitted `findingId`
  today, documents the `<check>/<slug>` schema, and states the stability
  contract: explicit `findingId`s do not change within a major version; the
  remaining checks still use a title-slug fallback and are a follow-up.
  Track D — D3.
- New **Advisory escalation**, **First run**, and **Documentation** sections
  in `README.md`; new `docs/TROUBLESHOOTING.md`; new starter governance
  templates under `docs/examples/` for Cursor, Cline, Continue, Windsurf,
  and Aider. Track D — D4–D8.

### Test-hygiene
- `test/fixture-dogfood.test.js` now scrubs `.rigscore-state.json` from the
  fixture directory `beforeEach` / `afterEach`, and the fixture's
  `.gitignore` lists the state file, so a prior run's per-user mode-0600
  state file can no longer mask the `mcp-config` check and drift the
  locked finding count. PR #94.

### Changed
- **BREAKING (scoring recalibration):** coverage scaling is now continuous.
  The previous step at `totalApplicableWeight < 50` has been replaced with
  `scale = min(1, totalApplicableWeight / 100)`, applied always. This closes
  a gameable cliff where projects at applicable weight 48 scored visibly
  differently from projects at 50 despite representing the same real
  coverage. **Existing overall scores will shift downward** for any project
  whose applicable weight is ≥ 50 and < 100. `--fail-under` thresholds
  calibrated against the old formula may need adjustment; see
  `.rigscorerc.json` and any CI gates that depend on a specific cutoff.
  Track C — C6.
- `claude-md` returns `NOT_APPLICABLE` (not `CRITICAL`) when no AI tooling
  markers are present in `cwd`. A banner is printed at the top of the
  terminal report when every AI-tooling surface check is `NOT_APPLICABLE`,
  pointing the user to `--include-home-skills` or adding a governance file.
  Generic hygiene checks (secrets, docker, permissions, git-hooks) still
  score the project. Track C — C1.
- Narrowed `claude-md` anti-injection keyword: bare `injection` (which gave
  "dependency injection" undeserved anti-injection credit) is now rejected
  in favour of `prompt.?injection | instruction.?override | injection.?attack
  | ignore previous | disregard.?instructions`. Track C — C2.
- `skill-files` applies defensive-context suppression to the shell-exec
  loop (fixes false fires on `Do not use curl http://` etc.) and no longer
  stops at the first-match in the shell-exec / escalation / persistence /
  indirect-injection loops. Findings now carry a `matches: N` count and
  escalate to `CRITICAL` severity when ≥ 3 distinct patterns match the same
  file. Track C — C3 + C4.
- `deep-secrets` walker no longer blanket-skips dotfile directories:
  `config/.env.production` and similar are now scanned. `SKIP_DIRS` has been
  extended with common machine-generated dotfolders (`.cache`, `.idea`,
  `.turbo`, `.tox`, `.pytest_cache`, `.svelte-kit`, `.terraform`, etc.) so
  that lifting the blanket guard doesn't cause noise. Track C — C5.
- Consolidated `rigscore init` and `rigscore init --example` into a single
  module. `--profile`, `--force`, and `--example` all compose. No CLI
  surface change for users.

## [1.0.0] - 2026-04-20

First tagged `1.x` release. A packaging, quality, and distribution milestone —
stabilises the finding API, extends profiles, and draws a clean line in the
changelog.

### Added
- **Scoring profiles** — `home` and `monorepo` profiles alongside existing
  `default | minimal | ci`. `--profile` CLI flag and `.rigscorerc.json`
  top-level `"profile"` key. Precedence: CLI > project `.rigscorerc.json` >
  `~/.rigscorerc.json` > `default` (#88).
- **Baseline / diff mode** — `rigscore --baseline <path>` stores/reads prior
  findings JSON and reports only *new* findings vs. baseline. `rigscore diff
  <baseline> <current>` emits JSON for CI gating (#88).
- **Suppress semantics** — glob (`skill-files:drive-resume/*`) and regex
  (`re:/.*sudo.*/`) support alongside substring. Backwards compatible (#88).
- **`skillFiles.allowlist`** — per-skill + per-pattern allowlist so legitimate
  operator-skill `sudo` usage isn't flagged. Keyed by skill directory and
  pattern id, not title substring (#90).
- **`instructionEffectiveness.crossRepoRefs`** — config key for
  glob-allowlisting known-good cross-repo path references (#90).
- **Finding evidence field** — every finding includes a ≤120-char snippet of
  the offending content. Rendered by the reporter when present (#90).
- **Fixture dogfood** — `test/fixtures/scored-project/` with 42 intentional
  findings across 12+ checks plus an assertion suite that locks the expected
  score range (#89).
- **`rigscore init`** and **`rigscore explain <findingId>`** subcommands
  (#88). `rigscore init --example` scaffolds a demo project with intentional
  issues (#87).
- **Docker image** — `Dockerfile` + `docker-publish.yml` publish
  `ghcr.io/back-road-creative/rigscore:<tag>` on `v*.*.*` tag push (#87).
- **`CHANGELOG.md`** (this file) (#87).

### Changed
- **SARIF ruleIds** are now per-finding (`<checkId>/<findingId>`) instead of
  check-level. Improves finding dedup and cross-run tracking in GitHub
  Advanced Security (backlog 3.2, #90).
- **Fix matcher** switched from title-substring to `findingId`. Title match
  remains a deprecated fallback with a console warning so plugin fixes don't
  silently break (backlog 3.3, #90).
- **Coverage scaling** no longer counts weight-0 advisory checks toward the
  applicable-weight ratio (backlog 3.1, #88). Adding new advisories can no
  longer drag the score down.
- **`instruction-effectiveness`** false-positive reduction — file-line-range
  suffixes stripped before path existence check; cross-repo refs
  allowlist-aware; `/home/joe` dead-ref count dropped from 143 to 12 (#90).

### Distribution
- **npm publish remains off** by design. Distribution is GitHub-only via
  `npx github:Back-Road-Creative/rigscore`. See README "Distribution" for
  the rationale.
- **Cross-platform CI matrix** is deferred pending `--json` truncation
  investigation on macOS runners; ubuntu-only for v1.0.0.

## [0.9.0] - 2026-04-07

### Added
- MCP registry API typosquat augmentation (#78) — augments the local known-MCP
  registry with the upstream MCP registry when `--online` is set.
- Runtime tool description hashing via a print-and-paste workflow (#79). New
  subcommands `rigscore mcp-hash | mcp-pin | mcp-verify` hash-pin MCP server
  shape to detect rug-pulls (CVE-2025-54136).
- Scoring documentation — the coverage-scaling formula is now documented and
  covered by characterization tests (#77).

### Changed
- CTA output is now opt-in via `--cta` (#80). `--no-cta` is kept as a
  back-compat alias. Default output is quieter for CI and hooks.
- CI self-scan `--fail-under` tightened from 14 to 30 (#76).

## [0.8.0] - 2026-03-28

### Added
- `infrastructure-security` check (6 pts) — root-owned git hooks, shell guard,
  `chattr` immutability, deny-list, sandbox-gate registration (#64).
- `site-security` advisory check — absorbs HTTP header / PII / JS secret /
  SSL / fingerprinting probes behind `--online`.
- `instruction-effectiveness` and `skill-coherence` advisory checks (#67).
- Author-agnostic check defaults; author-specific heuristics are opt-in (#69).
- Extended homoglyph coverage (Mathematical, Fullwidth, Cherokee) (#73).
- MCP shape hash-pinning scaffolding (CVE-2025-54136) (#75).

### Changed
- Distributed via GitHub only: `npx github:Back-Road-Creative/rigscore`. npm
  publish is intentionally dropped (#62).
- `skill-files` check scoped to the project (cwd) by default (#74).
- `mcp-config` version-pin check scoped to the package-position argument (#72).

### Fixed
- Release workflow consolidated into a single `release.yml`; `NODE_AUTH_TOKEN`
  wiring corrected (#60, #61, #63).
- Broken GitHub Action entry points repaired; self-scan gate made meaningful
  (#68).
- Correctness bugs W3 — issues C3, C5, H2, H4 (#70).

## [0.7.2] - 2026-03-20

### Added
- `claude-md` hardening — multi-line injection detection, negation → CRITICAL,
  three new quality patterns.
- `claude-settings` hardening — bypass-combo detection, dangerous-allow-list
  analysis, hook coverage + script validation.
- Cross-config **coherence** pass — settings-vs-governance alignment for
  forbidden actions, approval gates, and MCP scope claims (#58).
- Reverse coherence — flags MCP capabilities present in config but not
  declared in governance (#53).
- Auto-release workflow — pushes to `main` that bump `package.json` version
  create a GitHub Release automatically (#57).

## [0.5.0] - 2026-02-14

### Added
- `network-exposure` advisory check — detects AI services bound to `0.0.0.0`
  rather than `127.0.0.1`. Scans MCP URLs, Docker port bindings, Ollama
  config, and live listeners (#13).
- Plugin result-shape validation — `rigscore-check-*` plugins must return a
  well-formed `{ id, name, findings, ... }` (#49).
- Badge cache-seconds, SARIF physical locations, shell-history secret scanning
  (#47, #48).
- `--ignore` flag + `suppress` config for finding filtering (#46).
- Fixer self-registration from check modules (#51).

### Changed
- npm publish switched to OIDC trusted publishing (#12).
- Weights rebalanced across 13 checks; OWASP Agentic Top 10 mapping added
  (#42).
- Scan errors now exit with code 2 and auto-assign finding IDs (#50).

## [0.4.1] - 2026-01-30

### Changed
- Repository URL moved to the `Back-Road-Creative` org (#10).
- Version bumped for npm publish (#11).

## [0.4.0] - 2026-01-28

### Added
- Publish workflow, `--watch` mode, `windows-security` advisory check, and a
  plugin system that auto-discovers `rigscore-check-*` npm packages.
- Defensive-word context expansion to reduce false negatives (#40).
- Unicode steganography expansion (Greek, Armenian, Georgian, zero-width,
  bidi) (#37).
- Docker detections: `ipc:host`, `pid:host`, `volumes_from`, `SYS_ADMIN`,
  path traversal (#39).
- Dangerous Claude-settings detection (hooks, `enableAllProjectMcpServers`,
  skip-permissions) (#38).
- `KEY_PATTERNS` for AWS temp creds, Vault, JFrog, Docker auth (#36).
- Config weight validation (#44).

## [0.3.0] - 2026-01-12

### Added
- Audit phases 1-4: docs, bug fixes, detection hardening, features.
- Moat-heavy scoring — MCP / coherence / skill / governance expanded;
  SARIF output added; CI-friendly exit semantics (#6).
- Three new check modules: `claude-settings`, `credential-storage`,
  `unicode-steganography` (#41).
- CVE-specific compound detection patterns (#45).
- Finding deduplication with `structuredClone` for prior results (#43).

## [0.2.0] - 2025-12-20

### Added
- Cross-config **coherence** check — cross-references governance claims
  against MCP / Docker / settings config to detect contradictions.
- `--deep` source secret scanning — walks the full source tree for hardcoded
  secrets beyond root config files.
- MCP supply-chain verification — upstream registry lookup behind `--online`.

## [0.1.1] - 2025-11-22

### Added
- Baseline tests for known limitations and boundary conditions.
- Expanded secret patterns, MCP traversal detection, hook substance checks.

### Fixed
- Audit v3 remediation — additive scoring, detection hardening, honest
  framing (#2, #3, #4).

## [0.1.0] - 2025-11-10

### Added
- Initial implementation. 13 scored checks, CLI entry point, scanner,
  additive scoring (CRITICAL=zero, WARN=-15, INFO=-2), human-readable
  reporter, and a README.

[Unreleased]: https://github.com/Back-Road-Creative/rigscore/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Back-Road-Creative/rigscore/compare/v0.5.0...v0.7.2
[0.5.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Back-Road-Creative/rigscore/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Back-Road-Creative/rigscore/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Back-Road-Creative/rigscore/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Back-Road-Creative/rigscore/releases/tag/v0.1.0
