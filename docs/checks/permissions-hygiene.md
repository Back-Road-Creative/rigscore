# permissions-hygiene

## Purpose

Verifies POSIX file-permission invariants for identity material and governance files: `~/.ssh` is `700`, SSH private keys (`id_*` excluding `*.pub`) are `600`, sensitive files in the project (`*.pem`, `*.key`, `*credentials*`) are not world-readable, and governance files (`AI_CONFIG_FILES` from `src/constants.js`) have consistent ownership. Maps to **OWASP Agentic ASI03 — Identity & Privilege Abuse**: an agent running under the developer's uid inherits any permission the filesystem grants — a `644` private key or a `credentials.json` readable by `others` is exfiltrable by any process the agent spawns, and mixed ownership across governance files is a classic signal of unauthorized modification. A pass guarantees all scanned paths have tight, consistent POSIX modes and uniform ownership. A failure means at least one identity or secret artifact is more reachable than it should be.

This check is **POSIX-only**. On Windows it emits a single `SKIPPED` finding and contributes nothing to the score.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Running on `win32` | SKIPPED | `permissions-hygiene/file-permission-checks-skipped-on-windows` | Verify manually via `icacls` |
| `~/.ssh` mode ≠ `700` | WARNING | `permissions-hygiene/ssh-directory-permissions-too-open` | `chmod 700 ~/.ssh` |
| SSH private key `~/.ssh/id_*` (not `*.pub`) mode ≠ `600` | CRITICAL | `permissions-hygiene/ssh-private-key-entry-permissions-too-open` | `chmod 600 ~/.ssh/<key>` |
| File in cwd matching `*.pem` / `*.key` / `*credentials*` has world-read bit set | WARNING | `permissions-hygiene/sensitive-file-entry-is-world-readable` | `chmod 600 <file>` |
| File in cwd subdirectory (depth 2, excluding `node_modules`/`.git`/dotdirs) ending in `.pem` / `.key` has world-read bit set | WARNING | `permissions-hygiene/sensitive-file-dir-entry-is-world-readable` | `chmod 600 <dir>/<file>` |
| Governance files (`AI_CONFIG_FILES`) have more than one distinct owning uid | WARNING | `permissions-hygiene/governance-files-have-mixed-file-ownership` | Reunify ownership under the intended user |
| No issues found on POSIX | PASS | — | — |

## Weight rationale

**Weight 4 — 4 points.** Tied with `unicode-steganography` (4). Both sit in tier-3 hygiene. The tie is deliberate: permissions-hygiene is a *high-frequency, low-per-incident* signal (lots of dev machines have mode drift, but most of it isn't actively exploited), while `unicode-steganography` is *low-frequency, high-per-incident* (rare but a single hit is bad). Equal 4-point budget balances those. Higher than `git-hooks` (2) because a world-readable SSH key is a direct credential leak primitive — bad state, not just bad process. Lower than `credential-storage` (6) because this check only inspects mode bits, not the contents or storage backend. Lower than `docker-security` / `infrastructure-security` (6) because a mode-bit failure is recoverable with one `chmod`; container-escape or missing host guards are not.

## Fix semantics

`--fix --yes` applies up to **three** fixes from the `fixes` array exported by `src/checks/permissions-hygiene.js`. Each is gated by a `match` predicate against the finding title/severity and is a no-op on Windows.

- `ssh-dir-permissions` → when matching finding severity is `warning` and title contains `.ssh` + `permission`, runs `chmod 700 ~/.ssh`. Mutates: mode of `~/.ssh` only.
- `ssh-key-permissions` → when matching finding severity is `critical` and title contains `SSH` + `key` + `permission`, walks `~/.ssh`, and for every entry starting with `id_` but not ending in `.pub` whose mode has any group/other bits set (`mode & 0o077`), runs `chmod 600` on it. Mutates: mode of each affected private key file.
- `gitignore-sensitive-patterns` → when matching finding severity is `warning`, title contains `world-readable` and (`.pem` or `.key`), appends `*.pem` and/or `*.key` to the project's `.gitignore` if not already present. Mutates: `<cwd>/.gitignore` only; creates it if absent. Does **not** change file modes or run `git rm --cached` — those stay manual.
- Out of scope: chmoding files outside `~/.ssh` (e.g. project `*.pem`), changing governance file ownership, anything on Windows.

## SARIF

- Tool component: `rigscore`.
- Rule IDs: emitted as `ruleId: "permissions-hygiene"`; finer-grained slugs (`<id>/<slug>`) are the `findingId` used by `--ignore` and shown in terminal output.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → suppressed.
- Location: logical location `process` module; physical location is extracted by `src/sarif.js` when the finding title/detail embeds a recognisable filename (e.g. `id_rsa`, `my-key.pem`).
- Tags: `owasp-agentic:ASI03`, `category:process`.

## Example

```
permissions-hygiene ................. 66/100  (weight 4)
  CRITICAL  SSH private key id_rsa permissions too open
            id_rsa has mode 644, expected 600.
            → Run: chmod 600 ~/.ssh/id_rsa
  WARNING   ~/.ssh directory permissions too open
            ~/.ssh has mode 755, expected 700.
            → Run: chmod 700 ~/.ssh
  WARNING   Sensitive file deploy.pem is world-readable
            deploy.pem has mode 644. Sensitive files should not be world-readable.
            → Run: chmod 600 deploy.pem
  WARNING   Governance files have mixed file ownership
            Found 2 different UIDs across governance files. This may indicate unauthorized modifications.
```

## Scope and limitations

- Platform gate: POSIX only. On Windows a single `skipped` finding is emitted and the check returns without doing any mode checks.
- Project-scope sensitive-file scan walks `cwd` plus one directory level deep, skipping `node_modules`, `.git`, and any dotdir. `.pem`/`.key` are scanned at depth 2; `*credentials*` only at depth 1 (by design — the subdirectory sweep is intentionally narrower).
- Glob matching is a hand-rolled matcher that only understands `*.ext`, `*foo*`, and exact matches (sufficient for the current `SENSITIVE_PATTERNS`). Adding `?` or `**` patterns would require swapping in `minimatch`.
- Ownership-consistency check only flags > 1 distinct uid across the `AI_CONFIG_FILES` set; it does not tell you which file is the outlier.
- No network, no deep file content reading — purely `stat(2)` and `readdir(2)`.
