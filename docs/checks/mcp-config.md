# mcp-config

**Enforcement grade:** `mechanical` — parses MCP config JSON and compares servers, args, and env keys against deterministic allowlists and known-bad constants. Findings do not depend on prose wording.

## Purpose

Scans every known MCP (Model Context Protocol) configuration file — `.mcp.json`, `.vscode/mcp.json`, and the per-client variants for Cursor, Cline, Continue, Windsurf, Zed (`~/.config/zed/settings.json`, servers under the `context_servers` key), Amp, Gemini CLI (`.gemini/settings.json`), and opencode (`opencode.json`, servers under the `mcp` key) — and inspects each declared server for supply-chain risk, excessive capability, inline credentials, and config drift across clients. Maps to OWASP Agentic Top 10 `ASI04` (Agentic Supply Chain). A passing check guarantees: no server has broad filesystem access (`/`, `/home`, `/etc`, etc.), no inline credentials in commands, no unpinned `npx` packages, no typosquat matches against the hand-curated known-server list or the live MCP registry (when `--online`), no cross-client drift for the same server name, no `enableAllProjectMcpServers` bypass, no hash changes between scans (rug-pull detection, CVE-2025-54136), and no `ANTHROPIC_BASE_URL` redirect (CVE-2026-21852).

A failure typically means an MCP server was added without reviewing its args, a hosted server was pasted from a blog post without pinning the version, or a settings bypass was committed alongside `.mcp.json` — the CVE-2025-59536 compound case where anyone who clones the repo auto-approves every server on first run.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `process.env` wildcard passthrough in config file | WARNING | `mcp-config/env-wildcard-passthrough` | Pass only specific env vars each server needs |
| Server uses SSE/HTTP transport to non-localhost host | WARNING | `mcp-config/network-transport` | Prefer stdio; if network required, require auth + TLS |
| Server uses SSE/HTTP transport to localhost | INFO | `mcp-config/localhost-server` | None — informational |
| Server args include sensitive root path (`/`, `/home`, `/etc`, `/root`, `/var`, `/opt`, `/usr`) | CRITICAL | `mcp-config/broad-filesystem-access` | Scope filesystem access to project directory |
| Server args contain `../` path traversal | WARNING | `mcp-config/relative-path-traversal` | Use absolute paths scoped to project |
| Server args include unsafe permission flag (`--allow-all`, `--no-sandbox`, `--dangerously-skip-permissions`, etc.) | WARNING | `mcp-config/unsafe-permission-flag` | Use granular permission flags |
| Server env passes 3+ sensitive credentials | CRITICAL | `mcp-config/env-wildcard-sensitive-vars` | Pass only what the server needs |
| Server env passes 1-2 sensitive credentials | WARNING | `mcp-config/env-sensitive-vars` | Verify server needs these credentials |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` redirected in server env (CVE-2026-21852) | CRITICAL | `mcp-config/anthropic-base-url-redirect` | Remove or set to `https://api.anthropic.com` |
| Server arg uses unstable version tag (`@latest`, `@next`, `@dev`, `@canary`, etc.) | WARNING | `mcp-config/unpinned-unstable-tag` | Pin to specific version |
| `npx` command with no version pin on package-position arg | WARNING | `mcp-config/unpinned-npx-package` | `npx package@1.0.0` |
| Inline API key / token detected in command, args, or a remote server's `headers` | CRITICAL | `mcp-config/inline-credentials` | Move credentials to env vars |
| Package name is Levenshtein distance 1-2 from known MCP server (curated list) | WARNING | `mcp-config/typosquat-curated` | Verify package name |
| Package name typosquats live MCP registry entry (requires `--online`) | CRITICAL | `mcp-config/typosquat-registry` | Verify package name against `registry.modelcontextprotocol.io` |
| Package not found on npm (requires `--online`) | CRITICAL | `mcp-config/npm-package-not-found` | Verify package name and source |
| Package created less than 30 days ago (requires `--online`) | WARNING | `mcp-config/npm-package-very-new` | Review source and maintainer |
| MCP registry fetch failed or stale (requires `--online`) | INFO | `mcp-config/registry-fallback` | None — advisory |
| `enableAllProjectMcpServers: true` in `.claude/settings.json` | CRITICAL | `mcp-config/mcp-auto-approve-enabled` | Remove or set to false |
| Dangerous command (`curl`, `wget`, `rm -rf`, `eval`, `base64 -d`, `nc`, `/dev/tcp`, `python -c`, `node -e`) in settings hook | CRITICAL | `mcp-config/dangerous-hook-command` | Remove dangerous hook commands |
| Repo `.mcp.json` + `enableAllProjectMcpServers: true` (CVE-2025-59536 compound) | CRITICAL | `mcp-config/cve-2025-59536-auto-approve-on-clone` | Set `enableAllProjectMcpServers` to false |
| Same server name has divergent args/env/transport across clients | WARNING | `mcp-config/cross-client-drift` | Align configs across all AI clients |
| Server only configured in one of multiple detected clients | INFO | `mcp-config/single-client-server` | None — informational |
| Repo-level MCP server shape hash changed between scans (CVE-2025-54136 rug-pull) | WARNING | `mcp-config/server-hash-drift` | Review diff in `.mcp.json`; re-run to acknowledge |
| Corrupted `.rigscore-state.json` | INFO | `mcp-config/state-file-corrupted` | Auto-reset; no action needed |
| Runtime tool pin recorded for server | INFO | `mcp-config/runtime-tool-pin-recorded` | Verify with `rigscore mcp-verify <name>` |
| Runtime tool pin missing for server | INFO | `mcp-config/runtime-tool-pin-missing` | Pin via `rigscore mcp-hash \| rigscore mcp-pin <name>` |
| No MCP config files found | INFO (score = N/A) | `mcp-config/no-config-found` | None — check inapplicable |
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

