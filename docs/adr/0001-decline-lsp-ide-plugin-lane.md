# ADR 0001 — Decline the LSP / IDE-plugin lane

- **Status:** Accepted (deferral recorded, not punted)
- **Date:** 2026-07-18
- **Deciders:** rigscore maintainers
- **Related:** 2026-07 competitive landscape review (landscape item: "Defer LSP/IDE plugins"); [`docs/ROADMAP.md`](../ROADMAP.md)

## Context

Part of the competitive set ships editor-native surfaces: at least one competing
agent-config scanner provides a Language Server (LSP) plus a handful of IDE
plugins, and general-purpose SAST platforms ship editor integrations. An
LSP/plugin lane would put rigscore findings inline in the editor as the operator
types.

The competitive review flagged this as an explicit decision point rather than an
unexamined gap: another tool already owns the editor-integration lane, so the
question is whether to contest it or compete on posture scoring. Under the
project's defer-nothing rule, a deferral must be *recorded with its rationale*,
not left as an unlisted omission — hence this ADR.

## Decision

**rigscore will not build an LSP or IDE-plugin lane at this time.** It stays a
CLI / CI / GitHub-Action tool that emits SARIF (which GitHub Advanced Security,
and any SARIF-consuming editor extension, already renders inline for free).

Rationale:

1. **Different job.** rigscore scores whole-repo *posture* (a 0–100 hygiene +
   practice score over instructions, MCP, skills, hooks, CI, Docker, env). That
   is a commit/PR/CI-gate artifact, not a keystroke-latency, single-file signal
   an LSP is built to deliver.
2. **The moat is breadth + score, not editor presence.** No competitor ships a
   practice score or a full-surface hygiene score; an LSP would spend scarce
   effort on a lane a competitor already owns instead of widening the moat.
3. **SARIF already covers the inline case** without a bespoke plugin per editor:
   any SARIF-aware extension surfaces rigscore results in-editor today.
4. **Maintenance cost.** Four-plus editor plugins is an ongoing multi-surface
   maintenance burden disproportionate to a deterministic, offline scanner run
   at commit/CI time.

## Consequences

- **Positive:** effort stays on differentiators (posture scoring, client
  breadth, verifiability) rather than a contested editor-integration lane.
- **Positive:** SARIF output keeps the inline-in-editor path open with zero
  rigscore-side plugin code.
- **Negative:** rigscore has no as-you-type editor feedback; operators who want
  that reach for a dedicated editor-integrated linter.
- **Revisit when:** a SARIF-only inline path proves insufficient in practice, or
  a single cross-editor plugin runtime (not several bespoke ones) becomes cheap
  to maintain. Track alongside the SAST-encroachment watch item in the ROADMAP.
