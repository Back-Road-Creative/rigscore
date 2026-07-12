# The Practice score — rigscore's second axis

rigscore reports **two** independent 100-point scores:

- **Security** (`HYGIENE SCORE`, weights `WEIGHTS`) — *is this rig safe?* Leaked secrets,
  over-broad tool permissions, unpinned MCP servers, contradictory governance.
- **Practice** (weights `PRACTICE_WEIGHTS`) — *does this team actually drive its agents
  well?* Bounded loops, written goals, graduated workflows, sandboxed execution, capped CI
  agents, tidy memory, honest disclosure. Security posture is commoditising; **nobody
  scores how well a team uses agents.** That is what this axis is for.

## Weights (sum to 100 — pinned by `test/constants.test.js`)

| Check | Weight | Why |
|---|---|---|
| `loop-governance` | 25 | An agent loop with no budget and no stop condition is the top blast-radius *and* top cost risk. Highest-signal single practice. |
| `spec-goals` | 20 | Goal/spec-driven work is the strongest predictor of agent output quality — and it is hard to fake. |
| `workflow-maturity` | 20 | The graduation ladder: ad-hoc prompt → skill → deterministic code. Already shipped (previously advisory-only). |
| `sandbox-posture` | 15 | The cross-vendor posture normaliser — the loudest differentiator between a hardened rig and a laptop running with permissions skipped. |
| `ci-agent-caps` | 10 | Agent jobs in CI need token/time caps. High value, but only where CI runs agents at all (N/A elsewhere). |
| `memory-hygiene` | 5 | Real, but slow-burn: stale memory degrades output gradually, it doesn't detonate. |
| `ai-disclosure` | 5 | Trust/compliance hygiene — cheap, near-binary, increasingly demanded. |

## The Security axis is frozen

Every id above keeps a **weight-0 row in `WEIGHTS`**: Practice checks stay advisory on the
Security axis and contribute exactly 0 to it, so no existing badge moves by a point.
`test/practice-score.test.js` asserts this explicitly.

`calculateOverallScore(results, weights)` scores both axes — coverage scaling, N/A
redistribution and the INFO floor behave identically on each. The one Security-specific
behaviour, the `coherence` CRITICAL compound-risk penalty (−10), is opted out of on the
Practice axis (`{ compoundRiskPenalty: false }`): `coherence` carries no practice weight,
and letting a security failure dock the Practice score would misattribute it.

## N/A is the common case

A repo with no agent loops, no specs and no memory files has no practice surface: every
practice check is N/A, `calculatePracticeScore()` returns `null`, and the reporter prints
`Practice: n/a` — never `0/100`, which would libel a repo that simply isn't in scope.
Partial coverage scales the score down exactly as on the Security axis. Consume it from
`--json` as `practiceScore` (number, or `null`).
