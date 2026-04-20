# Changelog

All notable changes to `rigscore` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cross-platform CI matrix (`ubuntu-latest` + `macos-latest`). Windows native is
  out of scope; WSL is expected to work via the Linux runner.
- Draft `Dockerfile` and `.github/workflows/docker-publish.yml` for a future
  `ghcr.io/back-road-creative/rigscore` image. The workflow is gated to
  `workflow_dispatch` only — no auto-publish on tags until the user flips the
  trigger.
- `rigscore init --example` scaffolds a demo project with intentional issues for
  CI smoke tests and documentation. Builds on the `rigscore init` base
  subcommand.
- `CHANGELOG.md` (this file).
- README section documenting the deliberate npm-off posture and the
  `npx github:Back-Road-Creative/rigscore` path.

### Notes
- **npm publish remains off.** See `CLAUDE.md` and the README "Distribution"
  section. Distribution is GitHub-only via
  `npx github:Back-Road-Creative/rigscore`.

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
