# init packs

rigscore tells you what is wrong. Packs install the baseline that makes it right.

```bash
rigscore .                    # see the red
rigscore init --<pack> [dir]  # install a starter pack
rigscore .                    # watch the score move
```

`rigscore init --list-packs` lists the packs and the checks each targets. An existing file is never overwritten without `--force`, and every file is reported `written` or `skipped (exists)`.

Packs are **not Claude-only**: alongside the Claude Code baselines there are least-privilege hardened baselines for other assistants (a narrow terminal/MCP allowlist with no auto-run wildcard, an ask/deny permission block, a prompt-on-every-tool approval mode). Each installs the client's own committed config file and turns its `sandbox-posture` grade off `unrestricted`. The installed configs name no organization or person — they are generic least-privilege, not a copy of anyone's private setup. `--list-packs` is the current roster; it never goes stale because discovery is a `readdir`.

## `--fix` offers the pack for you

You do not have to know which pack covers which check. `rigscore . --fix` reads the packs' `checks`
arrays and offers every pack that targets a check you are red on (critical or warning — an `info`
finding is not worth a baseline install):

```bash
rigscore . --fix                      # dry run: lists the auto-fixes AND the installable packs. Writes nothing.
rigscore . --fix --yes                # applies the auto-fixes. Packs are offered, NOT installed.
rigscore . --fix --yes --install-packs  # applies the auto-fixes, then installs the packs.
```

The two remediation sources stay distinct in the output, because they are not the same kind of
change — nor the same consent. An **auto-fixable issue** is a file-level edit to a file you already
have (append `.env` to `.gitignore`), while an **installable pack** *scaffolds* a whole starter
baseline you never had. `--yes` means "don't prompt me", so it unlocks only the first; scaffolding
takes its own opt-in, `--install-packs`. Without it, `--fix --yes` still names the packs that would
fix your red checks — listing costs nothing — and writes none of them.

`--install-packs` only widens what `--yes` may write; it never writes on its own, so
`rigscore . --fix --install-packs` (no `--yes`) is still a dry run.

`--fix` never rewrites governance content. It installs packs *without* `--force`, so a file you
already wrote is reported `skipped (exists)` and left byte-for-byte alone — `--fix --install-packs`
can only add the files you are missing. To overwrite deliberately, run `rigscore init --<pack>
--force` yourself.

## Not covered (yet)

- `--fix --install-packs` installs **every** applicable pack; there is no `--fix --pack <name>` to install just one.
  Use `rigscore init --<pack>` for that.
- Pack files land with their `{{PLACEHOLDER}}` vars unresolved apart from `PROJECT_NAME`, and the
  install warns about each. `--fix --yes` does not prompt for them.

## Adding a pack

A pack is a directory under `templates/` holding a `pack.json`. Discovery is a `readdir`: drop the
directory in and it appears in `--list-packs` and `init --<name>`. There is no list to edit.

```json
{
  "name": "docs",
  "description": "one line, shown in the pack list",
  "checks": ["claude-md"],
  "files": [{ "src": "AGENTS.md", "dest": "AGENTS.md", "exec": false }],
  "vars": { "PROJECT_NAME": "the target repository's directory name" }
}
```

- **`name`** must equal the directory name. A malformed manifest fails loudly at load — a pack that
  half-installs is worse than one that refuses to.
- **`checks`** — the ids this pack turns green: the pack → check map a red finding is offered against.
  Claim a check only if you have **measured** the pack improving it; one it cannot move (or that already
  scores 100 on a bare repo) is a lie in a machine-readable file, and keyword-stuffing our own checks is
  the bypass [known-limits.md](known-limits.md) warns about.
- **`files`** — `src` is relative to the pack dir, `dest` to the target repo; an absolute `dest`, or one
  containing `..`, is refused. `exec` (optional boolean) sets the executable bit, and dests under
  `.git/hooks/` or `.githooks/` get it automatically — a hook without `+x` is inert, yet a presence-based
  check still scores it green. When `core.hooksPath` points elsewhere git ignores an installed hook
  silently, so install prints a loud `WARNING` naming the directory git actually reads.
- **`vars`** — optional `PLACEHOLDER` → description map, substituted at install. Only `PROJECT_NAME`
  resolves today; any other placeholder is left in place and warned about.
