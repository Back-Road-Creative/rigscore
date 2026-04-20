# Changelog

All notable changes to `rigscore` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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
