# Changelog

All notable changes to `rigscore` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Do not add entries to this file in a pull request.** Add a fragment under
[`changelog.d/`](changelog.d/README.md) instead — one file per change, so two
PRs in flight never collide on the same lines. `npm run changelog` previews the
next release; the maintainer folds the fragments in at release time.

## [Unreleased]

## [2.3.0] - 2026-10-27

### Added
- `workflow-maturity` now flags graduated skills whose script is missing (`workflow-maturity/graduated-script-missing`, WARNING). A `SKILL.md` declaring `status: graduated-code` asserts it is a thin wrapper over a deterministic script; when that script isn't on disk the skill is non-functional (`exit 127` on every invocation) while its version bump advertises the opposite. Detection is deliberately conservative — only skills declaring `status: graduated-code` are considered (a v1.x LLM-driven skill legitimately has no script), `~` and `$HOME` expand against the scan homedir before the existence test, and placeholder/interpolated tokens (`<path>`, `${VAR}`, `$1`, `{{ }}`), comment lines, and relative paths are skipped rather than guessed at.
- The release workflow now sources GitHub release notes from the folded `## [<version>]` section of `CHANGELOG.md` (via `assemble-changelog --notes <version>`), falling back to the raw git log only when that section is absent.
- **staged-copy-drift**: new advisory check (weight 0) that hashes each tracked staged copy against its deployed twin under the operator's home config dir and flags content drift. Opt-in via `--include-home-skills`; rows come from `.rigscorerc.json` `stagedCopies`.
- **memory-hygiene**: warn-only dangling/orphan `[[wikilink]]` report (advisory).
- **The README contract is enforced in this repo, not from outside it**: a test asserts README.md states its Purpose, Owner, Status and Exit Condition, and that each has a body. The workspace that consumes rigscore as a submodule cannot check this — no workflow passes `submodules:` to actions/checkout, so that directory is empty in its CI — which is how an exemption for this repo sat expired for a month unnoticed.
- MCP runtime tool-hash pins now carry freshness: a pin older than `mcpConfig.runtimeToolPinMaxAgeDays` (default 90) or with no valid timestamp reports `mcp-config/runtime-tool-pin-stale` instead of `runtime-tool-pin-recorded`; recorded findings gain `ageDays`. Info severity, so exit codes are unchanged.
- A failing `--fail-under` gate now writes one `rigscore: FAIL ...` line to stderr (score or failing-project count, threshold, lowest project in `--recursive`), and an unknown flag that is a near miss of a real one warns with `did you mean --flag?` (the flag is still ignored). Exit codes and stdout are unchanged.
- `sandbox-posture` now covers Windsurf Cascade: it reads `windsurf.cascadeCommandsAllowList` / `windsurf.cascadeCommandsDenyList` from the per-user `settings.json` and reports `sandbox-posture/windsurf-shell-allowlisted` (warning) when a bare shell, interpreter or `*` is allow-listed and not denied. Windsurf posture is `unrestricted` in that case, otherwise `partial`; a `settings.json` without the list keys is not a surface.
- **GitHub Action: Markdown job summary.** The action now writes a readable report to the run page (score, grade, checks needing attention, top findings with fixes, and the real reason a run failed), and the `check` input documents comma-separated ids.
- The generated facts snapshot now includes `nodeFloor` (minimum Node version from `engines.node`) and `clientCount` (size of the client registry).
- **Compliance report shows when each framework's mappings were last verified.** Every framework section now prints `Mappings last verified: YYYY-MM-DD` under its status, so an auditor can see how old the control-ID mapping is against the primary source. The date lives in `FRAMEWORKS` and is bumped only after a real re-check.
- **`--fail-on <critical|warning>`** — exit 1 when any finding is at that severity or worse, regardless of score; `warning` includes `critical`. Respects suppressions and works with `--recursive`. An unknown level is an argument error (exit 2).
- `mcp-hash`, `mcp-pin` and `mcp-verify` accept an opt-in `--connect` flag that launches one named local stdio MCP server from the project config and reads its live `tools/list`, so runtime tool pinning no longer needs a manual pipe. A scan still never spawns a server. Each launch needs per-run consent (an interactive `[y/N]` or `--yes`; no terminal and no `--yes` refuses with exit `2`), prints the exact argv, working directory and env keys first, runs with a minimal environment, refuses relative commands or scripts that escape the project through a symlink, and kills the process tree after the list is read or after 15 s (`RIGSCORE_CONNECT_TIMEOUT_MS` overrides). A timeout or malformed reply exits `5`. The consent prompt prints each argv element as typed, so a Windows path shows its single backslashes rather than JSON-doubled ones, and control characters are shown as `<0xNN>`.
- The terminal report now ends with a one-line pointer to `--fix` when a fixer matches a finding, and `--json` output carries `rigscoreVersion` and `schemaVersion` keys (additive; existing keys unchanged).
- SARIF results now carry `region.startLine` (and CodeClimate `lines.begin`) when a finding supplies `context.file` and `context.line`, so GitHub code scanning annotates the right line instead of line 1. Each rule's `helpUri` defaults to that check's docs page. Findings that describe the home directory (shell-history secrets, `~/` skill files) get no repo location, and absolute, `..` and drive-letter paths are never emitted as locations.
- `release.yml` now publishes the package to npm on each release using npm trusted publishing (OIDC from GitHub Actions, no stored token), so `npx rigscore` and `npm i -g rigscore` work from the first release after this change. The step skips a version npm already has, so a re-run does not fail. The README, troubleshooting page and workflow headers no longer say the package is GitHub-only.

### Changed
- The four release-time workflows (`release.yml`, `docker-publish.yml`, `prebuilt-binaries.yml`, `release-provenance.yml`) now run on the self-hosted runner. `ci.yml` stays GitHub-hosted: its `test` and `secret-scan` jobs are `pull_request`-triggered on a public repository, and its matrix covers `macos-latest` and `windows-latest` that no self-hosted runner here provides.
- `engines.node` floor raised to `>=20.0.0` (Node 18 is EOL as of 2025-04-30). The `18.17` CI matrix leg and its PR-time exclude entries are dropped, along with the dependabot `vitest`/`@vitest/coverage-v8` hold that existed only to dodge that leg's `styleText` failure.
- The four release-time workflows (`release.yml`, `docker-publish.yml`, `prebuilt-binaries.yml`, `release-provenance.yml`) now run on GitHub-hosted `ubuntu-latest`. The org self-hosted runners do not serve public repositories, so these jobs were never picked up (the 2026-09-10 and 2026-09-12 Release runs queued 24h and were cancelled).
- Terminal report: each finding now shows its id in square brackets with a one-time `rigscore explain <id>` hint, output wraps to the terminal width (80 when piped), and the check-name and project columns size to the longest entry instead of a fixed width.
- `skill-files/tag-chars` and `unicode-steganography/tag-chars` now share one pattern covering the whole Unicode Tags block (U+E0000-U+E007F), so both checks also flag U+E0000 and U+E0002-U+E001F. The duplicated `gitCheckIgnore` and `toRegex` helpers moved into `src/utils.js`.
- The terminal report now folds `governance-docs` missing-rule warnings into one warning that lists every missing rule, with one fix line and the member ids, instead of one near-identical warning per rule. Display only: JSON, SARIF, scoring and `--ignore` still see one finding per rule with its own id.

