# Profile: `default`

The balanced AI dev environment audit — the profile used when nothing else
is selected. Weights are moat-heavy: the four AI-specific checks (MCP scope,
cross-config coherence, skill files, CLAUDE.md governance) carry 48 of the
100 scored points, so a project's AI posture dominates the score.

## Weights

| Check | Weight | Category |
| --- | --- | --- |
| mcp-config | 14 | supply-chain |
| coherence | 14 | governance |
| skill-files | 10 | supply-chain |
| governance-docs | 10 | governance |
| claude-settings | 8 | governance |
| deep-secrets | 8 | secrets |
| env-exposure | 8 | secrets |
| credential-storage | 6 | secrets |
| docker-security | 6 | isolation |
| infrastructure-security | 6 | process |
| unicode-steganography | 4 | supply-chain |
| permissions-hygiene | 4 | process |
| git-hooks | 2 | process |
| all 15 advisory checks | 0 | advisory |

Weights sum to **100**. The 15 advisory (weight-0) checks never affect the
score and are excluded from the coverage-penalty denominator.

## When to use

- Any single project you want scored against the full check surface.
- The right default for CI unless you specifically need the `ci` alias or a
  narrower profile.

## Usage

```bash
rigscore --profile default .   # or simply: rigscore .
```
