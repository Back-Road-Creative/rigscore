# rigscore Roadmap — capability gaps

> **Candidate scope, not commitments.** These items were surfaced by the
> 2026-07 completeness audit as capabilities rigscore does not yet ship.
> They are recorded here so the gap is visible and
> prioritizable — nothing below is scheduled, and feature builds await
> explicit prioritization. This file complements the shorter user-facing
> [Roadmap section in the README](../README.md#roadmap); where they overlap
> (the governance-prose LLM-judge), this file carries the detail.

Each item lists: the **capability**, rigscore's **current gap**, and a
suggested **priority**. Priorities mirror the audit severity tags and are
relative to each other, not deadlines.

---

## High priority

### 1. Opt-in live MCP introspection

- **Capability:** A `--connect`-style flag that spawns a configured stdio MCP
  server, fetches its `tools/list`, and auto-feeds the result into the
  existing hash + LLM-judge pipeline — instead of requiring the operator to
  pipe descriptions in by hand.
- **Current gap:** rigscore is operator-pipe-only (THREAT-MODEL.md §3.2).
- **Design note:** local stdio spawn stays local-first, behind an opt-in flag
  — no change to the offline, API-key-free default.
- **Priority:** high

### 2. Automated trust-on-first-use (TOFU) re-pinning

- **Capability:** Re-pin tool descriptions automatically between scans and
  surface a semantic diff, so description drift is caught without a manual
  re-pin step.
- **Current gap:** `mcp-pin` requires a manual re-pin per THREAT-MODEL §3.2;
  drift is invisible between scans unless the operator re-pins by hand.
- **Priority:** high

### 3. Governance-prose LLM-judge

- **Capability:** Ship the semantic LLM-judge pass over governance files
  (CLAUDE.md and peers) that catches semantic-reversal weaknesses keyword
  checks cannot see. Today this is README-Roadmap-only; the `--semantic` /
  `claude -p` plumbing already exists for tool descriptions and can be reused.
- **Current gap:** README Roadmap-only (README.md:696) — not implemented.
- **Priority:** high

---

## Medium priority

### 4. Tool-shadowing / cross-server toxic-flow analysis

- **Capability:** Analyze pinned tool-description snapshots *across* servers to
  detect tool shadowing and toxic flows, not just per-server config in
  isolation.
- **Current gap:** rigscore analyzes each server's config independently.
- **Priority:** med

### 5. Binary-file detection in skill dirs + opt-in malware-hash lookup

- **Capability:** Offline detection of binary / non-text files dropped into
  skill directories, plus an opt-in `--online` malware-hash lookup.
- **Current gap:** rigscore admits binaries in `.claude/skills/` are "not
  inspected at all" (THREAT-MODEL §3.4).
- **Priority:** med

### 6. AST / dataflow (taint) analysis for skill code

- **Capability:** Static AST + dataflow (taint) analysis of executable code
  shipped inside skills, going beyond the current regex phrase catalogs.
- **Current gap:** rigscore's `skill-files` check is `[pattern]`-grade only.
- **Priority:** med

---

## Low priority

### 7. OpenSSF MCP security framework as a 5th compliance framework

- **Capability:** Map rigscore checks to the OpenSSF MCP security framework
  (MITRE-ATT&CK-style, 80+ techniques) as a fifth compliance framework
  alongside the existing four (`src/constants.js` FRAMEWORKS).
- **Why:** The OpenSSF AI/ML Security WG framework is in progress
  (<https://github.com/ossf/ai-ml-security>).
- **Current gap:** rigscore maps to 4 frameworks.
- **Priority:** low

### 8. Auditor-export formats (PDF / HTML)

- **Capability:** Export the compliance report in auditor-ready PDF / HTML,
  not only text.
- **Current gap:** `--report compliance` is text-only.
- **Priority:** low

### 9. Governance / system-prompt hardening as a `--fix` lane

- **Capability:** A `--fix` lane that suggests rewrites to harden governance /
  system-prompt prose (rewrite-suggest), not just mechanical config edits.
- **Current gap:** `--fix` edits config only; no prose-hardening suggestions.
- **Priority:** low

### 10. A2A (agent-to-agent) config surface — watch, don't build

- **Capability:** An inspection surface for agent-to-agent (A2A)
  configuration. **Watch item only** — do not build yet; the space is
  emerging and lacks a second corroborating signal.
- **Why:** rigscore's ASI07 surface is only the advisory network-exposure
  check.
- **Current gap:** no dedicated A2A inspection; advisory-only today.
- **Priority:** low (watch)

---

## LLM / environment agnosticism

These deferred items broaden rigscore past a single AI client or CI system.
Each is on hold until the cross-vendor surface it depends on stabilizes.

### 11. CI agent-capability check beyond GitHub Actions

- **Capability:** Extend the `ci-agent-caps` check past `.github/workflows` to
  other CI systems — at minimum GitLab CI — via a generic CI-recipe reader, so
  agent-capability scanning is not GitHub-Actions-only.
- **Current gap:** `ci-agent-caps` parses `.github/workflows` exclusively.
- **Priority:** low

### 12. Scored per-client settings-safety family

- **Capability:** A scored settings-safety check family that pairs with the
  existing `claude-settings` check, extending scored settings analysis to other
  AI clients.
- **Current gap:** only Claude settings are scored today; other clients get
  advisory sandbox-posture output only.
- **Priority:** low

### 13. Registry-driven env-exposure client list

- **Capability:** Derive the AI-client config-file list scanned by
  `env-exposure` from the client registry (`src/clients.js`) rather than a
  hardcoded list.
- **Current gap:** `env-exposure`'s client-settings coverage is a hardcoded
  list whose only client-settings entry is `.claude/settings.json`.
- **Priority:** low

### 14. Cross-vendor memory-hygiene conventions

- **Capability:** Revisit `memory-hygiene` conventions once a cross-vendor
  memory convention exists, so the check is not shaped around one vendor's
  memory layout.
- **Current gap:** `memory-hygiene` conventions are Claude-shaped by necessity
  today; no cross-vendor memory convention exists yet.
- **Priority:** low (watch)
