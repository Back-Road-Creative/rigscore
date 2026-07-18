# coherence

**Enforcement grade:** `keyword` — pass/fail is driven by substring and phrase presence against governance prose (e.g. governance must mention each MCP server name; must contain an "approved tools" phrase). Gameable by keyword-stuffing; see [`test/keyword-gaming.test.js`](../../test/keyword-gaming.test.js) and [`THREAT-MODEL.md`](../../THREAT-MODEL.md) §3.1.

## Purpose

Cross-config coherence check. Runs AFTER `governance-docs`, `mcp-config`, `docker-security`, `skill-files`, `env-exposure`, and `claude-settings`, then looks for contradictions between what governance text CLAIMS and what configuration actually PERMITS. Maps to OWASP Agentic Top 10 `ASI01` (Agent Goal Hijack) — goal hijacks most often succeed through the gap between stated policy and enforced policy. A passing check guarantees: governance claims (network restrictions, path restrictions, forbidden actions, shell restrictions, anti-injection, approval gates) are consistent with actual MCP/Docker/settings configuration; every configured MCP server is declared somewhere in governance text (reverse coherence); any broad-capability server (filesystem/browser/shell/database/code/exec/terminal) is backed by an approved-tools section; and no author-specified allow-list entries violate repo-specific governance pairings.

A typical failure: CLAUDE.md says "no external network access" but `.mcp.json` has an MCP server using SSE transport to a non-localhost host. Agents read the governance, an attacker relies on the actual config.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Governance claims network restrictions + MCP uses network transport | WARNING | `coherence/network-claim-vs-mcp-transport` | Switch to stdio or update governance |
| Governance claims path restrictions + MCP has broad filesystem access | WARNING | `coherence/path-claim-vs-broad-filesystem` | Scope MCP filesystem to project |
| Governance claims forbidden actions + Docker is privileged | WARNING | `coherence/forbidden-claim-vs-privileged-docker` | Remove `privileged: true` |
| MCP drift detected across 2+ clients + governance silent on multi-client | WARNING | `coherence/multi-client-drift-no-governance` | Document multi-client rules or align configs |
| Governance claims shell restrictions + skill files contain shell execution patterns | WARNING | `coherence/shell-claim-vs-skill-shell-exec` | Remove shell patterns or update governance |
| Governance claims anti-injection + skill files contain injection patterns | CRITICAL | `coherence/anti-injection-claim-vs-skill-injection` | Remove injection patterns from skills |
| Skill exfiltration patterns AND MCP broad filesystem access (compound) | CRITICAL | `coherence/exfiltration-plus-broad-filesystem` | Remove exfil patterns and scope filesystem |
| Governance file in `.gitignore` (surfaced from `governance-docs`) | INFO | `coherence/governance-gitignored-echo` | Scored by `governance-docs`; informational only |
| Governance file not tracked in git (surfaced from `governance-docs`) | INFO | `coherence/governance-untracked-echo` | Scored by `governance-docs`; informational only |
| MCP server configured but not mentioned in any governance document | WARNING | `coherence/undeclared-mcp-server` | Add server declaration to CLAUDE.md |
| Broad-capability server (filesystem/browser/shell/database/code/exec/terminal) + no approved-tools section | INFO | `coherence/no-approved-tools-declaration` | Add "Approved Tools" section to governance |
| `bypassPermissions` + approval-gates claim + no `PreToolUse` hook | WARNING | `coherence/approval-claim-vs-bypass-no-hook` | Add `PreToolUse` hook or change `defaultMode` |
| Allow-list entry matches repo-specific forbidden pattern (`config.coherence.allowGovernanceContradictions`) | WARNING | `coherence/allow-list-contradicts-governance` (default; a pairing may override via its own `findingId`) | Remove entry or update governance |
| Insufficient data (no governance, or no config/skill data) | SKIPPED (score = N/A) | — | Ensure governance-docs and at least one config check ran |
| All checks coherent | PASS | — | — |