### Fixed
- Windows CI no longer flakes the wall-clock perf gates. `test/performance.test.js` scales its tight `elapsed <` assertions (5s, 15s) by 3x on win32 — the same factor `vitest.config.js` applies to test/hook timeouts (#371 fixed those; the in-body perf assertions were the sibling it left untouched). A loaded windows runner (measured 1.6x slow) had pushed the 20-project recursive scan past its 15s ceiling on a now-blocking leg, reddening a PR that changed no scanner code. The gate still catches a genuine algorithmic regression, which blows past even a 3x-scaled ceiling. Linux behavior is unchanged (`perf()` is identity off-windows).
- The changelog fold is no longer blocked by its own tests. The `meta-ci-contract` RS-4 block pinned specific fragment files by id, but `assemble-changelog --release` deletes fragments as it folds them — so the assertions could only hold until the first real release, then failed forever, leaving the repo unable to cut a release with folded notes (fragments piled up unfolded and 2.2.0 shipped raw git-log notes). Replaced the file-pinning assertions with a pure-function check that `renderRelease()` folds the current `changelog.d` cleanly (version section stamped, empty Unreleased re-opened, every fragment body preserved) — robust by construction, no network or filesystem mutation. Folding into the release workflow remains a separate follow-up.
- A forced site re-post now reports the changes it actually shipped. `force_site_post` re-runs the release for a version whose tag already exists, and the previous-tag lookup (`git describe --tags --abbrev=0`) returned that same tag — so the range collapsed to `vX..vX`, the changelog came out empty, and the generated post was a 70-word stub with no change table that the release-post validator rejected. The lookup now excludes the version being released, which is a no-op on a normal release (the tag does not exist yet) and yields the real predecessor on a re-post.
- A forced site re-post can now run more than once. `force_site_post` re-runs a cross-repo site post that failed, but the job built the release branch fresh every time and pushed it plain — so once the first attempt had left `rigscore-release/v<version>` on the site repo, every re-dispatch was non-fast-forward and died before publishing, and `gh pr create` would have failed on the duplicate PR immediately after. The branch is now reused and force-published (its content is wholly derived from the released tag and the facts generator, so the regenerated commit is authoritative), and the PR is opened only when one is not already open.
- `rigscore init --example` now refuses to scaffold into a directory that already holds a real project (`.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`), printing what it found and how to proceed; `--force` still allows it deliberately. The example is intentionally vulnerable — a privileged `docker-compose.yml`, a root `Dockerfile`, an `.mcp.json` granting a filesystem MCP server access to `/`, and a prompt-injection skill — so a real source tree is the one place it must never land. Run once by mistake inside a live service directory, those files persist untracked, where neither review nor CI will surface them.
- `rigscore init --example [dir]` now scaffolds into the positional directory instead of always using the current one, matching how `init --<pack> [dir]` already behaved. Previously the argument was accepted and ignored, so `rigscore init --example demo` wrote the deliberately-vulnerable demo project into the caller's own directory — which is exactly the command the new real-project refusal suggests running.
- **Plugin discovery works in a real `node` process.** `discoverPlugins()` imported the plugin package *directory*, which Node's ESM loader rejects outright (`ERR_UNSUPPORTED_DIR_IMPORT`) — so no `rigscore-check-*` plugin has ever loaded outside the test suite. It looked healthy because vite's resolver silently substituted the package entry point when tests ran, so every plugin assertion passed against behaviour Node does not have. rigscore now resolves the entry the package declares (`exports` `.` subpath honouring `import`/`node`/`default`, then `main`, then `index.js`) and imports that file. An entry that is missing, or that points outside the package directory, is reported to stderr and skipped rather than loaded. Regression tests run discovery in a real `node` subprocess so a bundler's resolver can never stand in for Node's again.
- **`workflow-maturity/skill-no-eval` required a directory, not coverage.** The check `stat()`ed `evals/<skill>/` and passed on the strength of its existence, so `mkdir` alone turned it green — as did a `tests/test_<skill>.*` file of zero bytes. A repo running rigscore accumulated 17 eval directories holding nothing but a README that said "STUB — presence-check satisfier; replace with real fixture before claiming coverage", and the dashboard reported full eval coverage the whole time. An eval directory now counts only when it carries something runnable or gradeable at its top level — an executable `test_*.sh`, a `cases.jsonl` with at least one `{"prompt": …, "expected_assertions": …}` line, or a non-empty `acceptance-criteria.md` — and a `tests/test_<skill>.*` entry counts only when it has content. A placeholder that exists but covers nothing reports under a new id, `workflow-maturity/skill-eval-hollow` (info), so "created a stub" is distinguishable from "never created one" at a glance; `skill-no-eval` keeps its exact former meaning for the nothing-at-all case.
- The public release workflow no longer names or automates against the private site repo. `.github/workflows/release.yml`'s cross-repo facts-sync job (token clone + `gh pr create` into the private repo) is removed along with the `force_site_post` re-post input that served it; that sync now runs downstream, in the site repo, pulled from this repo's public releases instead of pushed by this repo.
- The `container` init pack's "no leaked identifiers" test no longer publishes the client project names it guards against — those move to the `FORBIDDEN_EXTRA` repo secret (comma-separated), with CI asserting the secret is set so the guard can't silently vanish; the generic tokens stay in the public test file for local runs.
- CI no longer fails every Dependabot pull request on the `FORBIDDEN_EXTRA`
  presence check. Dependabot-triggered runs read GitHub's separate Dependabot
  secret store, so `secrets.FORBIDDEN_EXTRA` is always empty there; the guard
  now exempts exactly those runs and stays blocking everywhere else.
- `skill-files` no longer counts non-text files toward `data.filesScanned`. A
  binary in a skill directory is reported in the new `data.filesNonText` count
  and as `skill-files/non-text-file`, so it cannot raise scan coverage while
  yielding a clean verdict.
- `infrastructure-security` and `mcp-config` no longer read the operator's `$HOME` unless `--include-home-skills` is set. Before, the deny-list check read `~/.claude/settings.json` first, and `mcp-config` scanned every home MCP config (`~/.claude.json`, `~/.cursor/mcp.json`, Zed, Codex, Goose, Cline …) and home `enableAllProjectMcpServers`. So the same project scored 65 on a bare CI runner and 81 on a laptop. Both checks now go through `src/lib/home-scope.js` like every other home-reading check, and a project's verdict no longer depends on who ran the scan.
- The Homebrew formula pin now follows each release automatically. The release workflow opens a pull request that points `Formula/rigscore.rb` at the new tag and its sha256 (and dispatches CI on it), warning loudly if it cannot open the PR; the formula is pinned to v2.2.0, and the pin test no longer hardcodes a version. (#430)
- **instruction-effectiveness:** dead-file-reference no longer flags `path::symbol` refs (the file is still checked), path-led commands with arguments, or scheme-less URLs such as `youtu.be/` and `github.com/org/repo`. A path containing a space is now read as a command and not checked.
- `rigscore init --help` now prints usage and writes nothing (it used to write a `.rigscorerc.json`). `rigscore explain <checkId>/<slug>` now resolves a finding id from the check page's Triggers table and prints its severity, condition and fix, instead of falling back to the whole page; heading matches are exact, and an unknown id lists the documented ids.
- `infrastructure-security` now runs on macOS and Windows instead of returning N/A. The hooks path, git wrapper, deny list and sandbox-gate arms are plain file reads and run everywhere; only the `lsattr` immutable-flag arm and the default `/etc/profile.d` safety-guard lookup stay Linux-only (off Linux, declared `immutableDirs` report an info `cannot-check-immutability` finding naming the platform), and Windows skips the uid-0 and execute-bit rules.
- `rigscore init --<pack>` no longer writes through symlinks. A pack destination that is itself a symlink (including a dangling one, which previously read as absent) or whose parent directory resolves outside the target directory now refuses the whole pack with a named error before anything is written. Installing into a target directory that does not exist yet still works.
- **config:** `semantic.command` (the program `--semantic` spawns) is now read only from the home `~/.rigscorerc.json`. A value in a scanned project's `.rigscorerc.json`, or in a file it extends, is ignored with a one-line stderr warning, so a scanned repo can no longer choose what runs.
- `walkDirSafe` no longer follows a symlink that leaves the scan root (`link -> /`, `link -> ~/.aws`); it reports `outsideRootSkipped`, and `deep-secrets` discloses it (`deep-secrets/outside-root-skipped`) instead of printing "Deep scan clean".
- The release workflow now dispatches the prebuilt archives workflow on the released tag, so every release gets its archives attached; it passes release notes to `gh release create` as a file instead of a step output, so a commit subject can no longer forge outputs; coverage counts every `src` file; and Dependabot proposes Docker base-image bumps (major Node bumps excluded).
- Two skill-file tests no longer fail when the suite runs under `umask 000`: they pin the mode of the files they write to 644. Tests that passed `homedir: '/tmp'` now get a fresh temporary home, so they stop scanning whatever sits in the host's `/tmp`. Test-only change.
- Windows: skill files, rule files and Kubernetes manifests no longer drop out of a scan at random. The directory walker keyed visited folders on a file ID that loses precision above 2^53 (common on NTFS), so two sibling folders could look like a symlink loop and the second was skipped. It now reads file IDs at full precision.

### Security
- The CI and leak-scan workflows now declare read-only token permissions, the prebuilt-binaries release workflow passes the release tag through the environment and refuses anything that is not `vX.Y.Z[-prerelease]`, and CI audits production dependencies for high-severity advisories.
- **plugins:** a scan no longer loads plugin code that the scanned repo supplies. The paths in a project's `.rigscorerc.json` `plugins` and the `rigscore-check-*` packages in `<repo>/node_modules` now load only when your home `~/.rigscorerc.json` lists that repo's absolute root in `trustProjectPlugins`, for example `{ "trustProjectPlugins": ["~/code/my-repo"] }`. Existing users who rely on in-repo plugins opt in by adding that entry (with `--recursive`, one entry per subproject). A skipped plugin is named in one stderr line. Plugins installed beside rigscore itself still load, and `trustProjectPlugins` in a project config is ignored.

### Docs
- `workflow-maturity`'s docs no longer overclaim for the new `graduated-script-missing` sub-check. The check declares `enforcementGrade: `keyword`` ("evadable by rewording; advisory only") and a weight rationale asserting every finding is a roadmap-dependent judgment call — both true of sub-checks 1-5 and both false of sub-check 0, which resolves a script path and asks the filesystem whether it exists. THREAT-MODEL.md tells auditors to discount `keyword` signal and treat `mechanical` findings as load-bearing, so the unqualified gloss pointed readers away from a finding they should trust. Grade and weight are declared per check, so the discrepancy is documented rather than mislabelled, including its consequence: a broken graduated skill currently costs zero points and is visibility only. Scoring it needs its own check or per-finding weights — an open decision, now recorded as one.
- **README carries its own governance record**: a closing "Project governance" section states rigscore's Purpose, Owner, Status, and Exit Condition, so the workspace README contract is satisfied by the file itself rather than by an exception entry that expired 2026-06-30.
- **Contact addresses point at the org account.** `SECURITY.md`'s vulnerability-report fallback and `CODE_OF_CONDUCT.md`'s conduct-report address named a personal inbox; both now name the monitored org address. README's Owner link points at the `Back-Road-Creative` org rather than a personal GitHub profile (the visible handle text is unchanged). Added a `.mailmap` so the four name/email spellings one person committed under resolve to a single contributor in `git shortlog`/`log`/`blame` — display only, no commit is rewritten, and bot identities stay distinct.
- **Public-facing docs and fixtures**: authoring-machine paths and private monorepo layout references genericized in docs, fixtures, and one remediation string. The `agent-output-schemas` check now points readers at rigscore's own `docs/checks/agent-output-schemas.md` instead of a file only the authoring workspace can open.
- **Docs gate covers README and CLAUDE.md**: `npm run verify:docs` now fails when the README lead drops "any AI client" or states a stale known-client count, and when `CLAUDE.md` has the wrong title or omits a check in `src/checks/`. README.md is link-checked too. CLAUDE.md and the README lead were brought current in the same change.

## [2.2.0] - 2026-07-18

### Added
- Client registry now recognizes **OpenClaw** (`~/.openclaw/openclaw.json`, whose MCP servers nest under `mcp.servers` and whose per-server `env` maps can hold plaintext secrets) and **Google Antigravity** (`~/.gemini/antigravity/mcp_config.json` for MCP, plus `AGENTS.md` for project governance), so their config-at-rest MCP and credential surfaces are scanned and inventoried like every other registered client.
- Config: `semantic.command` rc key (default `["claude", "-p"]`) makes the opt-in `--semantic` tool-description judge configurable — point it at any first-party agent CLI (`gemini`, `codex exec`, …) instead of the hardcoded `claude` binary; never an API key. Skip-if-absent and timeout behavior unchanged.
- New `codex-guards` starter pack (`rigscore init --codex-guards`) scaffolds a least-privilege OpenAI Codex CLI baseline (`.codex/config.toml`): an `approval_policy` that prompts before anything that isn't a known-safe read-only command, a `workspace-write` sandbox, and network access off by default — so a Codex-governed repo starts from a hardened posture the `sandbox-posture` check recognizes.
- The `skill-files` check now derives its scanned command/skill/prompt directories from the client registry (`src/clients.js` `skillDirs`) instead of a hardcoded `.claude/**` pair. Project scans now cover `.opencode/commands/` and `.gemini/commands/` alongside `.claude/commands/` and `.claude/skills/`; `--include-home-skills` now extends to every registered client's home dir (`~/.codex/prompts/`, `~/.config/opencode/commands/`, `~/.gemini/commands/`, plus the Claude dirs). A client with no `skillDirs` surface contributes no dirs. Directory conventions verified against each client's current official docs.
- MCP surfaces now declare their on-disk **format**, so non-JSON client configs are read instead of skipped. Codex CLI's `~/.codex/config.toml` (servers under `[mcp_servers.<name>]`) and Goose's `~/.config/goose/config.yaml` (extensions under `extensions`) plus `secrets.yaml` are scanned by `mcp-config`, `network-exposure` and `credential-storage`. A single loader (`readMcpConfig`) dispatches on the declaration; TOML is read by the same minimal reader that grades Codex's sandbox knobs, YAML by the existing `yaml` dependency. Registry totals: 24 clients with MCP config paths, 21 holding 23 credential files.

### Changed
- Renamed the flagship governance check from `claude-md` to `governance-docs` — it scans the vendor-neutral governance-file superset (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, …), so the Claude-only name misbranded it. The old `claude-md` id keeps working as a `--ignore` / `suppress:` / `weights:` alias for at least one full major version (via `FINDING_ID_RENAMES`), the check-level SARIF rule carries `deprecatedIds: ["claude-md"]`, and finding ids now emit under the `governance-docs/` prefix. See `docs/FINDING_IDS.md` → "Renamed IDs".
- The `windows-latest` CI legs are now blocking. They ran under `continue-on-error` while the pre-existing win32 breakage their introduction surfaced was worked off — a dynamic `import()` of an absolute path that needed `pathToFileURL()` (the scan aborted outright on win32), native path separators leaking into findings, SARIF `artifactLocation.uri` and baseline keys, non-atomic state writes, and CRLF splicing the ESM preamble ahead of the hashbang because runners set `core.autocrlf=true` against a repo with no `.gitattributes`. All three legs now pass on their own, which the workflow comment named as the acceptance test for the flip. Advisory-but-red also carried a process cost: the merge wrapper refuses on any failing check, required or not, so every merge needed `--force` — a habit that erodes the signal `--force` is supposed to carry. `windows-latest` remains outside the branch-protection required contexts; promoting it there is a separate repo-admin change.

### Fixed
- The release workflow now dispatches `docker-publish` and `release-provenance` on the released tag after `gh release create`, so the GHCR image and signed provenance publish on every release (a `GITHUB_TOKEN`-created tag cannot re-trigger `push: tags` workflows). The dispatched Docker build checks out the tag, normalizes the image tag (`<version>` + `latest`, matching the tag-push path), and stamps the real version into the OCI `image.version` label; `release-provenance` no longer overwrites the curated release notes. `action.yml`'s own action refs are SHA-pinned and all release-path actions are updated to their current SHA-pinned versions.
- Hardened the release-to-headlessmode site-post path: the workflow now validates `HEADLESSMODE_PAT` before the cross-repo clone (failing loudly on a dead token instead of an opaque `git clone` exit 128), opens a tracking issue when the site post fails, passes the changelog to the export step via `env:` instead of raw `${{ }}` interpolation (so commit/PR titles with shell metacharacters cannot execute in the runner), and accepts a `force_site_post` dispatch input so a re-run after rotating a dead PAT re-posts instead of silently skipping.
- A `suppress:` / `--ignore` pattern that matches no finding — a typo, or an id renamed out from under a stale `.rigscorerc.json` — now warns on stderr instead of silently no-oping, and the `FINDING_ID_RENAMES` alias makes `docs/FINDING_IDS.md`'s rename promise real. `rigscore init --guards` computes the permissions-manifest expiry at install time instead of shipping a hardcoded date, so a freshly scaffolded manifest never fails its own suggested CI gate on day one.
- `--watch` now passes the full scan options through the rescan loop (`--no-state-write`, `--include-home-skills`, `--semantic`, and MCP-registry refresh were dropped), re-applies `suppress:` / `--ignore` on every rescan so muted findings stay muted, and derives its watched paths from the client registry so 2.1.0 governance surfaces (`.roorules`, `.goosehints`, `QWEN.md`, `CRUSH.md`, `.junie/guidelines.md`, directory-form rule sets) trigger a rescan. On Linux + Node < 19.1 — where recursive `fs.watch` is unavailable — `--watch` now degrades to a non-recursive watch of the root and governance dirs instead of crashing, keeping Node 18 usable.
- A mistyped flag no longer looks like a clean parse. Unknown flags now emit `rigscore: warning: unknown flag …` (still tolerated for CI forward-compat), a value flag left dangling (e.g. `--check` with no value) warns instead of being silently swallowed, and a dangling or malformed `--fail-under` — the safety gate — is now **fatal** (exit 2) rather than silently falling back to the default threshold, matching rigscore's "a scan that gave up must never look like a clean one" invariant.
- Upgraded `@cyclonedx/cyclonedx-library` to 10.1.0. v10 moved `ajv`, `ajv-formats` and `ajv-formats-draft2019` from the library's `optionalDependencies` to *optional* `peerDependencies`, which npm does not auto-install — so the CycloneDX JSON schema validator backing the SBOM test had no implementation to load and every `validate()` call failed with `No JsonValidator available.` Those three are now declared as devDependencies, restoring real CycloneDX 1.6 schema validation of the emitted AI-BOM. Supersedes #338.
- Rendered paths are now POSIX on every platform. `path.relative()`/`path.join()` return native separators, so on Windows findings rendered `apps\api\.env` and `.specify\memory\constitution.md` where ubuntu/macOS — and the output contract — produce `/`. Those strings are data, not decoration: findings are compared verbatim, SARIF `artifactLocation.uri` is URI-style and must use `/` for GitHub code scanning to map it back to a repo file, and baseline/state keys are matched as plain strings across machines (a Windows-produced key silently missed its Linux counterpart, so the finding re-appeared as "new"). Shared `toPosix()`/`relPosix()` helpers in `src/utils.js` now back every displayed, compared or serialized path; paths handed to the filesystem stay native. A no-op on Linux and macOS.
- MCP config-path matching is now separator-agnostic. Registry paths are POSIX literals, but callers pass either a native absolute path or a repo-relative POSIX one; comparing with `path.sep` mixed the two up on Windows, so the entry lookup missed and every client with a non-default or multi-valued server key silently fell back to `mcpServers`. That is what dropped Cody's `.vscode/settings.json` server (key `cody.mcpServers`) and VS Code's `servers` key from the CycloneDX AI-BOM on the Windows legs.
- Windows correctness across the product, found by making the `windows-latest` CI leg tell the truth. `saveState` now retries a rename Windows transiently refuses (`EPERM` when any process holds the state file open) instead of throwing away the write. The `--baseline` provenance gate canonicalizes both the baseline path and the git toplevel before relating them, so a directory spelled two ways (a Windows 8.3 short name, a symlinked temp root) no longer reads as "outside the repo" and falls back to the working-tree baseline a PR controls — it was failing **open** on the one comparison it exists to make. `utils.decodeBuffer` normalizes CRLF/CR to LF at the single decode chokepoint, so `$`-anchored line regexes (systemd `ExecStart=`) no longer go silently blind on a CRLF file. `instruction-effectiveness` normalizes its file labels to `/`, so the `.claude/commands/` and skill `evals/` dead-ref exemptions stop missing on win32; `memory-hygiene` no longer mistakes a `C:\…` drive letter for a URI scheme and skip the entry; the CycloneDX BOM emits `/`-shaped `file:` refs for skills. A repo `.gitattributes` pins LF in the working tree on every platform.
- Codex CLI's **committed** `.codex/config.toml` is now scanned and pinned like any other repo-level MCP config. Previously only the `$HOME` copy was registered, so a `[mcp_servers.<name>]` server added or mutated in that reviewed-once repo file drifted nothing — the CVE-2025-54136 rug-pull gate reported `not-applicable`, the AI-BOM omitted it, and its `env` values were never scanned for plaintext credentials. The three repo-level consumers (`readRepoServers`, which mints *and* verifies the pin; the CycloneDX export; and `repoMcpEnvValues`) now read through the format-dispatching `readMcpConfig()` seam, so `repoMcpRelPaths()` keeps its contract of naming exactly the set the pin covers. Existing JSON configs hash unchanged, so a committed `.rigscore-state.json` stays valid.
- The `windows-latest` CI legs no longer flake on timeouts. `testTimeout` and `hookTimeout` scale to 30s on win32 (10s elsewhere, unchanged). The 10s limit was calibrated when the matrix was ubuntu + macOS; process spawn is several times slower on the windows runners — the full suite takes 15.5s on linux against 79.2s on windows — and the three slowest files (`baseline`, `order-determinism`, `spec-goals`, all of which fork `git` and the CLI repeatedly) already run 10.7-25.5s per file against a 10s PER-TEST limit on a healthy run. A routine runner slowdown was therefore enough to red the build with no code change: main @1c8cb5e failed on those exact three files with six timeouts and zero assertion failures, and a re-run of the same commit went green. Left unfixed, a flaky blocking leg would have reimposed `--force` on every merge — the habit that making the legs blocking was meant to end.

### Docs
- **CI docs**: documented running rigscore in any CI — a generic exit-code contract (`0`/`1`/`2`), the `--ci` / `--sarif` / `--fail-under` flags, and a GitLab CI `.gitlab-ci.yml` example alongside the existing GitHub Action.
- `docs/ROADMAP.md` no longer cites named competitors as evidence — each roadmap item now stands on its own capability description and current gap. Added four deferred LLM/environment-agnosticism entries: CI agent-capability scanning beyond GitHub Actions (GitLab CI), a scored per-client settings-safety family, a registry-driven `env-exposure` client list, and cross-vendor `memory-hygiene` conventions.
- **Neutralized tool pointers in `docs/known-limits.md` and `THREAT-MODEL.md`**: the honest "what rigscore does not detect" disclosures now name generic capability categories (source-level SAST, git-history secret scanner, live MCP introspection scanner, etc.) instead of specific third-party products.
- **README positioning**: restated in rigscore's own terms — removed the third-party comparison section and named-competitor clauses; a README test now gates against reintroducing third-party tool/vendor names.

## [2.1.0] - 2026-07-15

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
  specifics and the per-grade classification rationale.
- **Directory-form rule sets are now scanned by default.** `.cursor/rules/*.mdc`,
  `.windsurf/rules/`, `.clinerules/` (directory form), and
  `.github/instructions/*.instructions.md` are read with no `.rigscorerc.json`
  opt-in, union'd with any configured `paths.governanceDirs`. A repo governed
  only by `.cursor/rules/*.mdc` no longer scores "no governance," and the
  `claude-md` injection, `unicode-steganography`, and `instruction-effectiveness`
  checks now run on those files. Vendor-exact extensions (Cursor `.mdc`, Copilot
  `.instructions.md`; Windsurf/Cline accept any non-dotfile) live in
  `src/clients.js`; a shared `collectGovernanceDirFiles()` reuses the existing
  symlink-safe walker so the three checks agree on what a rule set contains.
- Client registry now recognizes Amazon Q Developer (`.amazonq/mcp.json`, `.amazonq/default.json`, `~/.aws/amazonq/`), Roo Code (`.roorules`, `.roo/mcp.json`), and Cody (`cody.mcpServers` in `.vscode/settings.json`), so their governance, MCP, and credential files are scanned, rug-pull-pinned, and inventoried like every other client.
- **`credential-storage` and `network-exposure` now scan Claude Code's real user
  store, `~/.claude.json`.** rigscore modeled only the project-committed
  `.mcp.json`; `~/.claude.json` — which holds MCP servers in a top-level
  `mcpServers` (user scope) and under `projects[<abs-cwd>].mcpServers` (local
  scope, the default) — was invisible, so plaintext secrets in those servers'
  `env` maps went undetected. A new `mcpServersForConfig()` resolves both places
  for the repo being scanned (local-scope entries win a name collision). It stays
  outside the rug-pull pin by design: `~/.claude.json` is home-scoped, and no pull
  request can reach it.
- **`sandbox-posture` now grades Gemini CLI, opencode, and Cursor approval posture.**
  Beyond Codex CLI and Claude Code, the check reads Gemini CLI's
  `general.defaultApprovalMode` (`.gemini/settings.json`: `"yolo"`/`"auto_edit"`
  flag, `"plan"` is restricted), opencode's `permission` block (`opencode.json`:
  `bash`/`*` `= "allow"` auto-runs shell unprompted, `"deny"` is restricted), and
  a `"*"`/`"*:*"` wildcard in Cursor's committed `.cursor/permissions.json`
  allowlists. Each reuses the existing restricted/partial/unrestricted reducer
  via one reader + rule table per format. Windsurf is not graded — its Turbo-mode
  auto-execute posture lives only in the Settings UI, with no committed in-repo
  file to read.
- **New `src/lib/config-merge.js` — an idempotent, non-destructive JSON/YAML deep-merge engine.** The Phase-2 keystone that lets rigscore harden a config that *already exists* (previously the only install path scaffolded brand-new files and skipped any dest present). It adds absent keys, unions arrays by value, leaves any conflicting user value untouched (reported, never clobbered), preserves YAML comments/order via the `yaml` Document API and emits stable 2-space JSON, and is idempotent on a second pass. The pure `mergeConfig` never writes; `writeMerged` is the only disk writer. TOML is deferred by construction (no round-trip TOML parser ships); the engine fails a `toml` call explicitly rather than faking a merge.
- Client registry: JetBrains Junie (`.junie/guidelines.md`, `.junie/mcp/mcp.json`), Goose (`.goosehints`), and Warp (`.warp/.mcp.json`) are now recognized across governance, MCP scanning, rug-pull pinning, and credential surfaces.
- `skill-coherence` now reads default directory-form governance (`.cursor/rules/*.mdc`, `.windsurf/rules/`, `.clinerules/` dir, `.github/instructions/*.instructions.md`), so a repo governed only by those still feeds its constraint-awareness check.
- **`mcp-config` now has an auto-fix for the MCP auto-approve bypass.** `rigscore --fix --yes` disables `enableAllProjectMcpServers` in the project's `.claude/settings.json`, remediating both `mcp-config/mcp-auto-approve-enabled` and `mcp-config/cve-2025-59536-auto-approve-on-clone` (CVE-2025-59536). The fix is idempotent, touches only that one key while preserving the rest of the file, never creates or clobbers a missing/corrupt file, and never rewrites the per-user homedir settings. Every other `mcp-config` finding still requires human judgment.
- Hardened-baseline install packs for non-Claude clients — `cursor-guards`, `opencode-guards`, `gemini-guards` — each installing a generic least-privilege approval/permission config that moves the client's `sandbox-posture` grade off `unrestricted`.
- `docker-security` findings for a missing `cap_drop: [ALL]` and missing `no-new-privileges` are now auto-fixable via `--fix` — each adds the key through the additive config-merge engine, preserving comments and never overwriting an operator's existing value.
- **`coherence/undeclared-mcp-server` is now `--fix`-able.** The weight-14
  `coherence` check previously exported no fixes. `--fix --yes` now appends a
  clearly-marked placeholder declaration section (`## MCP server: <name>`) for
  each undeclared MCP server to the project's primary governance file (CLAUDE.md
  if present). The fixer is append-only (existing content is never rewritten or
  reordered), idempotent (a server already named in the file is skipped), and
  declines when the repo has no governance file rather than fabricate one. The
  mismatch findings remain no-auto-fix — resolving a governance/config
  contradiction requires a human to choose the source of truth.
