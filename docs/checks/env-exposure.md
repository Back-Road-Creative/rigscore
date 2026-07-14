# env-exposure

**Enforcement grade:** `mechanical` — file-existence + structural `.gitignore` inspection + parsed env-file key checks. Determined by filesystem state, not prose.

## Purpose

Catches the single most common credential-leak vector in AI dev repos: `.env` files that are not gitignored, templates that got filled with real secrets, GCP service-account JSON dropped into the project root, API keys hardcoded into AI-client config files, and secrets echoed into shell history. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: an agent that reads config files as part of normal operation will propagate any leaked key downstream (MCP server env, subprocess env, SARIF artifact). A passing check guarantees that `.env` files are ignored and `chmod 600`, template files contain only placeholders, and no AI-client config file has a literal provider key.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.env` or `.env.*` (non-`.example`) file present but not listed in `.gitignore` | CRITICAL | `env-exposure/env-not-gitignored` | Add `.env` to `.gitignore` (auto-fixable) |
| Line in an AI config file (`CLAUDE.md`, `.cursorrules`, `.mcp.json`, `config.json`, `settings.py`, etc.) matches a `KEY_PATTERNS` regex outside a comment and not a placeholder | CRITICAL | `env-exposure/hardcoded-api-key` | Move the secret to `.env`; rotate the credential |
| A secret in the `env` map of an MCP server in **any** committed repo-level MCP config (`.vscode/mcp.json`, `.gemini/settings.json`, `opencode.json`, … — the full set from the client registry) matches a `KEY_PATTERNS` regex | CRITICAL | `env-exposure/hardcoded-api-key` | Move the secret to `.env`; rotate the credential |
| GCP dual-field (`"type": "service_account"` + `"private_key"`) found in any scanned AI config file | CRITICAL | `env-exposure/gcp-service-account-key` | Delete the key file; use workload identity |
| `.env` file is world-readable (mode bit `0o004` set) — POSIX only | WARNING | `env-exposure/env-world-readable` | `chmod 600 <file>` (auto-fixable) |
| `.env.example` / `.env.sample` / `.env.template` contains a real CRITICAL-severity secret match | WARNING | `env-exposure/real-secret-in-template` | Replace the real value with `your_key_here` |
| Recent shell history (`~/.bash_history` or `~/.zsh_history`, last 500 lines) contains CRITICAL-severity secret matches | WARNING | `env-exposure/shell-history-secrets` | Edit the history file or `history -c`; rotate the leaked credential |
| Secret-pattern hit in a comment line in an AI config file | INFO | `env-exposure/api-key-in-comment` | Verify the commented value is not a real key |
| Secret-pattern hit that looks like a placeholder (`example`, `your_key`, `xxx`, `changeme`, …) | INFO | `env-exposure/api-key-example-placeholder` | Confirm the value is a placeholder, not a real key |
| `.env` permission check skipped (Windows) | SKIPPED | — | Verify permissions manually with `icacls` |
| `.sops.yaml` present — secrets managed by SOPS | PASS | — | — |
| No `.env`, no hardcoded keys, no SOPS config | PASS | — | — |

## Weight rationale

Weight 8 — tied with `claude-settings` and `deep-secrets`. Higher than `docker-security` (6) because `.env` leaks are historically the single most common credential-exposure vector in AI dev repos and agents read config/skill files as part of normal operation, so the blast radius compounds. Lower than `claude-md` (10) because moat-first scoring reserves top weights for AI-specific governance primitives rather than hygiene checks that overlap with generic secret scanners.

## Fix semantics

The module exports two fixes via `export const fixes`. Both are idempotent and touch only hygiene files (never governance content):

- `env-not-gitignored` — appends the literal line `.env` to `.gitignore` (creates the file if absent), only if `.env` is not already present line-matched. Matches findings whose title contains both `.env` and `.gitignore`.
- `env-world-readable` — iterates `.env` and `.env.*` entries in the project root; for any file with the world-read bit set (`mode & 0o004`), runs `chmod 600`. No-op on Windows (`process.platform === 'win32'` early-returns).

Out of scope for `--fix --yes`: removing hardcoded keys from config files, redacting shell history, deleting GCP service-account JSONs, and rewriting template files — each requires a human decision about replacement value and rotation timing.

## SARIF

- Tool component: `rigscore`
- Rule IDs: check-level `ruleId` is `env-exposure`; subrule slugs above identify the finding variant.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, SKIPPED/PASS suppressed.
- Location data: file path is extracted from the finding title (`in <file>`, or leading `<file> is ...`). No line numbers for config-file matches — the scanner records worst-per-file rather than per-line.

## Example

```
✗ env-exposure — 0/100 (weight 8)
  CRITICAL .env file found but NOT in .gitignore
    Your API keys and secrets will be committed to version control.
  WARNING .env is world-readable
    .env has mode 644. Secrets files should not be world-readable.
  WARNING Real secret found in .env.example
    Template file .env.example contains what appears to be a real
    secret, not a placeholder.
  INFO API key pattern in comment in config.js
