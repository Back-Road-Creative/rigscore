# Scoring profiles

`rigscore` ships five built-in profiles. A profile is a weight map that
controls how each check contributes to the overall 0–100 score.

| Profile | Use-case | Key weights |
| --- | --- | --- |
| `default` | Balanced AI dev environment audit | Moat-heavy: mcp-config 14, coherence 14, skill-files 10, claude-md 10 |
| `minimal` | Smoke test — only the AI-specific moat checks | mcp-config 30, coherence 30, skill-files 20, claude-md 20; everything else 0 |
| `ci` | CI pipelines (identical to `default` today; reserved for future divergence) | Same as `default` |
| `home` | Single-user dev boxes (e.g. `~/` as the project root) | Governance / skills / MCP emphasized; infra / docker / windows off |
| `monorepo` | Multi-project repos — same weights as `default` but hints `--recursive --depth 3` | Same as `default` |

## Selection order

1. `--profile <name>` CLI flag
2. `.rigscorerc.json` `"profile"` in the project
3. `~/.rigscorerc.json` `"profile"` (user global)
4. `default`

Unknown profiles throw a descriptive error at scan time.

See [`home.md`](./home.md) and [`monorepo.md`](./monorepo.md) for the new
profiles added in Moat & Ship.
