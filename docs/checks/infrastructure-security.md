# infrastructure-security

## Purpose

Validates host-level backstops that sit underneath a single project: a root-owned global git-hooks directory, a git wrapper that strips `--no-verify` and blocks force-push, a shell safety guard, immutable governance directories, a deny-list in Claude Code `settings.json`, and a registered sandbox gate. Maps to **OWASP Agentic ASI02 — Tool Misuse**: when per-project hooks are missing or bypassed, an agent with shell access can still run dangerous commands; infrastructure-level guards are the enforcement layer of last resort. A pass guarantees that the configured hooks directory, wrapper, safety gates, immutable directories, deny-list, and sandbox gate are in place and properly owned. A failure typically means an agent could bypass project hooks (`git commit --no-verify`), force-push to main, or run `rm -rf /`-style commands without intervention.

This check is **opt-in**. By default it returns `SKIPPED` / N/A. You enable it by configuring at least one of `paths.hooksDir`, `paths.gitWrapper`, `paths.safetyGates`, or `paths.immutableDirs` in `.rigscorerc.json`. It is additionally Linux-only — returns N/A on macOS and Windows even when configured.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `process.platform !== 'linux'` | SKIPPED | — | N/A on macOS/Windows |
| No infrastructure paths configured in `.rigscorerc.json` | SKIPPED | — | Configure `paths.hooksDir`/`gitWrapper`/`safetyGates`/`immutableDirs` to enable |
| `paths.hooksDir` configured but directory missing | CRITICAL | `infrastructure-security/global-git-hooks-directory-missing` | Create the directory root-owned with required hooks |
| `paths.hooksDir` exists but not owned by root (uid 0) | CRITICAL | `infrastructure-security/global-git-hooks-directory-not-root-owned` | `sudo chown root:root <hooksDir>` |
| Required hook `pre-commit`/`pre-push`/`commit-msg` missing inside `hooksDir` | CRITICAL | `infrastructure-security/required-git-hook-missing-hook` | Create it as a root-owned executable |
| Required hook exists but lacks owner-execute bit | WARNING | `infrastructure-security/git-hook-not-executable-hook` | `sudo chmod 755 <path>` |
| Required hook present and executable | PASS | — | — |
| `paths.gitWrapper` configured but missing | CRITICAL | `infrastructure-security/git-safety-wrapper-missing` | Install a wrapper that strips `--no-verify` and blocks force-push |
| Git wrapper exists but not root-owned | WARNING | `infrastructure-security/git-wrapper-not-root-owned` | `sudo chown root:root <wrapper>` |
| Git wrapper content does **not** reference `no-verify` | WARNING | `infrastructure-security/git-wrapper-does-not-strip-no-verify` | Make the wrapper strip `--no-verify` |
| Git wrapper references `no-verify` | PASS | — | — |
| `paths.safetyGates` configured and present | PASS | — | — |
| `paths.safetyGates` configured but file missing | INFO | `infrastructure-security/shell-safety-guard-missing` | Create safety guard with wrappers for dangerous ops |
| `paths.immutableDirs` entry has chattr `+i` set | PASS | — | — |
| `paths.immutableDirs` entry missing `+i` flag | WARNING | `infrastructure-security/immutable-flag-not-set-basename` | `sudo chattr -R +i <dir>` |
| `paths.immutableDirs` entry unreachable or `lsattr` unavailable | INFO | `infrastructure-security/cannot-check-immutability-basename` | Install e2fsprogs; verify directory exists |
| No `permissions.deny` list found in any `settings.json` | WARNING | `infrastructure-security/no-deny-list-found-in-settings-json` | Add `permissions.deny` to Claude settings |
| Deny list missing one or more required patterns (`git push --force`, `git reset --hard`, `rm -rf`, `git push origin main`, `git push origin master`) | WARNING | `infrastructure-security/deny-list-missing-n-required-pattern-s` | Add missing patterns |
| Deny list contains all required patterns | PASS | — | — |
| `sandbox-gate` registered in `settings.json` hooks | PASS | — | — |
| `sandbox-gate` not registered | WARNING | `infrastructure-security/sandbox-gate-not-registered` | Register `sandbox-gate.py` as a `PreToolUse` hook |

## Weight rationale

**Weight 6 — 6 points.** Tied with `docker-security` (6) and `credential-storage` (6). Lower than `claude-settings` (8) because infrastructure controls are inherently opt-in (Linux-only, path-configured) and returning N/A for most users means a higher weight would under-score installs that simply don't have an enterprise stack. Higher than `permissions-hygiene` (4) because when these controls *are* configured and drift, the failure blast radius (no hook enforcement, no deny-list) covers the whole host, not just one file's mode bits. The 6-point cap matches `docker-security` since both are "isolation/enforcement layer gone" signals.

## Fix semantics

**No auto-fix.** This check exports no `fixes` array. Every remediation requires `sudo` and changes files outside the project tree (`/opt/git-hooks/`, `/usr/local/bin/git`, `/etc/`, etc.), which is explicitly out of scope for `--fix --yes`:

- Out of scope: creating or chowning root-owned files (requires privilege escalation).
- Out of scope: modifying `~/.claude/settings.json` — `--fix` never touches governance content.
- Out of scope: running `chattr +i` or installing wrapper binaries.

Use the exact commands emitted in each finding's `remediation` field manually.

## SARIF

- Tool component: `rigscore`.
- Rule IDs: emitted as `ruleId: "infrastructure-security"` on the SARIF result; granular finding slugs (`<id>/<slug>`) live in the terminal output and `--ignore` matching, not in SARIF.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → suppressed.
- Location: logical location `process` module; no physical location unless the finding title embeds a path recognizable by `src/sarif.js`'s extractor.
- Tags: `owasp-agentic:ASI02`, `category:process`.

## Example

Minimal `.rigscorerc.json` that enables the check:

```json
{
  "paths": {
    "hooksDir": "/opt/git-hooks",
    "gitWrapper": "/usr/local/bin/git",
    "safetyGates": "/etc/profile.d/safety-guard.sh",
    "immutableDirs": ["/opt/governance", "/etc/claude"]
  }
}
```

Terminal output:

```
infrastructure-security ............. 40/100  (weight 6)
  CRITICAL  Global git hooks directory missing
            Expected root-owned hooks at /opt/git-hooks
            → Create /opt/git-hooks owned by root with pre-commit, pre-push, and commit-msg hooks.
  CRITICAL  Required git hook missing: pre-commit
  WARNING   Immutable flag not set: governance
            /opt/governance should have chattr +i to prevent unauthorized modification.
  WARNING   Sandbox gate not registered
            sandbox-gate.py should be registered as a PreToolUse hook for Write/Edit/Bash protection.
  PASS      Deny list contains all required patterns
```

## Scope and limitations

- Platform gate: Linux only (`process.platform === 'linux'`). macOS and Windows receive a `skipped` finding regardless of configuration.
- Opt-in gate: if none of `paths.hooksDir`, `paths.gitWrapper`, `paths.safetyGates`, `paths.immutableDirs` is configured, the check is `SKIPPED` and does not contribute to the score.
- Root-ownership checks compare `stat.uid === 0` only; they do not verify GID or ACLs.
- Deny-list match is substring on the joined list — order-independent but not regex-aware.
- Sandbox gate detection is a naive substring search for `sandbox-gate` in the JSON-serialized `hooks` block of `settings.json` / `settings.local.json`; renaming the gate defeats detection.
- `lsattr` unavailability is treated as INFO, not a failure, so containers without e2fsprogs don't false-positive.
