# credential-storage

**Enforcement grade:** `mechanical` — parses MCP env maps in AI-client configs and compares each value against a structured provider-credential classifier. Deterministic.

## Purpose

Inspects the MCP env maps inside AI-client config files in `~/` — Claude Code (`~/.claude.json`), Claude Desktop, Cursor, Cline, Continue, Windsurf, Amp, Gemini CLI, Zed, opencode — and flags any env value that looks like a literal provider credential rather than a secure reference. The server map and the env map are read per client from the registry (`src/clients.js`), not hardcoded: most clients use `mcpServers[].env`, Zed uses `context_servers[].env`, opencode uses `mcp[].environment`. Claude Code's `~/.claude.json` is special-cased (`mcpServersForConfig`): its servers live in a top-level `mcpServers` (user scope) **and** under `projects[<abs-cwd>].mcpServers` (local scope — the servers it loads for that repo), and both are scanned. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: these config files typically sit at default (user-readable) permissions and any process running as the user, any backup tool, any cloud-sync agent, or any MCP server spawned from the config can read them. A passing check guarantees that every declared env value is either (a) not a `KEY_PATTERNS` match, (b) a 1Password CLI reference (`op://…`), or (c) a shell template placeholder (`${VAR}`) — i.e. the real credential is resolved at runtime. A failure means a plaintext key is sitting at rest in a world-adjacent location.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| A declared env value (`mcpServers[<server>].env[<key>]`, or the client's own keys — Zed `context_servers[].env`, opencode `mcp[].environment`) matches a `KEY_PATTERNS` regex, does not start with `op://`, is not `${VAR}`, and does not match the example/placeholder word list | CRITICAL | `credential-storage/plaintext-credential-in-client-config` | Replace with `op://<vault>/<item>/<field>`, `${VAR}`, or an OS-keychain reference |
| Same as above, but the value contains `example` / `placeholder` / `demo` / `sample` / `template` / `your_key` / `xxx` / `changeme` / `replace_me` | INFO | `credential-storage/example-credential-in-client-config` | Replace the example value before using the config |
| No client config files found in `~/` | INFO (N/A) | `credential-storage/no-client-configs-found` | Check returns `NOT_APPLICABLE` — no score impact |
| Config files present with no plaintext credentials | PASS | — | — |

The trigger list is deliberately short: the check is a pattern scan against `KEY_PATTERNS` (the same ~45 provider regexes used by `env-exposure` and `deep-secrets`), and each regex hit becomes exactly one of the two severity rows above depending on the example-word check.

Both ids are emitted from a **single `findings.push`** whose `findingId` is a ternary on the example-word test (`findingId: isExample ? '…/example-credential-in-client-config' : '…/plaintext-credential-in-client-config'`). A tool that extracts ruleIds by matching a quoted string straight after `findingId:` will find **none** here — it must read every string literal in the `findingId` expression, both branches included.

## Weight rationale

