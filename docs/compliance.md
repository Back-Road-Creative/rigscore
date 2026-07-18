# Compliance mapping

rigscore maps each check to the control it evidences, and renders findings grouped by
control — plain deterministic text, diffable in CI or handed to an auditor:

```bash
rigscore --report compliance .
```

## The honesty rule

**An honest sparse table beats a complete fictional one.** A check is listed under a control
only where it genuinely produces evidence for it — we never pad the table to make coverage look
broader than it is, because a wrong citation is the one artifact a customer forwards to their
auditor. So the report *prints*, rather than hides: **`NOT EVIDENCED`** (a control no check
supports), **`UNMAPPED`** (a check with no honest home in that framework), and each framework's
upstream **`status`** — a *beta* list never renders as settled.

The report also **discloses suppression**: when a repo's `.rigscorerc.json` `suppress:` list (or
`--ignore`) mutes findings, the compliance output names how many were suppressed and their ids —
the same `⚠ Suppressed N findings via config/--ignore: …` summary the terminal, JSON and SARIF
surfaces carry — so a muted CRITICAL can never read to an auditor as clean-with-nothing-muted.

rigscore evidences technical controls in a repository; it is not a management system, so it
cannot evidence your risk-management process, log retention, or end-user disclosures. Adding a
framework? Confirm every ID against its **primary source**, record that URL and status in
`FRAMEWORKS`, and if you cannot confirm a control, leave it out — the invariants in
`test/constants.test.js` then hold the table honest.

## Frameworks

"Full" coverage = every **scored** check (weight > 0) is mapped.

| Framework | Status | Coverage | Primary source |
|---|---|---|---|
| OWASP Top 10 for Agentic Applications 2026 (`ASIxx:2026`) | Final (2025-12-09) | full | <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> |
| OWASP MCP Top 10 (`MCPxx:2025`) | **Beta** (Phase 3, pilot testing) | partial | <https://owasp.org/www-project-mcp-top-10/> |
| NIST AI RMF 1.0 (NIST AI 100-1) | Final (Jan 2023) | full | <https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf> |
| EU AI Act — Regulation (EU) 2024/1689 | In force, phased | full | <https://ai-act-service-desk.ec.europa.eu/en/ai-act/timeline/timeline-implementation-eu-ai-act> |

## OWASP MCP Top 10 — beta, and it says so

This is the one **beta** list rigscore maps (`MCP01:2025`–`MCP10:2025`, upstream "Phase 3 — Beta
Release and Pilot Testing"). IDs and rankings may still change, so its `status` carries `BETA`
and the report prints that status on every run — it must never read to an auditor as settled.

Coverage is **partial by design**. The list is scoped to MCP servers and the protocol, so a check
earns a row only where it inspects an MCP surface. `governance-docs`, `skill-files` and `git-hooks` scan
agent prose and commit gates with no MCP nexus — they are left `UNMAPPED` rather than padded in to
make the table look full, as are the containment checks `docker-security` and
`infrastructure-security` (see `MCP05` below).

| Control | Evidenced by |
|---|---|
| `MCP01` Token Mismanagement & Secret Exposure | `credential-storage`, `env-exposure`, `deep-secrets`, `permissions-hygiene` |
| `MCP02` Privilege Escalation via Scope Creep | `claude-settings` (auto-approve / `bypassPermissions`) |
| `MCP03` Tool Poisoning | `unicode-steganography` (hidden instruction chars in `.mcp.json`) |
| `MCP04` Software Supply Chain Attacks & Dependency Tampering | `mcp-config` (unpinned `npx`, typosquats, rug-pull drift) |
| `MCP09` Shadow MCP Servers | `coherence` (a configured server undeclared in governance) |
| `MCP05`, `MCP06`, `MCP07`, `MCP08`, `MCP10` | `NOT EVIDENCED` — input sanitization, runtime intent, auth flows, audit telemetry and live context |

rigscore reads MCP configuration **at rest**; it never executes or introspects a running server.
Every NOT EVIDENCED control above is a property of a server *in execution*, which is why they are
reported as gaps rather than mapped.

`MCP05` is the one worth spelling out, because it is the tempting one to fake. A sandbox or
hardened container — what `docker-security` and `infrastructure-security` measure — bounds the
**blast radius** of an injected command. It never shows that a tool **sanitizes its input**, which
is what the control actually asks. Citing containment posture as `MCP05` evidence would sell an
auditor a control rigscore cannot see, so `MCP05` reads `NOT EVIDENCED` and those two checks are
scored on the axes they *do* evidence (`ASI05`/`ASI02`, `MEASURE 2.7`, `Article 15`).

> Two IDs are widely mis-stated by secondary sources: **`MCP03` is Tool Poisoning** and
> **`MCP05` is Command Injection & Execution**. Both are transcribed from the primary source
> above and pinned by `test/compliance.test.js`.

## EU AI Act — dates

Obligations do **not** all start on the same day, so the report prints the date per Article.
High-risk Articles 11, 14 and 15 apply from **2026-08-02** (Annex III) and **2027-08-02**
(Art. 6(1)/Annex I); Article 50 (transparency) applies from **2026-08-02**. Most checks are
Article 15 (cybersecurity/robustness) evidence; `claude-settings` maps to Article 14, because
MCP auto-approve / `bypassPermissions` literally removes the human from the loop.

**Article 50 is deliberately unmapped**: rigscore does not inspect whether your system tells
users they are talking to an AI, nor whether it marks synthetic content — so it produces no
Article 50 evidence, and says so.

> **Digital Omnibus caveat.** The proposed "Digital Omnibus" would delay the high-risk dates
> (Annex III → 2027-12-02, Annex I → 2028-08-02). As of 2026-07 it is **not in force**:
> Parliament approved it in plenary on 2026-06-16, but Council adoption and Official Journal
> publication are still pending. The dates above are the in-force schedule of Regulation (EU)
> 2024/1689. **Do not plan against the delay.**
