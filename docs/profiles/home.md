# Profile: `home`

For single-user dev boxes where `~/` is the scanned project root. A home
directory is not a service host, so infra-centric checks should not be
allowed to drag the score down or inflate the coverage-penalty denominator.

## Weights

| Check | Weight | Notes |
| --- | --- | --- |
| mcp-config | 20 | MCP server configuration matters most on a user's box |
| skill-files | 20 | Personal skills are the main governance surface |
| claude-md | 20 | Global CLAUDE.md drives every session |
| coherence | 15 | Cross-config drift is still critical |
| claude-settings | 10 | Allow/deny hygiene |
| deep-secrets | 5 | Opt-in via `--deep` |
| env-exposure | 5 |   |
| credential-storage | 5 |   |
| docker-security | 0 | Off — home dir isn't a container host |
| infrastructure-security | 0 | Off — requires workspace-style hooks dir |
| unicode-steganography | 0 | Advisory |
| git-hooks | 0 | Not relevant to home governance |
| permissions-hygiene | 0 | Off |
| windows-security | 0 | Off |
| all other advisory checks | 0 | Off |

Weights sum to **100**.

## When to use

- You scan `~/` or `~/.claude/` directly
- You want the score to reflect governance / skill file / MCP posture
  without coverage-penalty penalties for N/A infra surfaces

## Usage

```bash
rigscore --profile home ~/
```

Or via `~/.rigscorerc.json`:

```json
{ "profile": "home" }
```