- Pack `pack.json` gains a `defaults` map (`PLACEHOLDER → applied value`), substituted at install so a shipped pack works out of the box. The `container` pack now resolves `EGRESS_SUBNET` to `172.30.0.0/16` and `ALLOWED_HOSTS` to a deny-all fail-closed default, so its egress proxy is no longer inert on install.
- **`docker-security --fix` can now remove `privileged: true` and the Docker socket volume mount.** Two removal-class compose fixers (`docker-remove-privileged`, `docker-remove-docker-socket-mount`) complete the pair started by the additive fixers. Because deletion is outside the additive config-merge engine, they edit the compose file through the `yaml` Document API: only the exact flagged construct is dropped, `privileged: false` is left alone, a now-empty `volumes` key is removed, and every unrelated key, service, volume, and comment survives. Idempotent, and an absent or unparseable compose file is skipped rather than rewritten.
- `rigscore init --<pack> --merge` (alias `--harden`) hardens an EXISTING config in place: it merges a pack's keys into an existing json/yaml dest via the additive config-merge engine instead of skipping it. Additive-only — a value you already set is kept and reported as a conflict, never overwritten; arrays union; YAML comments survive. A corrupt or non-mergeable dest (shell hook, `.conf`, TOML) falls back to the current skip. `--merge` and `--force` are mutually exclusive (merge wins). The `--fix --install-packs` path stays skip-only for now.
- **pre-commit.com framework support.** A `.pre-commit-hooks.yaml` at the repo
  root lets adopters run rigscore via the [pre-commit](https://pre-commit.com)
  framework — add `- id: rigscore` under a
  `repo: https://github.com/Back-Road-Creative/rigscore` entry in
  `.pre-commit-config.yaml`. `language: node` installs rigscore from the cloned
  repo and exposes its `bin`, so no npm publish is needed. This is the
  framework-managed alternative to the native `rigscore --init-hook` installer.
- **The composite GitHub Action is now GitHub-Marketplace-listable.** `action.yml`
  gains a top-level `branding:` block (`icon: shield`, `color: green`) — the
  metadata GitHub Marketplace requires to list the action — and the README
  Distribution section gains a copy-paste workflow example wiring
  `uses: Back-Road-Creative/rigscore@v2.0.0` with `upload-sarif: true` and a
  `fail-under`, reiterating that the action must be pinned to an exact `vX.Y.Z`
  tag.
- Config `extends`: a `.rigscorerc.json` (home or project) can inherit from one or more shared baselines via an `extends` key, so a single hardened config is reusable across many repos. Local paths only (relative resolves against the declaring file's directory), recursive and cycle-safe, later array entries override earlier, and the extending file's own keys win. URLs are rejected — never fetched — preserving the no-external-calls-by-default guarantee.
- **Three more AI dev clients in the registry: Kiro, Qwen Code, and Crush.**
  Kiro (`.kiro/settings/mcp.json`, `~/.kiro/settings/mcp.json`), Qwen Code
  (`.qwen/settings.json`, `~/.qwen/settings.json`, governance `QWEN.md`), and
  Crush (`.crush.json` / `crush.json` / `~/.config/crush/crush.json`, servers
  under the `mcp` key, governance `CRUSH.md`) now flow through the existing
  MCP-config, coherence, credential-storage, and env/network-exposure checks
  with no new finding or check. Their committed configs join the CVE-2025-54136
  rug-pull pin and the CycloneDX AI-BOM for free, since `src/clients.js` is the
  single surface list every consumer reads.
- **The `--cyclonedx` AI-BOM now models the grant surface** — the thing a generic
  SBOM generator cannot see. Each MCP server component carries `rigscore:grant:*`
  properties for its auto-approve state (`enableAllProjectMcpServers`, via the same
  `checkClaudeSettings` parser the mcp-config check uses) and the `.claude/settings.json`
  allow/deny entries that scope it (`mcp__<server>` / `mcp__<server>__<tool>`; tool
  identifiers only, never secret values). Skills (`.claude/{skills,commands}/<name>/SKILL.md`)
  and directory-form rules (via `collectGovernanceDirFiles`) are added as hashed `file`
  components with `rigscore:file:role` = `skill` / `rule`. Stays CycloneDX 1.6-valid
  (properties + hashes only) and reuses the existing check parsers — no drifting reader.
- `--fix` now strips `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` redirects (CVE-2026-21852) from committed MCP server configs. The new `anthropic-base-url-redirect-strip` fixer remediates the existing `mcp-config/anthropic-base-url-redirect` finding: it scans project-level MCP configs (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, etc.), deletes only a redirecting key whose value would actually fire the finding (an `api.anthropic.com`/loopback override is left alone), preserves unrelated servers/keys and order, is idempotent, and never rewrites per-user homedir configs.
- Governance scanning now recognizes Amazon Q's `.amazonq/rules/*.md` and Kiro's `.kiro/steering/*.md` directory-form rule sets by default, so a repo governed only by those is no longer mis-scored as ungoverned (they flow through every governance-scanning check and the CycloneDX BOM).
- Broadened `KEY_PATTERNS` secret detection with six genuinely-missing provider token formats, all under the existing secret finding (no new `findingId`): GitHub user/server/refresh tokens (`ghu_`/`ghs_`/`ghr_`) and fine-grained PATs (`github_pat_`), Google OAuth client secrets (`GOCSPX-`), legacy OpenAI keys (`sk-` + 48), Shopify app tokens (`shpat_`/`shpss_`/`shppa_`/`shpca_`), and Databricks PATs (`dapi`). Every pattern is `\b`-anchored and length-bounded to keep false positives low; UUID-only formats (e.g. Postmark) are deliberately excluded, and the docs note the trufflehog/gitleaks handoff for git-history/entropy scans.
- **Opt-in `--semantic` tool-description judge (`semantic-tools` check).** Catches
  *obfuscated* MCP tool poisoning — a hidden directive paraphrased into a tool
  description so the static regex checks never fire. OFF by default and makes zero
  external calls unless you pass `--semantic`; then it hands each tool description
  (read from `tools/list` snapshot files listed under `paths.mcpToolsSnapshot`,
  the same JSON piped into `rigscore mcp-hash`) to your own first-party `claude -p`
  to classify benign vs. suspicious. First-party CLI only — never an API key or SDK
  client — and it shells out via `execSafe`, so a missing `claude` skips gracefully
  (no finding, no crash). Each description is wrapped in a data-only frame and the
  judge is told to treat it as data, not instructions, so a poisoned description
  cannot hijack the judge. Advisory (weight 0). New finding id
  `semantic-tools/suspicious-tool-description`.
- **Practice score — a second 100-point axis.** Alongside the Security hygiene
  score, rigscore now computes and prints a `Practice` score from the
  Practice-pillar advisory checks (`loop-governance`, `spec-goals`,
  `ci-agent-caps`, `memory-hygiene`), surfaced on every terminal run and in
  `--json`. It is `n/a` (never `0/100`) when the repo has no practice surface to
  score, so a repo simply out of scope is not libelled with a zero. The Security
  axis is unchanged — these checks stay weight-0 there, so no existing score
  shifts.
- **10MB response-body cap on `--online` fetches (`http.js` `MAX_RESPONSE_BYTES`).**
  `fetchBody` now rejects a response whose `Content-Length` declares more than the
  cap and aborts mid-stream once bytes read exceed it, instead of concatenating an
  unbounded body into memory. `mcp-registry.js` shares the same constant and falls
  back to stale cache / empty servers on an over-cap registry response.
- **`site-security` scheme-validates each `sites:` URL.** Every configured site URL
  is parsed with `new URL()` before dispatch; non-`http(s)` schemes (`file://`,
  `ftp://`, `javascript:`, `data:`) are rejected with a
  `site-security/unsupported-scheme` finding and malformed URLs with
  `site-security/invalid-url`, closing a path where a `file://` entry could read
  local disk through the old `startsWith('https')` branch.

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
- **Changelog entries are now one file per change (`changelog.d/`), not shared
  lines in `CHANGELOG.md`.** Every PR appended to the same `### Fixed` list, so
  any two PRs open at once conflicted on the same lines: in a parallel wave the
  second, third and fourth sibling each needed a hand-resolved conflict before
  they could merge. Contributors now add `changelog.d/<id>.<type>.md` and leave
  `CHANGELOG.md` alone — two PRs never touch the same line, so the collision is
  structurally impossible rather than merely easier to resolve. (A
  `.gitattributes` `merge=union` was the obvious fix and was rejected: GitHub
  does not honor `.gitattributes` when it merges a PR, so it would have healed
  the local merge while leaving the PR itself flagged as conflicting.)
  `npm run changelog` previews the next release; `scripts/assemble-changelog.js
  --release <version>` folds the fragments in and reopens `## [Unreleased]`.
- **`--fix --install-packs` now hardens an EXISTING config in place instead of
  skipping it.** The fix path was SKIP-ONLY: a pack whose json/yaml dest already
  existed was reported `skipped (exists)` and left untouched, so `--fix
  --install-packs` could only scaffold files you were missing — to top up a
  config you already had you had to re-run `rigscore init --<pack> --merge` by
  hand. The fixer now threads `merge` into the same additive `config-merge`
  engine `init --merge/--harden` already drives: a missing dest is still
  written, an existing json/yaml config gets the pack's **absent** keys merged
  in (reported `merged`), a value you already set is kept and reported (`kept
  your existing <path>`), and a corrupt or non-mergeable dest (e.g. a `.sh`
  hook) falls back to `skipped (exists)` byte-for-byte. Non-destructive by
  construction — the engine never overwrites one of your values — so no new
  consent is needed beyond the existing `--install-packs` opt-in.

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

- **A present-but-malformed MCP config is disclosed instead of being reported as absent**
  (`mcp-config/config-unparseable`, WARNING). `readJsonSafe` returns `null` for *both* "file
  absent" and "file present but unparseable JSON", and the scan skipped on that alone — so a
  broken `.mcp.json` sitting in the tree produced the INFO finding `No MCP configuration
  found` and a `not-applicable` score, a false statement about a repo whose file is right
  there and whose servers are consequently scanned by nothing and hash-pinned by nothing. An
  absent config still reports `no-config-found` / N/A, exactly as before. Mirrors the existing
  `claude-settings/settings-unparseable` disclosure.

- **skill-files: a truncated skill walk is disclosed instead of being reported as
  "clean".** The walk destructured only `{ files, loopDetected }` from `walkDirSafe`,
  discarding `truncated`/`depthTruncated` — the only one of seven consumers to do so.
  A skill file below the depth cut was therefore never read, and the check still
  emitted `pass: All skill files appear clean`. This is the check that hunts prompt
  injection and exfiltration, so that PASS was a security claim it had not earned. The
  truncation now surfaces as `skill-files/walk-cap-reached` (WARNING), which also
  suppresses the PASS. It fires only when the walk is actually cut short — i.e. under a
  committed `limits.maxWalkDepth` — so default scans are unaffected.

- **memory-hygiene: `limits.maxWalkDepth` is honored, so the remediation it prints is
  true.** `governance-file-cap-reached` told the operator to "raise
  `limits.maxWalkDepth`", but `governancePaths()` took no `config` at all and called
  `walkDirSafe` with no `maxDepth` — the knob was inert and the advice was false. The
  walk now reads the knob, matching sibling `deep-secrets`. Unset behaves exactly as
  before (depth 50, `walkDirSafe`'s own default), so default scan scope is unchanged;
  raising it now actually reaches the governance files past the old cut.

- **The oversize-stream-scan memory test no longer flakes.** It measured process-wide
  RSS against a fixed `0.5 * fileSize` bound — mostly allocator slack and GC timing
  noise, so it sat a hair under its own threshold and failed CI at 32.34 MB vs 31.97 MB
  on a PR touching neither `deep-secrets.js` nor `utils.js`. It now runs `readline` over
  the same fixture as a control arm and asserts the chunk-streaming peak is a fraction of
  it, self-calibrating across platforms and GC modes. The invariant is unchanged and
  still enforced: reintroducing readline drives the ratio to 1.60 against a 0.50 bound.

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
- **The CycloneDX AI-BOM no longer drops `.gemini/settings.json` MCP servers.** The
  exporter kept its own hardcoded 3-file list of repo-level MCP configs
  (`.mcp.json`, `.vscode/mcp.json`, `opencode.json`) while the client registry —
  the source of truth the CVE-2025-54136 rug-pull pin reads — declares **four**.
  A Gemini MCP server was therefore invisible in the shipped BOM (no
  `mcp-server:` component *and* no `file:` component), even though the
  `mcp-config` check and the pin both inventoried it: a supply-chain reviewer
  reading the AI-BOM would not have seen a repo-level agent server that was
  really there. The exporter now reads `repoMcpRelPaths()` instead of restating
  the list, so a client added to the registry is inventoried for free and the
  two surfaces cannot drift apart again.
- **`--deep` secret scanning now covers a bare `.env`, not just the `.env.*`
  family.** `env-exposure` only reads the repository root, so a nested
  `apps/api/.env` — the most common monorepo secret layout, under the most
  common env filename — fell to `deep-secrets`, which skipped it: a bare `.env`
  has no scanned extension and does not start with `.env.` (that needs the
  trailing dot), so it was excluded while its `.env.production` sibling in the
  same folder was caught. A live provider key in a nested bare `.env` therefore
  produced no finding and a passing grade. `deep-secrets` now includes a bare
  `.env` as well; `.envrc` and similar `.env`-prefixed non-env files stay
  excluded.
- **The `--report compliance` output now discloses config/`--ignore`
  suppression, like every other findings surface.** The compliance report is
  the auditor-facing artifact, yet it was the one surface that read only
  `results` and `score` and never `scanResult.suppressed` — so a repo that muted
  a critical `.env`-leak or `/`-scope MCP finding via `.rigscorerc.json` produced
  a compliance report with no trace of the mute, while the terminal, `--json`
  and `--sarif` all disclosed it. `formatCompliance` now emits the same
  `⚠ Suppressed N findings via config/--ignore: …` line the other surfaces use.
  Disclosure only — no scoring or verdict change.
- **`env-exposure` now scans the `env` map of every committed repo-level MCP
  config, not just `.mcp.json`.** A plaintext key in the `env` map of
  `.vscode/mcp.json` was caught by no secret scanner (a total blind spot —
  `.vscode` is also skipped by `deep-secrets`), while the same key in `.mcp.json`
  was a double-CRITICAL; `.gemini/settings.json` and `opencode.json` env secrets
  were missed on the default scan and recoverable only under `--deep`. The
  scanned set is now driven from the client-registry SSOT `repoMcpRelPaths()` —
  the same source #284 wired the CycloneDX BOM to — so a newly registered client
  is covered for free. The registry read lives in a new `repoMcpEnvValues()` in
  `src/clients.js` (which has no `child_process`), keeping raw MCP-server objects
  out of the spawn-capable check and honoring the existing security guard rather
  than weakening it.
- **`--deep` secret scanning no longer reports an unreadable path as "clean".** A
  file or directory the scan could not read (e.g. `chmod 000`) silently vanished
  from the walk, and the result still said `Deep scan clean — N files checked`
  with score 100 — a live key under an unreadable path was invisible, exactly the
  "I stopped looking" rendering as "no secrets" that the file/depth-cap warning
  already guards against. `walkDirSafe` swallowed `readdir`/`lstat` failures with a
  silent `catch{return}` (unlike the caps, which it surfaces), and `deep-secrets`
  swallowed per-file `stat`/`readFile` failures the same way. The walker now sets a
  `readError` signal and `deep-secrets` emits a `deep-secrets/unreadable-skipped`
  warning and suppresses the PASS finding, so a scan that gave up on a path can no
  longer look identical to one that read everything and found nothing.
- A committed, project-level `.cursor/mcp.json` is now scanned by `mcp-config` and covered by the CVE-2025-54136 rug-pull pin (and the CycloneDX AI-BOM / `--verify-state`) — previously Cursor was declared home-only, so a checked-in project config was a scan and pin blind spot, the same class already fixed for `.gemini`/`opencode`. (Windsurf and Cline stay home-only: vendor docs confirm neither has a committed project-level MCP file.)
- **Remediation links no longer 404.** Eleven `learnMore` URLs (and the SARIF
  `helpUri` derived from them) pointed at `headlessmode.com/tools/rigscore/#…`,
  a page the site retired — every "learn more" link in scan output and SARIF
  was a live 404. They now point at the per-check docs that ship with this repo
  (`docs/checks/<check>.md` on GitHub), which are versioned with the code and
  cannot drift the way the site did. A new test enforces that every repo-hosted
  `learnMore` URL resolves to a file that exists.
- **Release workflow no longer stages dead site paths.** `release.yml` staged
  `content/journal/` and `content/tools/rigscore.md` in the headlessmode
  checkout, but the release-post generator writes `content/releases/` and
  `content/tools/` no longer exists — the cross-repo post step would fail. It
  now stages `content/releases/` and `content/docs.md`, matching the site-side
  scripts.
- **CHANGELOG history corrected.** PRs #67–#75 were listed under 0.8.0 but
  landed between v0.8.0 and v0.9.0 (verified against the release tags); their
  entries moved to the 0.9.0 section.
- The `performance` suite's 20-project recursive-scan test no longer flakes under load: its per-test timeout was raised above its own 15s assertion ceiling so the assertion is the real gate.

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
- Corrected an inline `--install-packs` comment that still described the old skip-only behavior after #309 made it merge into an existing config additively.

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
  allowlist-aware; authoring-machine dead-ref count dropped from 143 to 12 (#90).

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
- `instruction-effectiveness` and `skill-coherence` advisory checks (#67).
- Author-agnostic check defaults; author-specific heuristics are opt-in (#69).
- Extended homoglyph coverage (Mathematical, Fullwidth, Cherokee) (#73).
- MCP shape hash-pinning scaffolding (CVE-2025-54136) (#75).

### Changed
- CTA output is now opt-in via `--cta` (#80). `--no-cta` is kept as a
  back-compat alias. Default output is quieter for CI and hooks.
- CI self-scan `--fail-under` tightened from 14 to 30 (#76).
- `skill-files` check scoped to the project (cwd) by default (#74).
- `mcp-config` version-pin check scoped to the package-position argument (#72).

### Fixed
- Broken GitHub Action entry points repaired; self-scan gate made meaningful
  (#68).
- Correctness bugs W3 — issues C3, C5, H2, H4 (#70).

## [0.8.0] - 2026-03-28

### Added
- `infrastructure-security` check (6 pts) — root-owned git hooks, shell guard,
  `chattr` immutability, deny-list, sandbox-gate registration (#64).
- `site-security` advisory check — absorbs HTTP header / PII / JS secret /
  SSL / fingerprinting probes behind `--online`.

### Changed
- Distributed via GitHub only: `npx github:Back-Road-Creative/rigscore`. npm
  publish is intentionally dropped (#62).

### Fixed
- Release workflow consolidated into a single `release.yml`; `NODE_AUTH_TOKEN`
  wiring corrected (#60, #61, #63).

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
