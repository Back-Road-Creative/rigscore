# mcp-config

**Enforcement grade:** `mechanical` — parses MCP config JSON and compares servers, args, and env keys against deterministic allowlists and known-bad constants. Findings do not depend on prose wording.

## Purpose

Scans every known MCP (Model Context Protocol) configuration file — `.mcp.json`, `.vscode/mcp.json` (servers under VS Code's `servers` key; the `mcpServers` alias is read too), and the per-client variants for Cursor, Cline, Continue, Windsurf, Zed (`~/.config/zed/settings.json`, servers under the `context_servers` key), Amp, Amazon Q Developer (`.amazonq/mcp.json`, `.amazonq/default.json`), Roo Code (`.roo/mcp.json`), Cody (`cody.mcpServers` in `.vscode/settings.json`), JetBrains Junie (`.junie/mcp/mcp.json`), Warp (`.warp/.mcp.json`), Gemini CLI (`.gemini/settings.json`), opencode (`opencode.json`, servers under the `mcp` key), Kiro (`.kiro/settings/mcp.json`), Qwen Code (`.qwen/settings.json`), and Crush (`.crush.json` / `crush.json`, servers under the `mcp` key) — and inspects each declared server for supply-chain risk, excessive capability, inline credentials, and config drift across clients. Maps to OWASP Agentic Top 10 `ASI04` (Agentic Supply Chain). A passing check guarantees: no server has broad filesystem access (`/`, `/home`, `/etc`, etc.), no inline credentials in commands, no unpinned `npx` packages, no typosquat matches against the hand-curated known-server list or the live MCP registry (when `--online`), no cross-client drift for the same server name, no `enableAllProjectMcpServers` bypass, no hash changes between scans (rug-pull detection, CVE-2025-54136 — see "What the pin covers" below), and no `ANTHROPIC_BASE_URL` redirect (CVE-2026-21852).

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
| Repo-level MCP server shape hash changed between scans (CVE-2025-54136 rug-pull) | WARNING | `mcp-config/server-hash-drift` | Review the diff in the config that declares it; to accept, delete the server's entry from `.rigscore-state.json` and re-scan |
| Corrupted `.rigscore-state.json` — the runtime tool pins were recovered from the copy committed at HEAD | INFO | `mcp-config/state-file-corrupted` | None — auto-reset, pins intact; commit the rewritten file |
| Corrupted `.rigscore-state.json` — no committed copy could supply the runtime tool pins, so they are **lost** | WARNING | `mcp-config/state-file-corrupted` | Restore the file from version control, or re-pin: `rigscore mcp-hash \| xargs rigscore mcp-pin <name>`. A scan cannot regenerate runtime tool pins |
| `--no-state-write` suppressed a pin that was due — the repo's MCP servers are now unpinned or partly pinned | WARNING | `mcp-config/state-write-disabled` | Drop `--no-state-write` and commit `.rigscore-state.json`, or accept losing rug-pull detection |
| `--no-state-write` passed but the pin was already current (the write would have been a no-op) | INFO | `mcp-config/state-write-disabled` | None — drift detection is intact |
| Runtime tool pin recorded for server | INFO | `mcp-config/runtime-tool-pin-recorded` | Verify with `rigscore mcp-verify <name>` |
| Runtime tool pin missing for server | INFO | `mcp-config/runtime-tool-pin-missing` | Pin via `rigscore mcp-hash \| rigscore mcp-pin <name>` |
| No MCP config files found | INFO (score = N/A) | `mcp-config/no-config-found` | None — check inapplicable |
| An MCP config file exists but does not parse as JSON — **keeps the check applicable** (an absent file stays a clean N/A) | WARNING | `mcp-config/config-unparseable` | Repair the JSON (or delete the file) — until then its servers are neither scanned nor pinned |
| All servers clean | PASS | — | — |

## Weight rationale

Weight 14 — tied with `coherence` as the highest-weight check. MCP is the primary agentic supply-chain surface for AI dev: a compromised MCP server runs with the agent's full tool budget, has no sandbox of its own, and can re-define tool semantics after approval. The weight is equal to `coherence` because they protect complementary failure modes — `mcp-config` catches the raw misconfiguration; `coherence` catches the governance-vs-reality contradiction — and neither subsumes the other. It is higher than `skill-files` and `governance-docs` (both 10) because supply-chain compromise cannot be recovered from by better governance prose: once a malicious `@modlecontextprotocol/filesystem` typosquat runs with `/` access, the damage is done before any CLAUDE.md rule fires.

## Fix semantics

**Two auto-fixes, `--fix`-able.** Two finding classes are pure, deterministic edits on committed, in-repo config, so `mcp-config.js` exports a `fixes` array with two fixers:

- `mcp-auto-approve-disable` — remediates both `mcp-config/mcp-auto-approve-enabled` and `mcp-config/cve-2025-59536-auto-approve-on-clone` by setting `enableAllProjectMcpServers` to `false` in the project's `.claude/settings.json` (the fix the findings' own remediation prescribes). It is idempotent (a second run is a no-op returning "already applied"), touches only that one key while preserving the rest of the file and its key order, and never creates or clobbers a missing/corrupt settings file. Scope is the project config only — the per-user homedir `.claude/settings.json` is never rewritten.
- `anthropic-base-url-redirect-strip` — remediates `mcp-config/anthropic-base-url-redirect` (CVE-2026-21852) by deleting the redirecting `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` key from the offending server's `env`, dropping the SDK back to the built-in default so API traffic can no longer be silently rerouted through a third party. It scans every committed, project-level MCP config (`repoMcpRelPaths()` — `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, etc.), strips only a key whose value would actually fire the finding (a non-empty, non-allowed host — an `api.anthropic.com` or loopback override is left alone), preserves unrelated servers/keys and their order, and is idempotent (a second run rewrites nothing). Scope is the committed project configs only — per-user homedir configs are never rewritten.

