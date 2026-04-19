# env-exposure

## Purpose

Catches the single most common credential-leak vector in AI dev repos: `.env` files that are not gitignored, templates that got filled with real secrets, GCP service-account JSON dropped into the project root, API keys hardcoded into AI-client config files, and secrets echoed into shell history. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: an agent that reads config files as part of normal operation will propagate any leaked key downstream (MCP server env, subprocess env, SARIF artifact). A passing check guarantees that `.env` files are ignored and `chmod 600`, template files contain only placeholders, and no AI-client config file has a literal provider key.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.env` or `.env.*` (non-`.example`) file present but not listed in `.gitignore` | CRITICAL | `env-exposure/env-not-gitignored` | Add `.env` to `.gitignore` (auto-fixable) |
| Line in an AI config file (`CLAUDE.md`, `.cursorrules`, `.mcp.json`, `config.json`, `settings.py`, etc.) matches a `KEY_PATTERNS` regex outside a comment and not a placeholder | CRITICAL | `env-exposure/hardcoded-api-key` | Move the secret to `.env`; rotate the credential |
| GCP dual-field (`"type": "service_account"` + `"private_key"`) found in any scanned AI config file | CRITICAL | `env-exposure/gcp-service-account` | Delete the key file; use workload identity |
| `.env` file is world-readable (mode bit `0o004` set) — POSIX only | WARNING | `env-exposure/env-world-readable` | `chmod 600 <file>` (auto-fixable) |
| `.env.example` / `.env.sample` / `.env.template` contains a real CRITICAL-severity secret match | WARNING | `env-exposure/real-secret-in-template` | Replace the real value with `your_key_here` |
| Recent shell history (`~/.bash_history` or `~/.zsh_history`, last 500 lines) contains CRITICAL-severity secret matches | WARNING | `env-exposure/secret-in-shell-history` | Edit the history file or `history -c`; rotate the leaked credential |
| Secret-pattern hit in a comment line in an AI config file | INFO | `env-exposure/api-key-in-comment` | Verify the commented value is not a real key |
| Secret-pattern hit that looks like a placeholder (`example`, `your_key`, `xxx`, `changeme`, …) | INFO | `env-exposure/placeholder-api-key` | Confirm the value is a placeholder, not a real key |
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

## Scope and limitations

- Scans project root only for `.env` / `.env.*` files (no recursion) — deeper trees are covered by `deep-secrets` under `--deep`.
- Config-file list is `AI_CONFIG_FILES` (governance files + `.claude/settings.json`, `.mcp.json`, `config.{js,ts,json}`, `secrets.{yaml,json}`, `credentials.json`, `application.yml`, `settings.{py,js}`).
- Per-file "worst finding wins" — a single config file contributes at most one finding, with CRITICAL outranking INFO so a trailing hardcoded key is not shadowed by an earlier commented match.
- Gitignore parser recognizes dangerous negation (`!.env`) and un-ignore-safe negation (`!.env.example|sample|template`).
- Shell-history scan caps at 3 hits and reads only the last 500 lines; full history forensics is out of scope.
- POSIX permission check short-circuits on Windows with a SKIPPED finding.