Weight 6 — the lightest of the four `secrets`-category scored checks (tied with `docker-security` / `infrastructure-security` at the same tier). Lower than `env-exposure` (8) because the file set is narrow and user-scoped: a plaintext MCP env var on a developer laptop is a local identity-abuse risk, while a `.env` committed to a shared repo is a multi-party leak. Lower than `deep-secrets` (8) because the search surface is a handful of known config paths (the client registry's `credentials` entries) rather than the whole source tree. Kept above the advisory floor because plaintext credentials in AI-client configs remain a real and under-detected vector — typosquat MCP servers routinely exfiltrate these env blocks at first launch.

## Fix semantics

No auto-fix — the module does not export a `fixes` array. A correct fix requires the human to (1) choose a replacement mechanism (1Password CLI, OS keychain, environment indirection), (2) re-enter the secret through that mechanism, and (3) rotate the currently-exposed value at the provider. `--fix --yes` cannot safely pick among these options or perform the rotation, and blindly rewriting the config would break the MCP server's runtime.

## SARIF

- Tool component: `rigscore`
- Rule IDs: check-level `ruleId` is `credential-storage`; subrule slugs above identify the finding variant.
- Level mapping: CRITICAL → `error`, INFO → `note`, PASS suppressed.
- Location data: the finding title names the client (e.g. `Plaintext credential in Cursor config (filesystem)`). `src/sarif.js` will not recover a filesystem path from this title shape — findings land at the project-root logical location rather than the config file. If cross-reference to the config path is needed, resolve via the client table below.

Client → config path mapping:

| Client | Path (relative to `$HOME`) | Server key | Env key |
|---|---|---|---|
| Claude Code | `.claude.json` | `mcpServers` + `projects[<abs-cwd>].mcpServers` | `env` |
| Claude Desktop | `.claude/claude_desktop_config.json` | `mcpServers` | `env` |
| Cursor | `.cursor/mcp.json` | `mcpServers` | `env` |
| Cline | `.cline/mcp_settings.json` | `mcpServers` | `env` |
| Continue | `.continue/config.json` | `mcpServers` | `env` |
| Windsurf | `.windsurf/mcp.json` | `mcpServers` | `env` |
| Amp | `.amp/mcp.json` | `mcpServers` | `env` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers` | `env` |
| Zed | `.config/zed/settings.json` | `context_servers` | `env` |
| opencode | `.config/opencode/opencode.json` | `mcp` | `environment` |

The table is generated from the client registry (`src/clients.js`) — add a client there, not here.

## Example

```
✗ credential-storage — 0/100 (weight 6)
  CRITICAL Plaintext credential in Claude Desktop config (github)
    env.GITHUB_TOKEN contains a plaintext secret. Credentials in
    config files are stored world-readable.
  INFO Example credential in Cursor config (stripe)
    env.STRIPE_KEY contains an example/placeholder secret pattern.
```

## Scope and limitations

- Scans only the client config paths listed above, all rooted at `~/`. Project-local MCP configs (including Zed's `.zed/settings.json`, which holds editor options only, and repo-level `opencode.json`) are covered by `mcp-config` and `env-exposure`.
- Only the declared **env** map is scanned. A credential inlined into a remote server's `headers` (Zed and opencode both support `headers`) is caught by `mcp-config/inline-credentials`, not here.
- Values starting with `op://` (1Password CLI) and values matching `^${…}$` (shell template) are intentionally excluded — they are secure references, not literal credentials. Note that `KEY_PATTERNS` still matches `op://…` for other checks, so the same string can be flagged by `env-exposure` in a public config while passing here.
- Detection is regex-based against `KEY_PATTERNS`; secrets that do not match any provider-specific pattern (custom internal tokens, short API keys) are invisible to this check.
- `NOT_APPLICABLE` when no client config file exists — the absence of MCP clients is not a scoring signal.

## Known noise modes

Documented false-positive / low-signal modes surfaced during the 2026-04-20 Moat & Ship audit.

- **`op://` references with a path that pattern-matches a plaintext shape** — the check correctly excludes values starting with `op://`, but if an operator writes `"GITHUB_TOKEN": "see op://secrets/github/token"` (with free-form prefix) the regex may match the provider pattern against the suffix. Workaround: keep the value strictly `op://...`; don't embed it in prose.
- **Example-file-passthrough** — users who copy `.env.example` into a real MCP client config verbatim keep `xxx`/`changeme` placeholders; these correctly downgrade to INFO (`credential-storage/example-credential-in-client-config`). If you're seeing many example-credential INFOs, the config was never filled in — remove or replace the server entry.
- **N/A on headless / CI workspaces** — when `~/.cursor/mcp.json` etc. don't exist (fresh container, CI runner), the check returns N/A and contributes nothing to score. Expected, but can surprise users who assume "no findings" = "passed".
- **Path-mapping lookup requires the docs table** — SARIF `physicalLocation` does NOT resolve the per-client config path automatically (finding titles name the client, not the file). Until `src/sarif.js` gains an explicit `locations[]` emit from this check, SARIF consumers must cross-reference the client→path table above manually. Tracked as backlog 3.4.