Every other finding this check emits still requires human judgment and has **no** auto-fix:

- Typosquat matches need a human to decide whether the similar name is intentional (e.g. an internal fork).
- Version pinning requires picking the right version.
- Credential exfiltration (inline keys, sensitive env vars) needs secret rotation on top of config cleanup.
- Rug-pull drift requires a git diff review — silently rewriting the state file would defeat the detection.

## The one file a scan writes: `.rigscore-state.json`

Every other check in rigscore is read-only. This one is not: `mcp-config` maintains a
trust-on-first-use pin — a `{server → sha256(command, args, envKeys)}` map — in
`.rigscore-state.json` **at the root of the repo being scanned**. Without it there is no
"between scans" to compare against, so `mcp-config/server-hash-drift` and the
`--verify-state` CI gate simply do not exist. **Commit the file** — a pin that isn't in git
cannot survive a fresh CI checkout, and it deliberately stores hashes only (never env
values), so it is safe to commit. Do **not** gitignore it.

The write only ever *establishes* or *extends* the pin. It is skipped when:

| Situation | Written? | Why |
|---|---|---|
| No state file (first scan) | yes | Creates the TOFU pin. |
| Server added / removed | yes | Extends coverage; no approved pin is destroyed. |
| Corrupt state file | yes | Reset, with an INFO finding. |
| **Nothing changed** | **no** | An identical rewrite would still reformat a hand-committed pin and bump its mtime — a read-only scan must not dirty the tree or the CI checkout it runs in. |
| **Drift detected** | **no** | Re-pinning the changed hash would re-approve the rug-pull the scan just reported: the WARNING would fire once, the next scan would be silent, and `--verify-state` would go green on a compromised repo. The pin is the detection substrate; the detector must not eat it. |

So a drift warning **persists** until a human accepts it. Accepting is deliberate: delete
that server's entry from the `mcpServers` map in `.rigscore-state.json` and re-scan —
rigscore re-pins anything it is not already pinning, and your `rigscore mcp-pin` runtime
tool hashes (the separate `servers` map) survive untouched. Deleting the whole file also
works, but throws those runtime pins away.

### Opting out: `--no-state-write` (and what it costs)

`rigscore --no-state-write .` suppresses the write entirely — for a read-only checkout, a
CI workspace you don't want dirtied, or a repo you don't own. (In-process, the same switch
is `context.writeState === false`, which the test suite uses.)

The opt-out is **never silent**: a repo with MCP servers and no pin is exactly the
unprotected state `--verify-state` exits 2 on, so the run that created it says so. Every
scan carrying the flag emits `mcp-config/state-write-disabled`, and its severity is keyed
on the *same* predicate as the write above — so the disclosure can neither claim a loss the
run didn't take nor hide one it did:

| The flag suppressed… | Finding | Because |
|---|---|---|
| a pin that was **due** (first scan, or a server added) | **WARNING** | Those servers are now unpinned: nothing to compare the next scan against, and `--verify-state` has nothing to verify. The scan checked *less* than a default scan — the score must show it. |
| a write that would have been **skipped anyway** (pin current, or drift already blocking it) | INFO | The run lost nothing; drift detection is intact. Warning here would be crying wolf. |

`--verify-state` is a separate read-only path and is unaffected by the flag — it is the
zero-write way to keep full protection in CI.

State writes are not fixes — they are the detection substrate. There is deliberately **no
`.rigscorerc.json` key** for this: a committed config key would disable rug-pull detection
for everyone who clones the repo, invisibly and permanently, which is the failure mode the
disclosure above exists to prevent. Opting out stays a per-invocation, on-the-record act.

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

