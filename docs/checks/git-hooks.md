# git-hooks

## Purpose

Verifies that a git repository has **substantive** commit-time enforcement in place: a validated native `pre-commit` / `pre-push` hook, a recognised hook manager (Husky, lefthook), a `package.json` dev-dep on Husky/lint-staged, Claude Code hooks configured in `settings.json`, a `pushurl = no_push` guard in `.git/config`, or an external hook directory listed in `.rigscorerc.json` → `paths.hookDirs`. Native hooks are additionally validated for emptiness, executable bit, no-op content (only `exit 0`, `echo`, etc.), and lack of substantive patterns (lint, test, secret-scan, exit-1). The check also emits a warning when none of the detected hooks contains a known secret-scanning tool (`gitleaks`, `trufflehog`, `detect-secrets`). Maps to **OWASP Agentic ASI02 — Tool Misuse**: without commit-time gates, an agent with `git commit` authority can push secrets, broken governance files, or force-push rewrites with zero local friction. A pass guarantees at least one real hook surface is installed and validated. A failure means commits will leave the machine unchecked.

Returns N/A when the project is not a git repository (no `.git` directory).

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| No `.git` directory in `cwd` | INFO | `git-hooks/not-a-git-repository` | N/A — check returns N/A |
| `.git/hooks/pre-commit` exists but is empty | WARNING | `git-hooks/pre-commit-hook-is-empty` | Add meaningful checks |
| `.git/hooks/pre-commit` exists but is not executable (POSIX) | INFO | `git-hooks/pre-commit-hook-is-not-executable` | `chmod +x .git/hooks/pre-commit` |
| `.git/hooks/pre-commit` only runs trivial commands (`exit 0`, `:`, `true`, `echo`, `printf`, `sleep`, `ls`, etc.) | WARNING | `git-hooks/pre-commit-hook-is-a-no-op` | Add meaningful checks |
| `.git/hooks/pre-commit` has content but no recognised substantive pattern (lint/test/scan/`exit 1`/`if…then`) | INFO | `git-hooks/pre-commit-hook-may-lack-substance` | Verify the hook performs real checks |
| `.git/hooks/pre-commit` validated | PASS | — | — |
| Same emptiness / non-executable / no-op / low-substance / pass findings for `.git/hooks/pre-push` | WARNING / INFO / WARNING / INFO / PASS | `git-hooks/pre-push-hook-…` | As above |
| `.husky/` directory present | PASS | — | — |
| `lefthook.yml` or `lefthook.yaml` present | PASS | — | — |
| `package.json` has `husky` or `lint-staged` dependency (and no `.husky/`) | PASS | — | — |
| Claude Code `hooks` block in `~/.claude/settings.json` or `<cwd>/.claude/settings.json` | PASS | — | — |
| `pushurl = no_push` regex match in `.git/config` | PASS | — | — |
| External hook directory from `config.paths.hookDirs` exists | PASS | — | — |
| None of the above detected | WARNING | `git-hooks/no-pre-commit-hooks-installed` | Install Husky or lefthook |
| Hooks present but none contains `gitleaks` / `trufflehog` / `detect-secrets` (native or husky pre-commit only) | WARNING | `git-hooks/pre-commit-hooks-lack-secret-scanning` | Add a secret-scan step |

## Weight rationale

**Weight 2 — 2 points.** Lowest scored weight in the check set. The README's section for this check does not justify the 2-point weight (it reads as process guidance, not a weight defence), so this is the authoritative reasoning:

- Git hooks are **local, bypassable enforcement**. `git commit --no-verify` skips them entirely; a server-side gate (rigscore CI, GitHub ruleset, infrastructure-security's wrapper) is the real enforcement layer. Penalising a missing local hook the same as a missing secret scan or CLAUDE.md would double-count a signal whose actual protection value is low.
- This check is **detection-oriented and shallow**. It accepts a `package.json` dependency on `husky` as a PASS without verifying the hook actually runs; it substring-matches three secret scanners by name. Real substance is enforced upstream by `deep-secrets` (8 points) and `env-exposure` (8 points), not here.
- **Redundancy with `infrastructure-security` (6).** The infra check already covers root-owned global hooks — the tier where enforcement can't be bypassed. Giving this check 4+ would effectively double-weight "are there hooks somewhere." 2 keeps it informative without over-indexing.

Put differently: weight-4 checks (`unicode-steganography`, `permissions-hygiene`) each defend against attack classes where a single failure is directly exploitable. A missing local git hook is not — it's a missing speed-bump on the happy path. 2 points is the honest weight.

## Fix semantics

**No auto-fix.** This check exports no `fixes` array. Installing Husky/lefthook, choosing a secret scanner, writing a meaningful `pre-commit` script, and setting `pushurl = no_push` all require project-specific decisions (which tooling, which secrets config, which push policy) that a generic fixer cannot make safely.

- Out of scope: installing tooling (`npm install husky`, `brew install lefthook`).
- Out of scope: writing hook bodies.
- Out of scope: toggling `chmod +x` on hooks — it's a reasonable fix but paired with a no-op hook it'd produce a passing check for a hook that does nothing, so we surface it as INFO rather than auto-fixing.

## SARIF

- Tool component: `rigscore`.
- Rule IDs: emitted as `ruleId: "git-hooks"`; granular `<id>/<slug>` finding ids are used for `--ignore` matching and terminal output.
- Level mapping: CRITICAL → `error` (this check never emits CRITICAL), WARNING → `warning`, INFO → `note`, PASS/SKIPPED → suppressed.
- Location: logical location `process` module; no physical location for most findings (native hook findings include the hook path in the detail, which the SARIF extractor may pick up).
- Tags: `owasp-agentic:ASI02`, `category:process`.

## Example

```
git-hooks ........................... 85/100  (weight 2)
  WARNING   pre-commit hook is a no-op
            .git/hooks/pre-commit exists but contains only trivial commands (exit 0, echo, etc.). It provides no protection.
            → Add meaningful checks to your pre-commit hook.
  WARNING   Pre-commit hooks lack secret scanning
            No gitleaks, trufflehog, or detect-secrets integration detected in hooks.
            → Add a secret scanning step to your pre-commit hooks (e.g., gitleaks, trufflehog, detect-secrets).
  PASS      Husky hook manager installed
  PASS      Claude Code hooks configured
```

## Scope and limitations

- Detection is surface-level: a `package.json` entry for `husky` passes without verifying the hook is wired up or executable.
- No-op detection uses a fixed allowlist of trivial commands (`exit 0`, `true`, `:`, `echo`, `printf`, `sleep`, `date`, `ls`, `cat /dev/null`, `test -f`/`-d`, `whoami`, `pwd`, `hostname`, `uname`, `id`) and strips shebangs/comments; sneaky hooks using `while :; do :; done` trivially evade it.
- Substance detection is a regex sweep for common linter/scanner/test tool names plus `exit 1` and `if…then`. A custom Python script running legitimate checks with no recognised keyword will be flagged as "may lack substance" (INFO only, does not fail the check).
- Secret-scan detection only reads `.git/hooks/pre-commit`, `.git/hooks/pre-push`, and `.husky/pre-commit`. Scanners invoked from lefthook configs, Claude Code hooks, or `lint-staged` chains are **not** discovered and will produce a false-positive WARNING.
- Non-executable hooks on POSIX are INFO, not WARNING — git silently ignores them but the check surfaces the drift without failing hard.
- No platform gate beyond the executable-bit check being POSIX-only.
