# agent-output-schemas

## Purpose

Enforces the convention documented in `_active/lib-skill-utils/AGENT_OUTPUT_SCHEMAS.md`: every fan-out sub-agent that emits JSON for an orchestrator to parse must declare the shape in a parseable ```` ```json ```` fenced block inside its `.md` file. Maps to OWASP Agentic Top 10 **ASI01 — Agent Authorization & Control Hijacking** (loosely; an undeclared or drifted JSON contract lets aggregated orchestrator output silently diverge from what the agent actually emits, breaking the goal-routing pipeline). A passing check means orchestrators in `health-check`, `workflow-maturity`, `pipeline-diagnose`, and the like have a stable contract to validate against. A failure usually means an agent was renamed, edited, or hand-authored without keeping its declared output example in lockstep with what the orchestrator-side schema expects.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Agent body claims JSON output (matches `Return ONLY a JSON` or contains `## Output Format`) but has no ```` ```json ```` fenced block | WARNING | `agent-output-schemas/missing-schema-block` | Add a ```` ```json ```` example block under `## Output Format` showing the exact shape the agent emits |
| Agent's ```` ```json ```` fenced block fails `JSON.parse` (placeholders left unquoted, trailing comma, comment) | WARNING | `agent-output-schemas/malformed-schema-block` | Validate the literal text with a JSON parser; quote placeholder strings; remove comments and trailing commas |
| No `.claude/agents/*.md` files found in cwd or homedir | N/A | — | Check returns the N/A sentinel; no findings emitted |
| All JSON-claiming agents have a parseable schema block | PASS | — | — |

## Weight rationale

Advisory — weight 0. The check enforces a documentation/contract convention, not a runtime security property. False positives are possible when an agent legitimately emits free-form prose but happens to mention "Return ONLY a JSON" in narrative or quoted example text; weight-0 keeps that noise out of overall score until detection precision is proven across the workspace. Sibling advisory checks (`workflow-maturity`, `skill-coherence`, `documentation`) take the same posture for the same reason: they classify, they don't gate.

## Fix semantics

No auto-fix. Both findings require a human decision about the agent's intended output shape, which rigscore cannot synthesize.

- `agent-output-schemas/missing-schema-block` → manual: author copies the canonical shape from `_active/lib-skill-utils/AGENT_OUTPUT_SCHEMAS.md` and customizes the keys for this agent's domain.
- `agent-output-schemas/malformed-schema-block` → manual: author fixes the JSON syntax. A naive find-and-replace would risk overwriting valid placeholder semantics (e.g., `"verdict": "FOO|BAR"` is an intentional enum hint, not a string literal to coerce).
- Out of scope: cross-referencing orchestrator-side schemas (e.g., `STRATEGY_SCHEMA` in `health-check.py`) against the agent-side example. That cross-check belongs in `lib-skill-utils` runtime validation, not a static doc scan.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: per-finding `agent-output-schemas/<finding-slug>`. The bare `agent-output-schemas` is registered as a check-level fallback for consumers that key on check ids.
- The `SARIF ruleId` column in the Triggers table matches the `findingId` emitted in terminal / JSON output and used by `.rigscorerc.json` `suppress[]` entries.
- Level mapping: WARNING → `warning`.
- Location data: the offending agent file path (`.claude/agents/<name>.md`), no line number — the fenced-block location is implicit within the file.
- Evidence: `context.agent` (basename without extension) and `context.path` (absolute path) appear as `properties` on the SARIF result. Malformed-block findings additionally include `context.fenceIndex` (1-based).

## Example

```
ⓘ agent-output-schemas — 70/100 (weight 0, advisory)
  WARNING Agent `health-strategy` has an unparseable ```json block
    /home/joe/.claude/agents/health-strategy.md declares JSON output but the
    ```json fenced block (#1) does not parse: Unexpected token } in JSON at
    position 142.
```

## Scope and limitations

- **Scans `.claude/agents/*.md` at the top level only.** Nested subdirectories under `.claude/agents/` are not walked. The convention as documented places agent files directly under that directory.
- **Both cwd and homedir scanned.** When `homedir !== cwd`, the check picks up user-global agent files installed under `~/.claude/agents/` in addition to repo-tracked ones under `<cwd>/.claude/agents/`.
- **Heuristic for "claims JSON" is intentionally loose.** Either `Return ONLY a JSON` (case-insensitive) or `## Output Format` (case-insensitive H2) qualifies. Tighter detection would miss synthesizer-style agents like `health-strategy` whose body uses the H2 form without the literal "Return ONLY" phrasing.
- **Parse-only validation, not key-level.** The check verifies that ```` ```json ```` blocks are valid JSON; it does NOT enforce that required keys (`name`, `verdict`, `rationale`, etc.) are present. Key-level enforcement is the orchestrator's responsibility at runtime — see `STRATEGY_SCHEMA` and `CATEGORY_SCHEMA` in `_active/lib-skill-utils/health-check.py`.
- **`.rigscorerc.json` disable.** This check is disabled in rigscore's own self-scan profile because rigscore itself is an npm package with no `.claude/agents/` directory. Workspaces that dogfood rigscore should leave it enabled.
- **No config knobs.** Detection patterns and the agent-directory location are hard-coded. If the convention drifts (e.g., agents move under `.claude/subagents/`), update `discoverAgentDirs` in `src/checks/agent-output-schemas.js` rather than adding configuration.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [OWASP Top 10 for Agentic Applications (2026) — ASI04/ASI05](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026) — agent tool-call / output surfaces as an injection and privilege-escalation vector.
- [Model Context Protocol — Tools](https://modelcontextprotocol.io/specification) — the tool-call schema whose drift this check watches.
