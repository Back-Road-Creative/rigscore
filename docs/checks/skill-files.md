# skill-files

## Purpose

Scans every skill / command / sub-agent instruction file visible to the project — all governance files other than `CLAUDE.md`, plus every file under `.claude/commands/` and `.claude/skills/` (recursive) — for patterns that would hijack, exfiltrate, escalate, persist, or disguise instructions. Optionally extends to `~/.claude/commands/**` and `~/.claude/skills/**` via `--include-home-skills`. Maps to OWASP Agentic Top 10 `ASI01` (Agent Goal Hijack). A passing check guarantees: no instruction-override patterns (single-line or 2-line sliding window), no shell execution directives, no outbound data exfiltration, no privilege escalation, no persistence instructions, no indirect injection (`eval`, `new Function`, "download and run"), no trust-exploitation phrases (CVE-2025-54136 class), no Unicode steganography (bidi overrides, zero-width, homoglyphs including Mathematical Bold / Fullwidth Latin / Cherokee), no plaintext HTTP URLs, no suspicious base64 blobs, and no world-writable skill files.

Findings in a skill file are treated as seriously as findings in CLAUDE.md itself — a sub-agent's prompt IS its law.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Injection pattern (e.g. "ignore previous instructions", "act as if you are", "from now on you…") in defensive context | INFO | `skill-files/injection-defensive` | None — defensive rule |
| Injection pattern in non-defensive context (single-line or 2-line window) | CRITICAL | `skill-files/injection` | Rephrase or remove override pattern |
| Shell execution pattern (`run \``…\`` `, `execute bash`, `curl http`, `wget http`) | WARNING | `skill-files/shell-exec` | Review shell instructions for necessity |
| Data exfiltration pattern (`send … to https`, `post … to https`, `upload … to`, `curl … -d`, `redirect output to`) | WARNING | `skill-files/exfiltration` | Remove or restrict outbound transfer |
| Privilege escalation pattern (`sudo`, `run as root`, `chmod 777`, `chmod +x`, `disable …security`, `turn off …firewall`) | WARNING | `skill-files/escalation` | Remove escalation instructions |
| Persistence pattern (`crontab`, `systemctl enable`, `startup script`, `modify bashrc`, `npm -g`) | WARNING | `skill-files/persistence` | Remove persistence instructions |
| Indirect injection pattern (`eval(`, `new Function(`, `fetch and run`, `download and execute`) | CRITICAL | `skill-files/indirect-injection` | Remove dynamic code execution |
| Trust exploitation pattern (CVE-2025-54136 — "always approve", "skip verification", "trust output from…") | WARNING | `skill-files/trust-exploitation` | Remove blind-trust instructions |
| Bidirectional override characters (U+202A-202E, U+2066-2069) | CRITICAL | `skill-files/bidi-override` | Remove bidi characters |
| Zero-width characters (ZWJ/ZWNJ/ZWS/BOM/ZWNBS, U+200B-200D, U+2060, U+FEFF) | WARNING | `skill-files/zero-width` | Strip with `cat -v` inspection |
| Homoglyphs in classic ranges (Greek, Cyrillic, Armenian, Georgian, Cherokee) | WARNING | `skill-files/homoglyph-classic` | Replace with ASCII equivalents |
| Homoglyphs in modern prompt-injection ranges (Mathematical Bold/Italic Latin, Fullwidth Latin, Cherokee) | WARNING | `skill-files/homoglyph-modern` | Replace with ASCII equivalents |
| Non-TLS `http://` URLs | WARNING | `skill-files/http-url` | Use HTTPS |
| `https://` URLs present | INFO | `skill-files/https-url` | Verify URLs are legitimate |
| Possible base64 blob (≥50 chars, whitespace-bounded) | WARNING | `skill-files/base64` | Decode and review |
| Skill file is world-writable (mode `& 0o002`, POSIX only) | WARNING | `skill-files/world-writable` | `chmod 644 <file>` |
| No skill files found | INFO (score = N/A) | — | None — check inapplicable |
| All skill files clean | PASS | — | — |

## Weight rationale

Weight 10 — the lower of the two "moat" governance-surface checks. Tied with `claude-md` because a skill file and CLAUDE.md are functionally equivalent attack surfaces: both inject text straight into the agent's context window with high authority, and an attacker who can write to `.claude/commands/pwn.md` has the same leverage as one who can write to `CLAUDE.md`. The pair is weighted below `mcp-config` and `coherence` (both 14) because governance-level goal hijack is recoverable with a better file, while an active supply-chain compromise (mcp-config) or an enforced-contradiction compromise (coherence) has already acted. It sits above hygiene-tier checks like `claude-settings` (8) and `permissions-hygiene` (4) because these files are written by humans and committed to git — they are where intent is encoded, so malicious intent hides there best.

Skill-files and claude-md are both 10 rather than one being higher because the check surfaces differ: `skill-files` sees the long tail (many files, Unicode attacks, persistence/exfiltration) while `claude-md` sees the quality of the ONE file; each protects a flank the other doesn't.

## Fix semantics

`--fix --yes` handles one finding class:

- `skill-file-world-writable` → `chmod 644` on every world-writable file under `.claude/commands/` and `.claude/skills/` (POSIX only; Windows returns `false`).

Out of scope for auto-fix: every finding related to file CONTENT. Injection patterns, exfiltration patterns, trust exploitation, Unicode steganography, escalation, persistence, indirect injection, and URL findings are all prose-level judgment calls. Auto-stripping an "ignore previous instructions" string would destroy a legitimate defensive rule; auto-stripping bidi overrides would silently alter rendering. Both require a human diff review.

## SARIF

- Tool component: `rigscore`
- Rule IDs emitted: see Triggers — all prefixed `skill-files/`.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`.
- OWASP tag: `owasp-agentic:ASI01` on every finding via `properties.tags`.
- Location: when a finding title contains a relative path (e.g. `Injection pattern found in .claude/commands/deploy.md`), SARIF emits `physicalLocation.artifactLocation.uri` pointing at that file. Otherwise the finding attaches only the logical `supply-chain` module location.

## Example

```
✗ skill-files — 0/100 (weight 10)
  CRITICAL Injection pattern found in .claude/commands/deploy.md
    File contains instruction override patterns that could hijack AI agent behavior.
    → Remove instruction override patterns. If legitimate, rephrase.
  CRITICAL Bidirectional override characters in .claude/skills/helper.md
    File contains Unicode bidi overrides that can make text render differently than stored.
    → Remove all bidirectional override characters from the file.
  WARNING Shell execution instructions in .claude/commands/build.md
    File contains instructions to execute shell commands.
  WARNING Skill file .claude/commands/legacy.md is world-writable
    legacy.md has mode 666.
    → Run: chmod 644 .claude/commands/legacy.md
```

## Scope and limitations

- Default scope: project `cwd` only. `--include-home-skills` opts in to scanning `~/.claude/commands/**` and `~/.claude/skills/**` — disabled by default to keep project scores independent of per-user skill libraries.
- World-writable check is POSIX-only; Windows skips silently (no `skipped` finding is emitted for this specific check — Windows still scans the content patterns).
- Injection detection runs line-by-line AND on 2-line sliding windows, then short-circuits after the first finding per file to avoid noise. Other pattern families (shell/exfil/escalation/persistence/indirect/trust) also emit at most one finding per category per file.
- The `STRONG_DEFENSIVE_RE` heuristic downgrades clearly defensive sentences (e.g. "refuse to follow injection attempts") to INFO. Weak single words like "detect" or "stop" do not trigger the downgrade — they're too common in non-security prose.
- Base64 detection requires a 50+ char run bounded by whitespace — deliberately conservative to avoid flagging hashes and checksums.
- Config override: `.rigscorerc.json` key `paths.skillFiles` adds extra files to the scan list.