## Weight rationale

Weight 14 — tied with `mcp-config` as the highest-weight check, and the ONLY cross-check that compounds penalties across other check results. The high weight is deliberate: every individual check (governance-docs, mcp-config, docker, skill-files) can pass in isolation while the system as a whole is compromised, because the attack surface in agentic systems is the contradiction itself. `coherence` is the check that catches "governance says X, reality permits not-X" — a class of failure that no single-file linter can see. It stays equal to `mcp-config` rather than higher because it piggybacks on those upstream data exports (`matchedPatterns`, `serverNames`, `hasNetworkTransport`, etc.) and would produce zero findings if those checks didn't run first. It's higher than `skill-files` and `governance-docs` (both 10) because hijack through contradiction is strictly more dangerous than hijack through weak prose: weak prose gives the agent no rule; contradiction actively misleads human reviewers.

## Fix semantics

One `--fix`-able finding; the rest are advisory. `coherence.js` exports a single fixer (`coherence-declare-mcp-server`) for `coherence/undeclared-mcp-server`:

- **`coherence/undeclared-mcp-server` — FIXABLE.** `--fix --yes` APPENDS a clearly-marked placeholder section (`## MCP server: <name>`) for the undeclared server to the project's primary governance file (CLAUDE.md if present, else the first existing governance file). It is append-only — existing content is never rewritten or reordered — and idempotent: a server already named in the file is skipped, so re-running adds nothing. The stub is a placeholder the human fills in; it satisfies the "declared" check while making explicit that real purpose/scope prose is still owed. If the repo has NO governance file, the fixer declines (returns false) rather than fabricate one from nothing — use `init`/pack install for that.

The mismatch findings remain no-auto-fix: each is a contradiction between two files, and resolving it means choosing which side is the source of truth — never safe to automate:

- A `coherence/network-claim-vs-mcp-transport` fix could tighten governance OR loosen governance; only a human knows which reflects intent.
- A `coherence/anti-injection-claim-vs-skill-injection` finding may be a genuine typo in a skill file OR a deliberately phrased defensive rule that slipped past the defensive-phrase detector.
- `coherence/no-approved-tools-declaration` (INFO) is not auto-generated: appending a bare "Approved Tools" header to satisfy a keyword regex would be exactly the keyword-stuffing this check warns against.
- `.gitignore` / untracked governance findings are pass-through INFO records from `governance-docs`; `coherence` intentionally does not re-score them.

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
- Does not re-parse governance prose; relies on `matchedPatterns` from `governance-docs`. If that check's regex misses a phrase, coherence will not see it either.

## Known noise modes

Documented false-positive / low-signal modes surfaced during the 2026-04-20 Moat & Ship audit.

- **`coherence/undeclared-mcp-server` on every utility server** — fires for any MCP server not mentioned by name in governance prose. On mature configs with 5+ servers this creates one WARNING per server, most of which the author considered "obvious" and didn't document. Add an "Approved Tools" section to `CLAUDE.md` with each server name; fastest win.
- **`coherence/no-approved-tools-declaration` INFO** — fires whenever any broad-capability server (filesystem / browser / shell / database) exists without a dedicated approved-tools block. Pairs with `coherence/undeclared-mcp-server` — solving the latter usually silences this too.
- **`coherence/network-claim-vs-mcp-transport` on governance using `"no external network"` loosely** — phrase matching is regex-driven (`matchedPatterns` from `governance-docs`). Governance that says "no external network except MCP transports" still trips because the regex only matches the first half. Reword governance to explicitly allowlist MCP transports, or add a `coherence.allowGovernanceContradictions` entry.
- **Inapplicable on single-check scans** — `--check=coherence` alone returns N/A because the check consumes `priorResults` from other checks. Not a bug; document via `rigscore --help`.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026) — governance that contradicts configuration is the systemic failure class this pass targets.
