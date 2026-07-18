# deep-secrets

**Enforcement grade:** `pattern` — regex signatures for ~45 provider credential shapes matched across scanned files. Catches canonical key formats; novel / obfuscated encodings can evade.

## Purpose

Recursively walks the project tree looking for hardcoded credentials in source files — beyond the root-level config files that `env-exposure` and `credential-storage` already cover. Maps to **OWASP Agentic Top 10 ASI03 — Identity & Privilege Abuse**: a leaked provider key in source is a direct identity-takeover vector for any agent or human who reads the repo. A passing check guarantees that within the files scanned, no line matches the ~45 provider-specific secret patterns in `KEY_PATTERNS` and no file looks like a GCP service-account JSON. A failure usually means a key was committed during prototyping and never rotated — treat any CRITICAL here as an active credential leak and rotate before remediating the commit.

Gated behind `--deep`. The check returns `NOT_APPLICABLE` when the flag is absent so default-mode scans stay fast and predictable.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `.json` file contains `"type": "service_account"` and `"private_key"` (GCP dual-field) | CRITICAL | `deep-secrets/gcp-service-account-key` | Delete the key file; use workload identity or env-based auth |
| Line matches a `KEY_PATTERNS` regex and is neither a comment nor a placeholder | CRITICAL | `deep-secrets/hardcoded-secret` | Move the secret to `.env` or a secrets manager and rotate it |
| Line matches a `KEY_PATTERNS` regex but sits in a comment or resembles an example/placeholder | INFO | `deep-secrets/possible-secret-comment` | Verify the value is not a real key; remove or clearly mark as placeholder |
| File walker stopped early — it reached the configured file cap (`deepScan.maxFiles`, default 1000) or the depth cap (`limits.maxWalkDepth`), so files past it were never scanned and the result cannot be read as "no secrets". Suppresses the PASS finding | WARNING | `deep-secrets/file-cap-reached` | Raise `deepScan.maxFiles` or `limits.maxWalkDepth` in `.rigscorerc.json`, or narrow the scan root |
| A directory or file could not be read (e.g. permission denied / `chmod 000`) and was never scanned, so the result cannot be read as "no secrets". Suppresses the PASS finding | WARNING | `deep-secrets/unreadable-skipped` | Grant read access to the affected paths, or exclude them via `deepScan.excludeDirs` if intentionally out of scope, then re-run |
| One or more files exceeded `limits.maxFileBytes` and were read via bounded-memory streaming (not skipped) | INFO | `deep-secrets/oversize-skipped` | Informational — large files are still scanned for secrets; the id is retained for SARIF contract stability |
| The walker detected a symlink cycle and skipped it | INFO | `deep-secrets/symlink-loop-skipped` | Informational — traversal continued safely |
| No source files matched the include list | INFO | `deep-secrets/no-source-files` | Informational — returns `NOT_APPLICABLE` |
| Scan completed with zero matches | PASS | — | — |
| `--deep` not set | N/A | — | Check returns `NOT_APPLICABLE` without walking files |

## Weight rationale

Weight 8 — tied with `claude-settings` and `env-exposure`. Lower than `governance-docs` (10) because the check is opt-in (`--deep`) and would unfairly dominate scores of every repo that hasn't passed the flag; higher than `credential-storage` (6) because the search surface is the entire source tree rather than a known set of AI-client config files, and the false-negative cost of a missed key here (production credential committed to a public repo) is catastrophically higher than a plaintext MCP env var on a developer laptop.

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
    Pattern: \bsk-ant-[a-zA-Z0-9_-]{10,}\b...
  INFO Possible secret (comment/example) in README.md:118
    Pattern: \bAKIA[0-9A-Z]{16}\b...
```

All `KEY_PATTERNS` entries are anchored with `\b` word boundaries (or
URL-shaped lead-ins) and carry length quantifiers cross-checked against
vendor docs and canonical specimens. The anchors prevent substring matches
inside JWTs, base64 blobs, and identifiers — e.g. an `AKIA…` substring in
a JWT payload no longer triggers a CRITICAL.

## Scope and limitations

- Included extensions: `.js .ts .jsx .tsx .py .go .rb .java .yaml .yml .json .toml .sh`, plus a bare `.env` and any file whose name starts with `.env.` (e.g. `.env.production`).
- Skipped directories: `node_modules`, `.git`, `vendor`, `dist`, `build`, `__pycache__`, `venv`, `.venv`, `coverage`, `.next`, `.nuxt`, `out`, `.rigscore-action-src` (the GitHub Action's own vendored checkout, so `--deep` never scans rigscore's source as the caller's), and the rest of the machine-generated dotfolders in `SKIP_DIRS`.
- Skipped files: anything matching `.test.` or `.spec.` — test fixtures legitimately contain example keys.
- At most one line-level finding per file to keep output actionable. The walker tracks the highest severity seen across the file: an INFO match (comment / example / placeholder) does **not** stop scanning — if a CRITICAL match appears later in the same file the critical one is reported and the info is dropped, so a leading `// Old key: …` comment cannot silently downgrade a real hardcoded secret a few lines below. The walker exits early once a CRITICAL is recorded. The GCP-JSON detector short-circuits line scanning for that file entirely.
- File cap defaults to 1000 (`config.deepScan.maxFiles`). Once reached, an INFO finding is emitted and walking stops.
- Per-file size cap defaults to 512 KB (`config.limits.maxFileBytes`). Files above it are **not** skipped — they are read via fixed-size chunk streaming with an overlap window, so a secret in a large or minified (single-line) file is still detected with memory bounded by chunk + overlap, never the file size. The `deep-secrets/oversize-skipped` id (retained for contract stability) now reports how many large files were stream-scanned. Because every candidate file is read, the PASS "clean" finding is truthful by construction.
- **Provider breadth vs. false-positive discipline.** `KEY_PATTERNS` covers the GitHub token family (classic `ghp_`/`gho_`, user/server/refresh `ghu_`/`ghs_`/`ghr_`, and fine-grained `github_pat_`), OpenAI (current `sk-proj-`/`sk-svcacct-` and legacy `sk-` + 48), Google OAuth client secrets (`GOCSPX-`), Shopify app tokens (`shpat_`/`shpss_`/`shppa_`/`shpca_`), Databricks (`dapi`), and the rest of the providers enumerated in the README. Every pattern is `\b`-anchored and length-bounded so it does not fire on benign lookalikes — a noisy scanner is worse than a narrow one. Formats whose only structure is a bare UUID (e.g. Postmark server tokens) are **deliberately excluded**: a tight UUID pattern would flag every unrelated GUID in the tree, so they are left to entropy-based scanners rather than added as a low-signal regex.
- **Handoff for deeper scans.** This check is a pattern scan of the working tree at rest — it does not scan git history, decode base64/entropy blobs, or verify a matched key against its provider. For those, run a dedicated deep scanner such as [trufflehog](https://github.com/trufflesecurity/trufflehog) or [gitleaks](https://github.com/gitleaks/gitleaks) alongside rigscore; rigscore intentionally does not shell out to them.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [CWE-798 — Use of Hard-coded Credentials](https://cwe.mitre.org/data/definitions/798.html) — the weakness the entropy + provider-prefix patterns detect in source.
