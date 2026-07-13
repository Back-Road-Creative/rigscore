# `guards` — agent-safety baseline

| file | dest | what it does |
| --- | --- | --- |
| `settings.json` | `.claude/settings.json` | Deny rules: destructive shell, credential reads, network exfil. |
| `permissions.json` | `.claude/permissions.json` | Permissions manifest with an **expiry**, a renewal policy, and an audit changelog. |
| `pre-commit` | `.git/hooks/pre-commit` | Secret scan that actually blocks the commit. |

## Measured effect

Bare git repo (`README.md` + one commit), scanned before and after installing by hand:

| check | before | after |
| --- | --- | --- |
| `claude-settings` | N/A (no settings file) | 98 |
| `git-hooks` | 85 (`no-hooks-installed`) | 100 |
| **overall** | **14** | **26** |

`pack.json.checks` lists only the two checks that actually move.

**Why `permissions-hygiene` is not claimed:** it already scores 100 on a bare repo. It reads
filesystem modes (`~/.ssh`, world-readable `*.pem`/`*.key`, governance-file ownership) and never
opens `settings.json`, so nothing here can raise it. Claiming it would be a false statement in a
machine-readable file.

**Why `claude-settings` is 98, not 100:** the last 2 points are one `info` — this pack ships no
Claude Code lifecycle hooks, and it says so. 98 is the honest score for that, and it is now also
the *floor*: lifecycle coverage costs at most one `info` regardless of how partial it is, so the
check no longer scores one hook (formerly 94) below zero hooks (98). Chasing the last 2 points here
would mean shipping four stub hooks that do no work — exactly the keyword-gaming the pack's own
`pre-commit` refuses to do. A pack earns 100 on this check by hooking lifecycle events it genuinely
uses, not by filling slots.

## The secret scan is real, not a presence check

`git-hooks` credits the strings `gitleaks` / `trufflehog` / `detect-secrets`, so a hook could score
100 with those words in a comment. This one doesn't. Two layers:

1. **A dedicated scanner** — `gitleaks protect --staged`, else `trufflehog`, else
   `detect-secrets-hook`, whichever is on `PATH`. Actually invoked.
2. **A dependency-free regex backstop that always runs**, so a machine with no scanner installed is
   still protected. Blocks AWS keys, PEM private keys, GitHub/Slack/OpenAI tokens, quoted
   `api_key`/`secret`/`token` assignments, and any staged `.env` / `*.pem` / `*.key` / `id_rsa*`.

Verified on a fixture: an AWS key, a PEM private key, and a `.env` are each **blocked**; a clean
commit passes. Bypass is `git commit --no-verify` — deliberately loud.

## Install caveats

- **The hook needs the executable bit.** `.git/hooks/pre-commit` is inert without `chmod +x`, so
  the installer must preserve mode, or rigscore reports `hook-not-executable`.
- **A global `core.hooksPath` overrides `.git/hooks` entirely.** If `git config --get
  core.hooksPath` returns a path, git ignores this hook — point that dir at it, or unset it.
- **The expiry is inert unless enforced.** `permissions.json` carries `expires` plus an
  `enforcement.suggestedCi` one-liner; wire it into CI (PR + daily) so the repo goes red the day
  permissions go stale. An unenforced expiry date is decoration.