It is **read-only** and reuses the same `computeServerHash` / `.rigscore-state.json` machinery the check writes — one hash function, one pin. It never rewrites the state file, runs no other checks, and makes no network calls.

### What the pin covers

**Every committed, repo-level MCP config** — the 15 paths `repoMcpRelPaths()` returns in `src/clients.js`: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.vscode/settings.json` (Cody), `.gemini/settings.json`, `opencode.json`, `.amazonq/mcp.json`, `.amazonq/default.json`, `.roo/mcp.json`, `.junie/mcp/mcp.json`, `.warp/.mcp.json`, `.kiro/settings/mcp.json`, `.qwen/settings.json`, `.crush.json`, and `crush.json`. The scan mints the pin, and the gate verifies it, from the *same* function (`readRepoServers`), so the two can never disagree about scope.

That scope is the threat model: those files ship in the repo, so a pull request can mutate them, which is exactly how a rug-pull lands. `.cursor/mcp.json` earns its place because Cursor reads a committed, project-level config that wins over the global one (cursor.com/docs/mcp); Windsurf and Cline are deliberately absent — both are global-only, with no committed project MCP file to pin. Home-directory client configs — Claude Code's `~/.claude.json` (its top-level `mcpServers` are inventoried; the check reads only the top level, while credential-storage/network-exposure also resolve its per-project `projects[<abs-cwd>].mcpServers`), Claude Desktop, Zed, Amp, and the *global* `~/.cursor/mcp.json` (as opposed to the committed `.cursor/mcp.json` above) — are **not** pinned: they are per-user, are not committed, and no PR can reach them.

Until v2.0.1 only `.mcp.json` was pinned. A repo whose servers lived in any of the other configs got no pin at all, so the gate compared an empty set against an empty pin and printed `PASS: 0 pinned MCP server(s) verified` (exit 0) — a **vacuous pass** over a rug-pulled server. If your repo uses one of those configs, run a scan once to mint the pin and commit `.rigscore-state.json`; until you do, the gate now says `unpinned` (exit 2) rather than passing.

**Duplicate server names.** The pin is a flat `name → hash` map. If two of those configs declare the same server name, the first (in the order above) is pinned under the bare name and each later one under `<name>@<relpath>` — e.g. `db` and `db@opencode.json`. Both are covered, so a rug-pull in the shadowed copy still fails the gate; a first-wins map would have hidden it.

**The gate reads the pin from `HEAD`, not from the working tree** (`git show HEAD:<path>/.rigscore-state.json`), and that is what makes it safe to run after a scan. A pin is evidence only if a human committed and reviewed it. A scan mints a trust-on-first-use pin from whatever `.mcp.json` is *sitting in the working tree* — and the GitHub Action runs a scan before this gate — so an attacker who rewrites `.mcp.json` **and** deletes (or corrupts) the pin in the same PR would otherwise have that scan re-approve their own config, turning a failing gate green. Reading `HEAD` makes that structurally impossible: a working-tree pin `HEAD` does not carry is `uncommitted` (exit 2), never `verified`. The current *`.mcp.json`* is still the one compared — it is the config that would actually run; only the pin's provenance must come from a commit. Outside a git repo there is no commit provenance to read, so the gate falls back to the working-tree pin. Together with the fact that a normal scan never rewrites a *drifted* pin (see "The one file a scan writes" above), the gate reports the same drift whether or not a scan ran first. CI recipe — add one step to `.github/workflows/ci.yml`:

```yaml
- run: npx rigscore --verify-state .   # fails the build on an MCP rug-pull
```

| Exit | Status | Meaning |
|---|---|---|
| `0` | `verified` | Every pinned server still hashes to its pin |
| `0` | `not-applicable` | No repo MCP servers and no pin — nothing to protect |
| `1` | `drift` | A **pinned** server's `{command, args, envKeys}` changed |
| `2` | `unpinned` | A committed MCP config declares servers but nothing is pinned — the gate **cannot** verify |
| `2` | `uncommitted` | A pin exists in the working tree but not at `HEAD` — nobody reviewed it, so it proves nothing |
| `2` | `corrupt` | The committed state file is unreadable / wrong-version — the gate **cannot** verify |

### Why each case decides the way it does

- **No state file (`unpinned`) → exit 2, not 0.** A gate that returns success while verifying nothing teaches you it works when it doesn't — the worst of the three outcomes. Exit 2 is distinct from exit 1 (`drift`) so CI logs tell "you never pinned" apart from "you were rug-pulled". The remedy is one command: run `rigscore .` once and commit `.rigscore-state.json`. A repo with **no** MCP servers at all is genuinely not-applicable and exits 0, so the flag is safe to drop into a shared CI template on day one.
- **Pin present but not committed (`uncommitted`) → exit 2, not 0.** This is the shape a *scan-minted* pin has: `.rigscore-state.json` on disk, absent from `HEAD`. Verifying against it would compare the current `.mcp.json` to a hash taken from that same `.mcp.json` seconds earlier — a tautology that always passes, including on the attacker's config. Distinct from `unpinned` so the CI log tells "you never pinned" apart from "something wrote a pin nobody committed". Remedy: review `.mcp.json`, then `git add .rigscore-state.json && git commit`.
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
- **Non-JSON MCP surfaces.** Each `mcp` / `credentials` entry in the client registry declares
  its on-disk `format` — `json` (the default), `toml` (Codex CLI's `~/.codex/config.toml`,
  servers under `[mcp_servers.<name>]`) or `yaml` (Goose's `~/.config/goose/config.yaml`,
  extensions under `extensions`). One loader, `readMcpConfig()` in `src/clients.js`, dispatches
  on that declaration; TOML is read by the same minimal reader that grades Codex's sandbox
  knobs, and YAML by the `yaml` dependency the project already ships. Registering a non-JSON
  path *without* declaring its format is the bug the seam prevents: every consumer would parse
  it as JSON, get `null`, and emit a false `mcp-config/config-unparseable` about a valid file.
- **Codex's COMMITTED `.codex/config.toml` is scanned and pinned**, alongside the `$HOME` copy.
  Both scopes are registered, so a `[mcp_servers.<name>]` table added or mutated in the
  committed file drifts under `--verify-state` like any other repo-level server, reaches the
  CycloneDX AI-BOM, and has its `env` values scanned for plaintext credentials. This holds
  because every repo-level consumer — `readRepoServers` (`src/state.js`, the pin-minting *and*
  gate path), `src/cyclonedx.js`, and `repoMcpEnvValues` — reads through `readMcpConfig()`,
  which dispatches on the registry's declared `format`. That is what keeps `repoMcpRelPaths()`
  honest: its contract is "exactly the set the CVE-2025-54136 rug-pull pin covers", so a path
  may only be listed there once a format-aware read can actually cover it.
- **Goose's `cmd` is not normalized to `command`.** Goose extensions name their executable
  `cmd` and their environment `envs`. `envs` is declared via the registry's `envKey`, so
  credential scanning is exact; `cmd` has no such hook, so the command-shaped rules
  (`unpinned-npx-package`, `inline-credentials`) do not fire on Goose extensions. Argument- and
  env-shaped rules do.
- **Zed server key — verified 2026-07-12.** Zed stores MCP servers under `context_servers` (not `mcpServers`) in `~/.config/zed/settings.json`, which is the path on **both** Linux and macOS. Local servers use the same `command` / `args` / `env` shape every other client uses; remote servers use `url` + optional `headers`. Zed's project-level `.zed/settings.json` is documented as editor/language options only, so it holds no servers and is not scanned. Sources: <https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md> (rendered at <https://zed.dev/docs/ai/mcp>) and `docs/src/configuring-zed.md`. Windows (`%APPDATA%\Zed\settings.json`) is not yet scanned.

## Known noise modes

Documented false-positive / low-signal modes surfaced during the 2026-04-20 Moat & Ship audit. None currently produce findings that warrant check-code changes; tune via config where listed.

- **`mcp-config/runtime-tool-pin-missing` INFO spam** — fires for every server without a recorded runtime tool-hash. On fresh scans (no `.rigscore-state.json`) every server reports missing. Disable the INFO by setting `.rigscorerc.json` → `mcpConfig.surfaceRuntimeHashStatus: false`. Leave it on once you pin via `rigscore mcp-pin`.
- **Typosquat 1-2 distance collisions on intentional forks** — Levenshtein 1–2 matches trigger on deliberate internal forks (e.g. `@my-org/filesystem` vs. `@modelcontextprotocol/server-filesystem`). The check can't tell intent apart from intent-imitation. Verify the package source, then add the fork name to your curated list via `paths.mcpConfig` (no dedicated allowlist yet).
- **`mcp-config/localhost-server` INFO** — always emitted when stdio isn't used and `url` is `localhost`/`127.0.0.1`. Intentional by design but noisy on local MCP dev setups. Currently not suppressible per-server — filter via the suppress list by findingId: `"mcp-config/localhost-server"`.
- **`mcp-config/cross-client-drift` on intentional per-client overrides** — fires when the same server has different args across Claude Code vs. Cursor vs. Cline. Legitimate when env budgets differ per client. No config knob yet; consider a reasoned suppress entry.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [Model Context Protocol — specification](https://modelcontextprotocol.io/specification) — the config + transport surface this check parses and scopes.
- [CVE-2025-54136 — MCP tool-description rug-pull](https://nvd.nist.gov/vuln/detail/CVE-2025-54136) — the drift-between-scans class the pin/verify workflow defends.
