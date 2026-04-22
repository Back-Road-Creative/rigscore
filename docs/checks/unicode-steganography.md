# unicode-steganography

**Enforcement grade:** `pattern` — structural codepoint-class scan (zero-width, bidi-override, homoglyph ranges, tag chars). Deterministic for the enumerated ranges; novel ranges require an update.

## Purpose

Scans governance files (`CLAUDE.md`, agent/skill markdown under `_governance/` — the set is defined by `GOVERNANCE_FILES` in `src/constants.js`) and MCP/Claude config files (`.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`) for hidden Unicode characters that render identically to legitimate text but instruct the agent differently. Maps to **OWASP Agentic ASI01 — Agent Goal Hijack**: homoglyphs, zero-width characters, bidirectional overrides, and language-tag characters are the core primitives behind the ToxicSkills and Rules File Backdoor injection classes — they smuggle instructions past human review because the rendered glyphs look like ordinary English. A pass guarantees none of the scanned files contain characters from the flagged ranges. A failure means at least one governance or config file contains text that reads one way to a human reviewer and potentially another way to the model.

## Triggers

Each call to `findings.push(...)` in `src/checks/unicode-steganography.js` becomes a row. All severities come directly from the source.

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| File contains bidirectional override chars (U+202A–202E, U+2066–2069) | CRITICAL | `unicode-steganography/bidirectional-override-characters-in-file` | Remove all bidi override characters |
| File contains zero-width chars (U+200B–200D, U+2060, U+FEFF) | WARNING | `unicode-steganography/zero-width-characters-in-file` | Remove zero-width characters; `cat -v <file>` reveals them |
| File contains classic homoglyphs (Greek U+0370–03FF, Cyrillic U+0400–052F, Armenian U+0530–058F, Georgian U+10A0–10FF, Cherokee U+13A0–13FF) after NFKC normalization | WARNING | `unicode-steganography/homoglyph-characters-in-file` | Replace with ASCII equivalents |
| File contains modern homoglyphs (Mathematical Alphanumeric Symbols U+1D400–1D7FF, Fullwidth Latin U+FF00–FF5E, Cherokee U+13A0–13FF) on raw text | WARNING | `unicode-steganography/homoglyph-characters-in-file` | Replace with ASCII equivalents |
| File contains Unicode tag characters (U+E0001–E007F) | WARNING | `unicode-steganography/unicode-tag-characters-in-file` | Remove tag characters from the file |
| No governance or config files present to scan | INFO | `unicode-steganography/no-governance-or-config-files-found` | N/A — check returns N/A |
| All scanned files clean | PASS | — | — |

Note: classic and modern homoglyph detections share the same finding title (`Homoglyph characters in <file>`) and therefore the same slug — the `detail` field enumerates which ranges matched.

## Weight rationale

**Weight 4 — 4 points.** Tied with `permissions-hygiene` (4). Both are tier-3 hygiene checks that protect against specific but narrower attack surfaces than the tier-1 moat checks (`mcp-config`/`coherence` at 14, `claude-md`/`skill-files` at 10) and mid-tier secret hygiene (8). This tie is deliberate: unicode steganography is a *high-impact but rare* attack class — documented in research (ToxicSkills, Rules File Backdoor) but uncommon in the wild — while `permissions-hygiene` is a *low-per-incident but common* hygiene check. Both deserve the same modest 4-point budget. Higher than `git-hooks` (2) because a successful homoglyph attack rewrites governance that the agent actively consults; lower than `credential-storage` (6) because the compromise path requires the attacker to first land a doctored file into the repo.

## Fix semantics

**No auto-fix.** This check exports no `fixes` array. Stripping characters automatically from governance files would violate the hard rule that `--fix` never modifies governance content, and a deterministic strip is unsafe — legitimate non-ASCII text (Greek math symbols in a linguistics project, fullwidth CJK in localization notes) can occur. The fix is always a human review:

- Out of scope: modifying any file under `_governance/`, `CLAUDE.md`, `.mcp.json`, or `.claude/settings*.json` — governance-content rule.
- Out of scope: auto-normalizing NFKC — would silently change meaning of legitimate Unicode.

Use the remediation hint (`cat -v <file>` for zero-width) and a Unicode-aware editor search to clean manually.

## SARIF

- Tool component: `rigscore`.
- Rule IDs: emitted as `ruleId: "unicode-steganography"`; granular `<id>/<slug>` finding ids are used in terminal output and `--ignore`.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → suppressed.
- Location: physical location extracted from the file path in the finding title (e.g. `CLAUDE.md`, `.mcp.json`); otherwise logical location `governance` module.
- Tags: `owasp-agentic:ASI01`, `category:governance`.

## Example

```
unicode-steganography ............... 70/100  (weight 4)
  CRITICAL  Bidirectional override characters in CLAUDE.md
            File contains bidi override characters (U+202A-202E, U+2066-2069) that can make text appear different from what is stored.
            → Remove all bidirectional override characters.
  WARNING   Homoglyph characters in .mcp.json
            File contains non-Latin characters (Greek, Cyrillic, Armenian, Georgian, Cherokee) and characters from Fullwidth Latin ranges that visually resemble Latin letters.
  WARNING   Zero-width characters in _governance/skills/deploy.md
            File contains invisible zero-width characters that could hide malicious content.
            → Remove zero-width characters. Run: cat -v <file> to reveal them.
```

## Scope and limitations

- Scanned files: `GOVERNANCE_FILES` (constants.js) ∪ `.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`.
- No directory recursion — files not in the enumerated set are never scanned.
- Classic homoglyph ranges are checked **after** NFKC normalization; modern ranges (Mathematical Alphanumeric, Fullwidth Latin) NFKC-normalize to ASCII and are therefore checked on the raw text.
- Non-malicious uses of the flagged ranges (scientific notation using U+1D4…, CJK fullwidth) will trigger warnings — by design, since governance text should be plain ASCII.
- No platform gate; runs on all OSes.
- If none of the scanned files exist, the check returns N/A with one INFO finding and does not affect the score.