## CI gate: `rigscore --verify-state`

The `mcp-config/server-hash-drift` finding above is a WARNING — it cannot fail a build, and a supply-chain guard a compromised repo can print a warning past is not a guard. `--verify-state` turns the same pin into an exit code.

It is **read-only** and reuses the same `computeServerHash` / `.rigscore-state.json` machinery the check writes — one hash function, one pin. It never rewrites the state file (a normal scan does, which would erase the drift), runs no other checks, and makes no network calls. CI recipe — add one step to `.github/workflows/ci.yml`:

```yaml
- run: npx rigscore --verify-state .   # fails the build on an MCP rug-pull
```

| Exit | Status | Meaning |
|---|---|---|
| `0` | `verified` | Every pinned server still hashes to its pin |
| `0` | `not-applicable` | No repo MCP servers and no pin — nothing to protect |
| `1` | `drift` | A **pinned** server's `{command, args, envKeys}` changed |
| `2` | `unpinned` / `corrupt` | Nothing pinned, or the state file is unreadable/wrong-version — the gate **cannot** verify |

### Why each case decides the way it does

- **No state file (`unpinned`) → exit 2, not 0.** A gate that returns success while verifying nothing teaches you it works when it doesn't — the worst of the three outcomes. Exit 2 is distinct from exit 1 (`drift`) so CI logs tell "you never pinned" apart from "you were rug-pulled". The remedy is one command: run `rigscore .` once and commit `.rigscore-state.json`. A repo with **no** MCP servers at all is genuinely not-applicable and exits 0, so the flag is safe to drop into a shared CI template on day one.
- **Server added → reported, exit 0.** Adding a server is not the MCPoison threat model. MCPoison (CVE-2025-54136) works by mutating a server the host has *already approved*, so the stale approval carries the new payload silently. A brand-new server name gets a fresh approval prompt from the host and shows up as a new block in the `.mcp.json` diff — code review and the other `mcp-config` triggers (typosquat, unpinned npx, sensitive env, broad filesystem) are the controls for it. Failing here would also red-CI every legitimate "add an MCP server" PR. The report names it as `ADDED` and tells you to re-pin so it becomes covered.
- **Server removed → reported, exit 0.** A server that is no longer in `.mcp.json` cannot execute; its shape did not "change", it is gone. This is a stale pin, not a security event. Reported as `REMOVED`.
- **Rename** (`old` gone, `new` appears) therefore reads as one `REMOVED` + one `ADDED`, both exit 0 — correct, because the renamed server re-prompts for approval rather than inheriting the old one's.

The report prints the pinned hash, the current hash, and the **current** shape. The old shape is deliberately *not* recoverable: the pin stores only a SHA-256, because `.rigscore-state.json` is committed to git. Diff `.mcp.json` against version control to see what the previous shape was.

## Scope and limitations

- Online checks (`checkNpmRegistry`, `fetchRegistry`) run only when `--online` is passed. Default is zero network calls.
- Typosquat detection uses Levenshtein distance 1-2 against `KNOWN_MCP_SERVERS` (~52 entries in `src/known-mcp-servers.js`) offline, augmented by the MCP registry when online.
- Cross-client drift requires 2+ detected clients. A project that uses only Claude Code will never emit drift findings.
- Rug-pull detection requires at least one prior scan to have written `.rigscore-state.json`. First scan records hashes silently.
- Runtime tool pin status is opt-out via `.rigscorerc.json` key `mcpConfig.surfaceRuntimeHashStatus: false`.
- Additional config paths can be registered via `.rigscorerc.json` key `paths.mcpConfig`.
- **Zed server key — verified 2026-07-12.** Zed stores MCP servers under `context_servers` (not `mcpServers`) in `~/.config/zed/settings.json`, which is the path on **both** Linux and macOS. Local servers use the same `command` / `args` / `env` shape every other client uses; remote servers use `url` + optional `headers`. Zed's project-level `.zed/settings.json` is documented as editor/language options only, so it holds no servers and is not scanned. Sources: <https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md> (rendered at <https://zed.dev/docs/ai/mcp>) and `docs/src/configuring-zed.md`. Windows (`%APPDATA%\Zed\settings.json`) is not yet scanned.

## Known noise modes

Documented false-positive / low-signal modes surfaced during the 2026-04-20 Moat & Ship audit. None currently produce findings that warrant check-code changes; tune via config where listed.

- **`mcp-config/runtime-tool-pin-missing` INFO spam** — fires for every server without a recorded runtime tool-hash. On fresh scans (no `.rigscore-state.json`) every server reports missing. Disable the INFO by setting `.rigscorerc.json` → `mcpConfig.surfaceRuntimeHashStatus: false`. Leave it on once you pin via `rigscore mcp-pin`.
- **Typosquat 1-2 distance collisions on intentional forks** — Levenshtein 1–2 matches trigger on deliberate internal forks (e.g. `@my-org/filesystem` vs. `@modelcontextprotocol/server-filesystem`). The check can't tell intent apart from intent-imitation. Verify the package source, then add the fork name to your curated list via `paths.mcpConfig` (no dedicated allowlist yet).
- **`mcp-config/localhost-server` INFO** — always emitted when stdio isn't used and `url` is `localhost`/`127.0.0.1`. Intentional by design but noisy on local MCP dev setups. Currently not suppressible per-server — filter via the suppress list by findingId: `"mcp-config/localhost-server"`.
- **`mcp-config/cross-client-drift` on intentional per-client overrides** — fires when the same server has different args across Claude Code vs. Cursor vs. Cline. Legitimate when env budgets differ per client. No config knob yet; consider a reasoned suppress entry.
