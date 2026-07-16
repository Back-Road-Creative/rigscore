# rigscore Roadmap — competitor-driven capability gaps

> **Candidate scope, not commitments.** These items were surfaced by the
> 2026-07 competitor/completeness audit as capabilities that peer tools ship
> and rigscore does not. They are recorded here so the gap is visible and
> prioritizable — nothing below is scheduled, and feature builds await
> explicit prioritization. This file complements the shorter user-facing
> [Roadmap section in the README](../README.md#roadmap); where they overlap
> (the governance-prose LLM-judge), this file carries the detail.

Each item lists: the **capability**, the **why** (competitor evidence + cited
source), rigscore's **current gap**, and a suggested **priority**. Priorities
mirror the audit severity tags and are relative to each other, not deadlines.

---

## High priority

### 1. Opt-in live MCP introspection

- **Capability:** A `--connect`-style flag that spawns a configured stdio MCP
  server, fetches its `tools/list`, and auto-feeds the result into the
  existing hash + LLM-judge pipeline — instead of requiring the operator to
  pipe descriptions in by hand.
- **Why:** Snyk Agent Scan "connects to servers and retrieves tool
  descriptions" (<https://github.com/snyk/agent-scan>), and Cisco mcp-scanner
  connects to running stdio/SSE servers while also offering an offline JSON
  mode (<https://github.com/cisco-ai-defense/mcp-scanner>).
- **Current gap:** rigscore is operator-pipe-only (THREAT-MODEL.md §3.2).
- **Design note:** local stdio spawn stays local-first, behind an opt-in flag
  — no change to the offline, API-key-free default.
- **Priority:** high

### 2. Automated trust-on-first-use (TOFU) re-pinning

- **Capability:** Re-pin tool descriptions automatically between scans and
  surface a semantic diff, so description drift is caught without a manual
  re-pin step.
- **Why:** Trail of Bits `mcp-context-protector` does TOFU pinning of server
  instructions and tool descriptions with a semantic diff, Apache-2.0
  (<https://github.com/trailofbits/mcp-context-protector>).
- **Current gap:** `mcp-pin` requires a manual re-pin per THREAT-MODEL §3.2;
  drift is invisible between scans unless the operator re-pins by hand.
- **Priority:** high

### 3. Governance-prose LLM-judge

- **Capability:** Ship the semantic LLM-judge pass over governance files
  (CLAUDE.md and peers) that catches semantic-reversal weaknesses keyword
  checks cannot see. Today this is README-Roadmap-only; the `--semantic` /
  `claude -p` plumbing already exists for tool descriptions and can be reused.
- **Why:** Cisco mcp-scanner and skill-scanner both include an "LLM-as-Judge"
  analyzer; Trail of Bits' wrapper adds LLM-guardrail scanning; Anthropic
  ships a semantic `/security-review`
  (<https://github.com/anthropics/claude-code-security-review>). Competitors
  already ship the pattern, validating the roadmap item.
- **Current gap:** README Roadmap-only (README.md:696) — not implemented.
- **Priority:** high

---

## Medium priority

### 4. Tool-shadowing / cross-server toxic-flow analysis

- **Capability:** Analyze pinned tool-description snapshots *across* servers to
  detect tool shadowing and toxic flows, not just per-server config in
  isolation.
- **Why:** Snyk Agent Scan detects "tool poisoning, tool shadowing, toxic
  flows" as first-class issue codes
  (<https://github.com/snyk/agent-scan/blob/main/docs/issue-codes.md>).
- **Current gap:** rigscore analyzes each server's config independently.
- **Priority:** med

### 5. Binary-file detection in skill dirs + opt-in malware-hash lookup

- **Capability:** Offline detection of binary / non-text files dropped into
  skill directories, plus an opt-in `--online` malware-hash lookup.
- **Why:** Cisco skill-scanner does bytecode-integrity checks and VirusTotal
  hash scanning (<https://github.com/cisco-ai-defense/skill-scanner>).
- **Current gap:** rigscore admits binaries in `.claude/skills/` are "not
  inspected at all" (THREAT-MODEL §3.4).
- **Priority:** med

### 6. AST / dataflow (taint) analysis for skill code

- **Capability:** Static AST + dataflow (taint) analysis of executable code
  shipped inside skills, going beyond the current regex phrase catalogs.
- **Why:** Cisco skill-scanner runs behavioral dataflow (AST analysis) and
  pipeline-command taint analysis locally, Apache-2.0
  (<https://github.com/cisco-ai-defense/skill-scanner>).
- **Current gap:** rigscore's `skill-files` check is `[pattern]`-grade only.
- **Priority:** med

---

## Low priority

### 7. OpenSSF MCP security framework as a 5th compliance framework

- **Capability:** Map rigscore checks to the OpenSSF MCP security framework
  (MITRE-ATT&CK-style, 80+ techniques) as a fifth compliance framework
  alongside the existing four (`src/constants.js` FRAMEWORKS).
- **Why:** The OpenSSF AI/ML Security WG framework is in progress
  (<https://github.com/ossf/ai-ml-security>); AgentAuditKit already markets
  "13 frameworks" versus rigscore's 4.
- **Current gap:** rigscore maps to 4 frameworks.
- **Priority:** low

### 8. Auditor-export formats (PDF / HTML)

- **Capability:** Export the compliance report in auditor-ready PDF / HTML,
  not only text.
- **Why:** AgentAuditKit ships "auditor-ready PDF compliance reports"
  (<https://github.com/marketplace/actions/agentauditkit-mcp-security-scan>).
- **Current gap:** `--report compliance` is text-only.
- **Priority:** low

### 9. Governance / system-prompt hardening as a `--fix` lane

- **Capability:** A `--fix` lane that suggests rewrites to harden governance /
  system-prompt prose (rewrite-suggest), not just mechanical config edits.
- **Why:** SplxAI Agentic Radar "scans and hardens system prompts"
  (<https://github.com/splx-ai/agentic-radar>).
- **Current gap:** `--fix` edits config only; no prose-hardening suggestions.
- **Priority:** low

### 10. A2A (agent-to-agent) config surface — watch, don't build

- **Capability:** An inspection surface for agent-to-agent (A2A)
  configuration. **Watch item only** — do not build yet; the space is
  emerging and lacks a second corroborating competitor.
- **Why:** Cisco's `a2a-scanner` exists
  (<https://cisco-ai-defense.github.io/>); rigscore's ASI07 surface is only
  the advisory network-exposure check.
- **Current gap:** no dedicated A2A inspection; advisory-only today.
- **Priority:** low (watch)
