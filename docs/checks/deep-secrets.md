# deep-secrets

## Purpose

Recursively walks the project tree looking for hardcoded credentials in source files — beyond the root-level config files that `env-exposure` and `credential-storage` already cover. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: a leaked provider key in source is a direct identity-takeover vector for any agent or human who reads the repo. A passing check guarantees that within the files scanned, no line matches the ~40 provider-specific secret patterns in `KEY_PATTERNS` and no file looks like a GCP service-account JSON. A failure usually means a key was committed during prototyping and never rotated — treat any CRITICAL here as an active credential leak and rotate before remediating the commit.

Gated behind `--deep`. The check returns `NOT_APPLICABLE` when the flag is absent so default-mode scans stay fast and predictable.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.json` file contains `"type": "service_account"` and `"private_key"` (GCP dual-field) | CRITICAL | `deep-secrets/gcp-service-account` | Delete the key file; use workload identity or env-based auth |
| Line matches a `KEY_PATTERNS` regex and is neither a comment nor a placeholder | CRITICAL | `deep-secrets/hardcoded-secret` | Move the secret to `.env` or a secrets manager and rotate it |
| Line matches a `KEY_PATTERNS` regex but sits in a comment or resembles an example/placeholder | INFO | `deep-secrets/possible-secret-comment` | Verify the value is not a real key; remove or clearly mark as placeholder |
| File walker reached the configured cap (`deepScan.maxFiles`, default 1000) | INFO | `deep-secrets/scan-cap-reached` | Raise `deepScan.maxFiles` in `.rigscorerc.json` or narrow the scan root |
| No source files matched the include list | INFO | `deep-secrets/no-source-files` | Informational — returns `NOT_APPLICABLE` |
| Scan completed with zero matches | PASS | — | — |
| `--deep` not set | N/A | — | Check returns `NOT_APPLICABLE` without walking files |

## Weight rationale

Weight 8 — tied with `claude-settings` and `env-exposure`. Lower than `claude-md` (10) because the check is opt-in (`--deep`) and would unfairly dominate scores of every repo that hasn't passed the flag; higher than `credential-storage` (6) because the search surface is the entire source tree rather than a known set of AI-client config files, and the false-negative cost of a missed key here (production credential committed to a public repo) is catastrophically higher than a plaintext MCP env var on a developer laptop.

## Fix semantics

No auto-fix — the module does not export a `fixes` array. Every CRITICAL here requires the human to: (1) rotate the leaked credential at the provider, (2) decide whether the file should be git-removed vs. rewritten, (3) choose a replacement mechanism (env var, secrets manager, runtime fetch). None of these are safe for a local scanner to automate, and deleting source lines with `--fix --yes` could silently strand code that references the removed literal.

## SARIF

- Tool component: `rigscore`
- Rule IDs: check-level `ruleId` is `deep-secrets`; subrule slugs above identify the finding variant.
- Level mapping: CRITICAL → `error`, INFO → `note`, PASS / SKIPPED suppressed.
- Location data: file path is `<relpath>:<line>` — `src/sarif.js` extracts the path from the finding title; the line number is carried in the title text.

## Example

```
✗ deep-secrets — 0/100 (weight 8)
  CRITICAL GCP service account key in infra/sa.json
    File contains both "type": "service_account" and "private_key".
  CRITICAL Hardcoded secret in scripts/deploy.js:42
    Pattern: sk-ant-[a-zA-Z0-9_-]{10,...
  INFO Possible secret (comment/example) in README.md:118
    Pattern: AKIA[0-9A-Z]{16}...
```

## Scope and limitations

- Included extensions: `.js .ts .jsx .tsx .py .go .rb .java .yaml .yml .json .toml .sh`, plus any file whose name starts with `.env.` (e.g. `.env.production`).
- Skipped directories: `node_modules`, `.git`, `vendor`, `dist`, `build`, `__pycache__`, `venv`, `.venv`, `coverage`, `.next`, `.nuxt`, `out`, and any dotfile-named directory.
- Skipped files: anything matching `.test.` or `.spec.` — test fixtures legitimately contain example keys.
- At most one line-level finding per file (walker `break`s after the first match) to keep output actionable. The GCP-JSON detector short-circuits line scanning for that file.
- File cap defaults to 1000 (`config.deepScan.maxFiles`). Once reached, an INFO finding is emitted and walking stops.
