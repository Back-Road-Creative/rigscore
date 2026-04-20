# mcp-config

## Purpose

Scans every known MCP (Model Context Protocol) configuration file — `.mcp.json`, `.vscode/mcp.json`, and the per-client variants for Cursor, Cline, Continue, Windsurf, Zed, and Amp — and inspects each declared server for supply-chain risk, excessive capability, inline credentials, and config drift across clients. Maps to OWASP Agentic Top 10 `ASI04` (Agentic Supply Chain). A passing check guarantees: no server has broad filesystem access (`/`, `/home`, `/etc`, etc.), no inline credentials in commands, no unpinned `npx` packages, no typosquat matches against the hand-curated known-server list or the live MCP registry (when `--online`), no cross-client drift for the same server name, no `enableAllProjectMcpServers` bypass, no hash changes between scans (rug-pull detection, CVE-2025-54136), and no `ANTHROPIC_BASE_URL` redirect (CVE-2026-21852).

A failure typically means an MCP server was added without reviewing its args, a hosted server was pasted from a blog post without pinning the version, or a settings bypass was committed alongside `.mcp.json` — the CVE-2025-59536 compound case where anyone who clones the repo auto-approves every server on first run.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `process.env` wildcard passthrough in config file | WARNING | `mcp-config/env-wildcard` | Pass only specific env vars each server needs |
| Server uses SSE/HTTP transport to non-localhost host | WARNING | `mcp-config/network-transport` | Prefer stdio; if network required, require auth + TLS |
| Server uses SSE/HTTP transport to localhost | INFO | `mcp-config/localhost-transport` | None — informational |
| Server args include sensitive root path (`/`, `/home`, `/etc`, `/root`, `/var`, `/opt`, `/usr`) | CRITICAL | `mcp-config/broad-filesystem` | Scope filesystem access to project directory |
| Server args contain `../` path traversal | WARNING | `mcp-config/path-traversal` | Use absolute paths scoped to project |
| Server args include unsafe permission flag (`--allow-all`, `--no-sandbox`, `--dangerously-skip-permissions`, etc.) | WARNING | `mcp-config/unsafe-flags` | Use granular permission flags |
| Server env passes 3+ sensitive credentials | CRITICAL | `mcp-config/env-sensitive-many` | Pass only what the server needs |
| Server env passes 1-2 sensitive credentials | WARNING | `mcp-config/env-sensitive-few` | Verify server needs these credentials |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` redirected in server env (CVE-2026-21852) | CRITICAL | `mcp-config/anthropic-base-url-redirect` | Remove or set to `https://api.anthropic.com` |
| Server arg uses unstable version tag (`@latest`, `@next`, `@dev`, `@canary`, etc.) | WARNING | `mcp-config/unpinned-tag` | Pin to specific version |
| `npx` command with no version pin on package-position arg | WARNING | `mcp-config/npx-unpinned` | `npx package@1.0.0` |
| Inline API key / token detected in command or args | CRITICAL | `mcp-config/inline-credentials` | Move credentials to env vars |
| Package name is Levenshtein distance 1-2 from known MCP server (curated list) | WARNING | `mcp-config/typosquat-curated` | Verify package name |
| Package name typosquats live MCP registry entry (requires `--online`) | CRITICAL | `mcp-config/typosquat-registry` | Verify package name against `registry.modelcontextprotocol.io` |
| Package not found on npm (requires `--online`) | CRITICAL | `mcp-config/npm-missing` | Verify package name and source |
| Package created less than 30 days ago (requires `--online`) | WARNING | `mcp-config/npm-new-package` | Review source and maintainer |
| MCP registry fetch failed or stale (requires `--online`) | INFO | `mcp-config/registry-status` | None — advisory |
| `enableAllProjectMcpServers: true` in `.claude/settings.json` | CRITICAL | `mcp-config/auto-approve` | Remove or set to false |
| Dangerous command (`curl`, `wget`, `rm -rf`, `eval`, `base64 -d`, `nc`, `/dev/tcp`, `python -c`, `node -e`) in settings hook | CRITICAL | `mcp-config/dangerous-hook` | Remove dangerous hook commands |
| Repo `.mcp.json` + `enableAllProjectMcpServers: true` (CVE-2025-59536 compound) | CRITICAL | `mcp-config/cve-2025-59536` | Set `enableAllProjectMcpServers` to false |
| Same server name has divergent args/env/transport across clients | WARNING | `mcp-config/cross-client-drift` | Align configs across all AI clients |
| Server only configured in one of multiple detected clients | INFO | `mcp-config/client-partial` | None — informational |
| Repo-level MCP server shape hash changed between scans (CVE-2025-54136 rug-pull) | WARNING | `mcp-config/mcpoison-drift` | Review diff in `.mcp.json`; re-run to acknowledge |
| Corrupted `.rigscore-state.json` | INFO | `mcp-config/state-corrupt` | Auto-reset; no action needed |
| Runtime tool pin recorded for server | INFO | `mcp-config/runtime-pin-present` | Verify with `rigscore mcp-verify <name>` |
| Runtime tool pin missing for server | INFO | `mcp-config/runtime-pin-missing` | Pin via `rigscore mcp-hash \| rigscore mcp-pin <name>` |
| No MCP config files found | INFO (score = N/A) | — | None — check inapplicable |
| All servers clean | PASS | — | — |

