# coherence

## Purpose

Cross-config coherence check. Runs AFTER `claude-md`, `mcp-config`, `docker-security`, `skill-files`, `env-exposure`, and `claude-settings`, then looks for contradictions between what governance text CLAIMS and what configuration actually PERMITS. Maps to OWASP Agentic Top 10 `ASI01` (Agent Goal Hijack) — goal hijacks most often succeed through the gap between stated policy and enforced policy. A passing check guarantees: governance claims (network restrictions, path restrictions, forbidden actions, shell restrictions, anti-injection, approval gates) are consistent with actual MCP/Docker/settings configuration; every configured MCP server is declared somewhere in governance text (reverse coherence); any broad-capability server (filesystem/browser/shell/database/code/exec/terminal) is backed by an approved-tools section; and no author-specified allow-list entries violate repo-specific governance pairings.

A typical failure: CLAUDE.md says "no external network access" but `.mcp.json` has an MCP server using SSE transport to a non-localhost host. Agents read the governance, an attacker relies on the actual config.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Governance claims network restrictions + MCP uses network transport | WARNING | `coherence/network-contradiction` | Switch to stdio or update governance |
| Governance claims path restrictions + MCP has broad filesystem access | WARNING | `coherence/path-contradiction` | Scope MCP filesystem to project |
| Governance claims forbidden actions + Docker is privileged | WARNING | `coherence/docker-contradiction` | Remove `privileged: true` |
| MCP drift detected across 2+ clients + governance silent on multi-client | WARNING | `coherence/multi-client-silent` | Document multi-client rules or align configs |
| Governance claims shell restrictions + skill files contain shell execution patterns | WARNING | `coherence/shell-contradiction` | Remove shell patterns or update governance |
| Governance claims anti-injection + skill files contain injection patterns | CRITICAL | `coherence/injection-contradiction` | Remove injection patterns from skills |
| Skill exfiltration patterns AND MCP broad filesystem access (compound) | CRITICAL | `coherence/exfil-plus-filesystem` | Remove exfil patterns and scope filesystem |
| Governance file in `.gitignore` (surfaced from `claude-md`) | INFO | `coherence/gitignored-governance` | Scored by `claude-md`; informational only |
| Governance file not tracked in git (surfaced from `claude-md`) | INFO | `coherence/untracked-governance` | Scored by `claude-md`; informational only |
| MCP server configured but not mentioned in any governance document | WARNING | `coherence/undeclared-server` | Add server declaration to CLAUDE.md |
| Broad-capability server (filesystem/browser/shell/database/code/exec/terminal) + no approved-tools section | INFO | `coherence/no-approved-tools-section` | Add "Approved Tools" section to governance |
| `bypassPermissions` + approval-gates claim + no `PreToolUse` hook | WARNING | `coherence/approval-no-hook` | Add `PreToolUse` hook or change `defaultMode` |
| Allow-list entry matches repo-specific forbidden pattern (`config.coherence.allowGovernanceContradictions`) | WARNING | `coherence/custom-pairing` | Remove entry or update governance |
| Insufficient data (no governance, or no config/skill data) | SKIPPED (score = N/A) | — | Ensure claude-md and at least one config check ran |
| All checks coherent | PASS | — | — |

## Weight rationale

Weight 14 — tied with `mcp-config` as the highest-weight check, and the ONLY cross-check that compounds penalties across other check results. The high weight is deliberate: every individual check (claude-md, mcp-config, docker, skill-files) can pass in isolation while the system as a whole is compromised, because the attack surface in agentic systems is the contradiction itself. `coherence` is the check that catches "governance says X, reality permits not-X" — a class of failure that no single-file linter can see. It stays equal to `mcp-config` rather than higher because it piggybacks on those upstream data exports (`matchedPatterns`, `serverNames`, `hasNetworkTransport`, etc.) and would produce zero findings if those checks didn't run first. It's higher than `skill-files` and `claude-md` (both 10) because hijack through contradiction is strictly more dangerous than hijack through weak prose: weak prose gives the agent no rule; contradiction actively misleads human reviewers.

## Fix semantics

No auto-fix. The `coherence.js` module does not export a `fixes` array. Every finding is a contradiction between two files — resolving it means choosing which side is the source of truth, and that choice is never safe to automate:

- A `network-contradiction` fix could tighten governance OR loosen governance; only a human knows which reflects intent.
- An `injection-contradiction` may be a genuine typo in a skill file OR a deliberately phrased defensive rule that slipped past the defensive-phrase detector.
- `undeclared-server` findings need a human to write the declaration prose — auto-appending a server name to CLAUDE.md would satisfy the check without satisfying the intent.
- `.gitignore` / untracked governance findings are pass-through INFO records from `claude-md`; `coherence` intentionally does not re-score them.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: see Triggers — all prefixed `coherence/`.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`.
- OWASP tag: `owasp-agentic:ASI01` attached to every finding via `properties.tags`.
- Location: findings attach the logical `governance` module location. No physical path is emitted because every finding spans at least two files by definition; the referenced files appear in the finding detail text.

## Example

```
✗ coherence — 0/100 (weight 14)
  CRITICAL Governance claims anti-injection rules but skill files contain injection patterns
    Governance includes anti-injection rules, but 2 injection pattern(s) were found.
    → Remove injection patterns from skill files or review for false positives.
  WARNING Governance claims network restrictions but MCP uses network transport
    Your governance file restricts external network access, but an MCP server
    uses SSE/HTTP transport to a non-localhost host.
  WARNING Undeclared MCP server: github
    Server 'github' is configured but not mentioned in any governance document.
    → Add a section to CLAUDE.md declaring 'github' purpose and scope restrictions.
```

## Scope and limitations

- Requires `priorResults` populated by the orchestrator — cannot be run standalone via `--check coherence`.
- Returns `NOT_APPLICABLE_SCORE` when either governance or configuration data is missing; no findings are emitted in that case.
- Custom governance/allow-list pairings must be declared in `.rigscorerc.json` under `coherence.allowGovernanceContradictions` as `{ allowRe, govRe, title?, detail?, remediation? }`. Default is empty — no author-specific pairings fire out of the box.
- Does not re-parse governance prose; relies on `matchedPatterns` from `claude-md`. If that check's regex misses a phrase, coherence will not see it either.
