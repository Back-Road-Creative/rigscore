# init packs

rigscore tells you what is wrong. Packs install the baseline that makes it right.

```bash
rigscore .                    # see the red
rigscore init --<pack> [dir]  # install a starter pack
rigscore .                    # watch the score move
```

`rigscore init --list-packs` lists the packs and the checks each targets. An existing file is never overwritten without `--force`, and every file is reported `written` or `skipped (exists)`.

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

## The `docs` pack

Installs `AGENTS.md`, the vendor-neutral instruction file Claude Code, Cursor, Copilot and Aider
all read. On a bare project with an `.mcp.json` and no governance file it moves the score from
**44/100 (D) to 62/100 (C)** — `CLAUDE.md governance` goes 0/10 → 10/10.

It claims **`claude-md`** and nothing else. The template covers all nine rule categories that check
scores (forbidden actions, approval gates, path / network / shell restrictions, anti-injection, TDD,
definition of done, git workflow) with real rules, not keywords; `test/packs-docs.test.js` asserts
the installed file scores 100 against the real check, so watering it down goes red.

It does **not** claim `coherence`, which compares governance against *your* config: it wants every
MCP server you run named in a governance doc, and a template cannot know your servers. Installing the
pack can therefore legitimately *surface* a coherence finding (`Undeclared MCP server: <name>`) — that
finding is real. Name your servers in `AGENTS.md` and it clears.