## Weight rationale

Weight 14 — tied with `coherence` as the highest-weight check. MCP is the primary agentic supply-chain surface for AI dev: a compromised MCP server runs with the agent's full tool budget, has no sandbox of its own, and can re-define tool semantics after approval. The weight is equal to `coherence` because they protect complementary failure modes — `mcp-config` catches the raw misconfiguration; `coherence` catches the governance-vs-reality contradiction — and neither subsumes the other. It is higher than `skill-files` and `claude-md` (both 10) because supply-chain compromise cannot be recovered from by better governance prose: once a malicious `@modlecontextprotocol/filesystem` typosquat runs with `/` access, the damage is done before any CLAUDE.md rule fires.

## Fix semantics

No auto-fix. The `mcp-config.js` module does not export a `fixes` array. Every finding this check emits requires human judgment:

- Typosquat matches need a human to decide whether the similar name is intentional (e.g. an internal fork).
- Version pinning requires picking the right version.
- Credential exfiltration (inline keys, sensitive env vars) needs secret rotation on top of config cleanup.
- CVE-2025-59536 and CVE-2026-21852 findings require reviewing whether the `.mcp.json` was planted versus legitimately committed.
- Rug-pull drift requires a git diff review — silently rewriting the state file would defeat the detection.

State writes (`.rigscore-state.json`) are not fixes — they are the detection substrate and happen on every run unless `context.writeState === false`.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: see Triggers — all prefixed `mcp-config/`.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → omitted.
- OWASP tag: `owasp-agentic:ASI04` attached to every finding via `properties.tags`.
- Location: when a finding text contains a config path (e.g. `Found in .mcp.json`), the SARIF `physicalLocation.artifactLocation.uri` is set to that path; otherwise the finding attaches only the logical `supply-chain` module location.

## Example

```
✗ mcp-config — 0/100 (weight 14)
  CRITICAL MCP server "filesystem" has broad filesystem access: /home
    Server can access sensitive path(s). Found in .mcp.json.
    → Scope filesystem access to your project directory only.
  CRITICAL CVE-2025-59536: repo MCP servers auto-approved on clone
    .mcp.json + enableAllProjectMcpServers: true — anyone cloning auto-approves.
    → Set enableAllProjectMcpServers to false.
  WARNING MCP server "brave-search" uses unpinned npx package
    npx without a version pin (e.g. @1.0.0) runs whatever version is latest.
    → Pin the package version: npx package@1.0.0
  INFO    MCP server "filesystem": runtime tool pin not recorded
    → Run: npx -y <pkg> | rigscore mcp-hash | xargs rigscore mcp-pin filesystem
```

## Scope and limitations

- Online checks (`checkNpmRegistry`, `fetchRegistry`) run only when `--online` is passed. Default is zero network calls.
- Typosquat detection uses Levenshtein distance 1-2 against `KNOWN_MCP_SERVERS` (~52 entries in `src/known-mcp-servers.js`) offline, augmented by the MCP registry when online.
- Cross-client drift requires 2+ detected clients. A project that uses only Claude Code will never emit drift findings.
- Rug-pull detection requires at least one prior scan to have written `.rigscore-state.json`. First scan records hashes silently.
- Runtime tool pin status is opt-out via `.rigscorerc.json` key `mcpConfig.surfaceRuntimeHashStatus: false`.
- Additional config paths can be registered via `.rigscorerc.json` key `paths.mcpConfig`.

## Known noise modes

Documented false-positive / low-signal modes surfaced during the 2026-04-20 Moat & Ship audit. None currently produce findings that warrant check-code changes; tune via config where listed.

- **`mcp-config/runtime-pin-missing` INFO spam** — fires for every server without a recorded runtime tool-hash. On fresh scans (no `.rigscore-state.json`) every server reports missing. Disable the INFO by setting `.rigscorerc.json` → `mcpConfig.surfaceRuntimeHashStatus: false`. Leave it on once you pin via `rigscore mcp-pin`.
- **Typosquat 1-2 distance collisions on intentional forks** — Levenshtein 1–2 matches trigger on deliberate internal forks (e.g. `@my-org/filesystem` vs. `@modelcontextprotocol/server-filesystem`). The check can't tell intent apart from intent-imitation. Verify the package source, then add the fork name to your curated list via `paths.mcpConfig` (no dedicated allowlist yet).
- **`mcp-config/localhost-transport` INFO** — always emitted when stdio isn't used and `url` is `localhost`/`127.0.0.1`. Intentional by design but noisy on local MCP dev setups. Currently not suppressible per-server — filter via the suppress list by findingId: `"mcp-config/localhost-transport"`.
- **`mcp-config/cross-client-drift` on intentional per-client overrides** — fires when the same server has different args across Claude Code vs. Cursor vs. Cline. Legitimate when env budgets differ per client. No config knob yet; consider a reasoned suppress entry.
