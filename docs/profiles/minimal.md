# Profile: `minimal`

AI-moat checks only. A fast smoke test that scores nothing but the four
AI-specific checks and zeroes everything else — useful when you only care
whether the MCP / coherence / skill-file / governance surface is sane and
don't want secrets, Docker, or infra findings moving the number.

## Weights

| Check | Weight | Category |
| --- | --- | --- |
| mcp-config | 30 | supply-chain |
| coherence | 30 | governance |
| skill-files | 20 | supply-chain |
| governance-docs | 20 | governance |
| all other checks | 0 | off / advisory |

Weights sum to **100**. Every check not listed (including `deep-secrets`,
`env-exposure`, `docker-security`, `git-hooks`, `permissions-hygiene`) is
set to 0 and drops out of both scoring and the coverage denominator.

## When to use

- A quick gate that answers "is the AI-agent config posture acceptable?"
- Repos where the non-AI surface is covered by other tooling and you don't
  want it double-counted here.

## Usage

```bash
rigscore --profile minimal .
```
