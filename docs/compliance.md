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
| NIST AI RMF 1.0 (NIST AI 100-1) | Final (Jan 2023) | full | <https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf> |
| EU AI Act — Regulation (EU) 2024/1689 | In force, phased | full | <https://ai-act-service-desk.ec.europa.eu/en/ai-act/timeline/timeline-implementation-eu-ai-act> |

**Not yet mapped: the OWASP MCP Top 10** (<https://owasp.org/www-project-mcp-top-10/>). Its IDs
are confirmed (`MCP01:2025`–`MCP10:2025`), but the list is upstream **beta** ("Phase 3 — Beta
Release and Pilot Testing"), so IDs and rankings may still change. Left as a follow-up rather
than shipped as if settled.

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