```

## How it works

- For each `.env` / `.env.*` file in the project root, the check shells out to `git check-ignore --quiet --no-index <file>` and treats exit `0` as "ignored", `1` as "not ignored". `--no-index` is required so the verdict reflects gitignore patterns even when a `.env` has been mistakenly committed to the index. This delegates the matching to git itself, which means path-prefixed entries (`apps/backend/.env`), `**/.env`, and parent-directory `.gitignore` chains all work correctly in monorepos.
- When `cwd` is not inside a git working tree (exit code `128`, or git is not installed), the check falls back to a legacy exact-string match against a known set of `.env` patterns in the local `.gitignore`. This keeps non-git inputs (unpacked tarballs, `npx` against a downloaded release) usable.
- Before either path runs, the local `.gitignore` is scanned for dangerous negation lines that un-ignore a real `.env`-family file: `!.env`, `!.env.local`, or a path-prefixed `!config/.env` — where `.env` is an anchored path token (start of the basename), not a bare substring. The un-ignore-safe `!.env.example|sample|template` lines are excluded, and unrelated lines that merely contain the letters `env` (`!venv/keep.txt`, `!environment/`, `!.eslintrc.env-notes`) are correctly ignored. A dangerous negation always wins and the file is reported as not-ignored regardless of what git says.

## Scope and limitations

- Scans project root only for `.env` / `.env.*` files (no recursion) — deeper trees are covered by `deep-secrets` under `--deep`.
- Config-file list is `AI_CONFIG_FILES` (governance files + `.claude/settings.json`, `.mcp.json`, `config.{js,ts,json}`, `secrets.{yaml,json}`, `credentials.json`, `application.yml`, `settings.{py,js}`), scanned line-by-line for hardcoded keys.
- On top of that raw scan, the `env` maps of **every** committed repo-level MCP config are scanned for secrets — the scanned set is driven from the client registry (`repoMcpRelPaths()` in `src/clients.js`, via `repoMcpEnvValues()`), the same SSOT the CycloneDX AI-BOM and the rug-pull pin read. This covers `.vscode/mcp.json` (servers under `servers`), `.gemini/settings.json`, and `opencode.json` (servers under `mcp`, env under `environment`) on the default (non-`--deep`) path, and a client added to the registry is covered for free. Configs already in `AI_CONFIG_FILES` (`.mcp.json`) are skipped here to avoid double-reporting.
- Per-file "worst finding wins" — a single config file contributes at most one finding, with CRITICAL outranking INFO so a trailing hardcoded key is not shadowed by an earlier commented match.
- Gitignore detection uses `git check-ignore --no-index` and recognizes dangerous negation (`!.env`) and un-ignore-safe negation (`!.env.example|sample|template`). When git is unavailable the check falls back to an exact-string match against a small set of `.env` patterns and may miss path-prefixed entries (`apps/backend/.env`).
- Shell-history scan caps at 3 hits and reads only the last 500 lines; full history forensics is out of scope.
- POSIX permission check short-circuits on Windows with a SKIPPED finding.
