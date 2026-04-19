# credential-storage

## Purpose

Inspects the `mcpServers[].env` maps inside AI-client config files in `~/` — Claude Desktop, Cursor, Cline, Continue, Windsurf, Amp — and flags any env value that looks like a literal provider credential rather than a secure reference. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: these config files typically sit at default (user-readable) permissions and any process running as the user, any backup tool, any cloud-sync agent, or any MCP server spawned from the config can read them. A passing check guarantees that every `mcpServers[*].env[*]` value is either (a) not a `KEY_PATTERNS` match, (b) a 1Password CLI reference (`op://…`), or (c) a shell template placeholder (`${VAR}`) — i.e. the real credential is resolved at runtime. A failure means a plaintext key is sitting at rest in a world-adjacent location.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `mcpServers[<server>].env[<key>]` value matches a `KEY_PATTERNS` regex, does not start with `op://`, is not `${VAR}`, and does not match the example/placeholder word list | CRITICAL | `credential-storage/plaintext-credential` | Replace with `op://<vault>/<item>/<field>`, `${VAR}`, or an OS-keychain reference |
| Same as above, but the value contains `example` / `placeholder` / `demo` / `sample` / `template` / `your_key` / `xxx` / `changeme` / `replace_me` | INFO | `credential-storage/example-credential` | Replace the example value before using the config |
| No client config files found in `~/` | N/A | — | Check returns `NOT_APPLICABLE` — no score impact |
| Config files present with no plaintext credentials | PASS | — | — |

The trigger list is deliberately short: the check is a pattern scan against `KEY_PATTERNS` (the same ~40 provider regexes used by `env-exposure` and `deep-secrets`), and each regex hit becomes exactly one of the two severity rows above depending on the example-word check.

## Weight rationale

Weight 6 — the lightest of the four `secrets`-category scored checks (tied with `docker-security` / `infrastructure-security` at the same tier). Lower than `env-exposure` (8) because the file set is narrow and user-scoped: a plaintext MCP env var on a developer laptop is a local identity-abuse risk, while a `.env` committed to a shared repo is a multi-party leak. Lower than `deep-secrets` (8) because the search surface is six known config paths rather than the whole source tree. Kept above the advisory floor because plaintext credentials in AI-client configs remain a real and under-detected vector — typosquat MCP servers routinely exfiltrate these env blocks at first launch.

## Fix semantics

No auto-fix — the module does not export a `fixes` array. A correct fix requires the human to (1) choose a replacement mechanism (1Password CLI, OS keychain, environment indirection), (2) re-enter the secret through that mechanism, and (3) rotate the currently-exposed value at the provider. `--fix --yes` cannot safely pick among these options or perform the rotation, and blindly rewriting the config would break the MCP server's runtime.

## SARIF

- Tool component: `rigscore`
- Rule IDs: check-level `ruleId` is `credential-storage`; subrule slugs above identify the finding variant.
- Level mapping: CRITICAL → `error`, INFO → `note`, PASS suppressed.
- Location data: the finding title names the client (e.g. `Plaintext credential in Cursor config (filesystem)`). `src/sarif.js` will not recover a filesystem path from this title shape — findings land at the project-root logical location rather than the config file. If cross-reference to the config path is needed, resolve via the client table below.

Client → config path mapping:

| Client | Path (relative to `$HOME`) |
|---|---|
| Claude Desktop | `.claude/claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| Cline | `.cline/mcp_settings.json` |
| Continue | `.continue/config.json` |
| Windsurf | `.windsurf/mcp.json` |
| Amp | `.amp/mcp.json` |

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

- Scans only the six client config paths listed above, all rooted at `~/`. Project-local MCP configs are covered by `mcp-config` and `env-exposure`.
- Values starting with `op://` (1Password CLI) and values matching `^${…}$` (shell template) are intentionally excluded — they are secure references, not literal credentials. Note that `KEY_PATTERNS` still matches `op://…` for other checks, so the same string can be flagged by `env-exposure` in a public config while passing here.
- Detection is regex-based against `KEY_PATTERNS`; secrets that do not match any provider-specific pattern (custom internal tokens, short API keys) are invisible to this check.
- `NOT_APPLICABLE` when no client config file exists — the absence of MCP clients is not a scoring signal.
