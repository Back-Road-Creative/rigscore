# rigscore Threat Model

**Audience:** security reviewers, integrators, and anyone weighing whether to trust rigscore output as part of a larger assurance story.

**Voice:** honest and technical. rigscore is a configuration-hygiene scanner, not a runtime security tool. This document spells out the difference so a reviewer can predict, on a new project, what rigscore will flag and what it will miss — without having to read the source.

Companion document: [`docs/known-limits.md`](docs/known-limits.md) — shorter, user-facing, with "if you need this, use X" pointers.

---

## 1. What rigscore inspects

All checks are pure functions of the local filesystem. Default mode makes zero network calls. The `--online` flag opts in to npm-registry and MCP-registry lookups — nothing else.

| Surface | Check module | Mechanism |
|---|---|---|
| MCP server scope (filesystem root access, network transport, typosquats, unstable tags) | [`src/checks/mcp-config.js`](src/checks/mcp-config.js) | String/JSON parse of `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`; typosquat check against a ~52-entry hand-curated registry. |
| MCP server config-shape drift (baseline → rescan) | [`src/checks/mcp-config.js`](src/checks/mcp-config.js) (pinning) | SHA-256 of canonicalized config shape, stored in `.rigscore-state.json`. |
| MCP server tool-description pins (CVE-2025-54136 class) | [`src/checks/mcp-config.js`](src/checks/mcp-config.js) + `rigscore mcp-pin` / `rigscore mcp-verify` | User pipes `tools/list` JSON into `rigscore mcp-hash`; rigscore stores the hash. rigscore does **not** spawn the MCP server. |
| Docker privileges (`--privileged`, socket mounts, `host` network, `run --user root`) | [`src/checks/docker-security.js`](src/checks/docker-security.js) | Regex scan of `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*.yml`. |
| Governance coherence (config claims match CLAUDE.md statements) | [`src/checks/coherence.js`](src/checks/coherence.js) | Substring / regex match of governance text against discovered MCP server names and capability keywords. |
| CLAUDE.md quality signals (forbidden-action phrasing, approval gates, path restrictions, anti-injection, TDD, DoD) | [`src/checks/claude-md.js`](src/checks/claude-md.js) | Keyword-presence regex with per-signal negation detection (e.g. "we do **not** restrict paths" flips a pass into a CRITICAL). |
| Skill-file prompt injection, shell-exec lures, broad-tool auto-approval language, base64 payloads, homoglyph / zero-width evasion | [`src/checks/skill-files.js`](src/checks/skill-files.js) | Regex catalog + Unicode normalization pass. |
| Claude Code `settings.json` (shell allowlists, hook coverage, dangerous flags) | [`src/checks/claude-settings.js`](src/checks/claude-settings.js) | JSON parse + rule table. |
| Secret exposure in source, env files, credential stores | [`src/checks/deep-secrets.js`](src/checks/deep-secrets.js), [`src/checks/env-exposure.js`](src/checks/env-exposure.js), [`src/checks/credential-storage.js`](src/checks/credential-storage.js) | High-entropy regex + known-provider prefix patterns. |
| Git hook presence, executability, no-op detection, secret-scan integration | [`src/checks/git-hooks.js`](src/checks/git-hooks.js) | File existence, mode bits, regex scan for "substance" keywords (`gitleaks`, `trufflehog`, `lint`, `test`, etc.). |
| Skill-file Unicode steganography | [`src/checks/unicode-steganography.js`](src/checks/unicode-steganography.js) | Codepoint class scan (zero-width, bidi-override, tag chars). |
| File permissions hygiene | [`src/checks/permissions-hygiene.js`](src/checks/permissions-hygiene.js) | `stat` mode bits on governance files. |

Advisory-weight (scored 0, surfaced only): `windows-security`, `network-exposure`, `site-security`, `instruction-effectiveness`, `skill-coherence`, `workflow-maturity`.

## 2. Trust boundaries

- **Local filesystem only** in default mode. rigscore reads files under the scan target and a small set of `$HOME` paths (`~/.claude/settings.json`, `~/.claude/skills/`). It writes `.rigscore-state.json` into the scan target.
- **No network unless `--online`.** The online opt-in reaches the npm registry and the MCP registry for typosquat augmentation. It does not spawn MCP servers, does not call LLM APIs, does not exfiltrate.
- **Assumes a user-controlled machine.** rigscore does not sandbox the files it reads. A maliciously crafted `package.json` that triggers a parser exploit in `JSON.parse` is on Node, not on rigscore.
- **Does not sandbox itself.** The CLI runs with the invoking user's privileges. A compromised dependency in rigscore's own supply chain (chalk, yaml) would run with those privileges. See Stream A (`.github/workflows/release.yml`) for the signed-release + SBOM mitigation.
- **Point-in-time.** Each scan is a snapshot. There is no daemon, no watcher by default (`--watch` exists but restarts the same point-in-time scan on change). Anything that happens between scans is invisible.

## 3. What rigscore does NOT catch

Each item below names a real gap, grounds it in the check module that would "own" the gap if we filled it, and links to a characterization test if one exists. Items marked `# TODO(stream-E): characterization test needed` are real but unverified-in-test; Stream E of the verifiability campaign will add fixtures.

### 3.1 Semantic reversal in governance prose

CLAUDE.md that names the right safety words ("never," "approval gate," "path restrictions") but dismantles them in the surrounding paragraph — e.g. *"Never delete production data, unless the model believes it is stale"* — scores **the same as** a strict version that lacks the escape clause. The [`claude-md`](src/checks/claude-md.js) check is keyword-presence with single-sentence negation detection (`/\bwe do not restrict paths\b/` style). It does not parse semantics. An adversarial author who keeps the trigger words and adds an "except when..." weakens the governance invisibly.

**Partial test coverage:** [`test/keyword-gaming.test.js`](test/keyword-gaming.test.js) covers the single-sentence negation case (`"we do not restrict paths"` → CRITICAL). It does **not** cover multi-sentence reversal or "unless/except" clauses. `# TODO(stream-E): characterization test needed` for multi-sentence semantic reversal.

### 3.2 Runtime MCP tool-description drift

rigscore's tool-hash pinning is a **print-and-paste** workflow: the user runs the MCP server, pipes `tools/list` JSON into `rigscore mcp-hash`, and rigscore stores the hash. See [`src/checks/mcp-config.js:712`](src/checks/mcp-config.js) — the `remediation` field literally reads *"rigscore does NOT execute the server — user must pipe tools/list JSON into stdin."* If the user never pins, drift is invisible. If the user pins once and never re-verifies, a CVE-2025-54136-class tool-description swap between pin and scan is invisible. rigscore hashes what it is given; it does not probe live servers.

**Test coverage:** [`test/mcp-runtime-hash.test.js`](test/mcp-runtime-hash.test.js) covers the pin/verify round-trip when the user supplies input. It does not (and cannot) cover live-drift-between-scans — that is a design limit, not a bug.

### 3.3 Supply-chain compromise at install time

rigscore is distributed via `npx github:Back-Road-Creative/rigscore`. Once `npm install` runs inside that tarball, rigscore trusts what it got: `chalk`, `yaml`, and the pinned lockfile. rigscore does not re-verify its own dependencies at runtime, does not scan `node_modules` for postinstall script tampering, and does not detect a malicious `preinstall`/`postinstall` lifecycle script in the *user's* project (no check module inspects `package.json` lifecycle scripts). A compromised registry mirror or a dependency-confusion attack at install is out of scope.

Mitigation path is Stream A of the verifiability campaign: signed releases, SBOM, provenance attestation. That lets a user verify rigscore itself; it does not close the gap for the user's project dependencies.

`# TODO(stream-E): characterization test needed` — a fixture project with a hostile `package.json` `postinstall` script should confirm rigscore does not flag it.

### 3.4 Binary / base64 / minified payloads inside skill files

[`src/checks/skill-files.js:98`](src/checks/skill-files.js) defines `BASE64_PATTERN = /(?:^|\s)[A-Za-z0-9+/]{50,}={0,2}(?:\s|$)/m` — anchored, requires whitespace boundary, raises a **warning** (not critical) with no decode step. This means:

- Contiguous base64 blobs ≥50 chars surrounded by whitespace: flagged (warning).
- Base64 split across lines with non-whitespace separators, or embedded mid-sentence: not flagged.
- Minified JavaScript pasted as "config": not flagged (looks like prose to the regex).
- Binary files dropped into `.claude/skills/` (e.g. `payload.bin`): rigscore's skill-file walker is scoped to text extensions; binaries are not inspected at all.
- Hex-encoded or ROT13-encoded payloads: not flagged.

**Test coverage:** [`test/injection-evasion.test.js`](test/injection-evasion.test.js) covers Unicode homoglyph and zero-width evasion of *injection phrases*, not encoded *payloads*. `# TODO(stream-E): characterization test needed` for base64-embedded-in-prose, hex, and binary-file-in-skill-dir cases.

### 3.5 Obfuscated bash in git hooks

[`src/checks/git-hooks.js`](src/checks/git-hooks.js) decides whether a hook "has substance" by regex-matching keywords like `gitleaks`, `lint`, `test`, `shellcheck`. A hook built from base64-decoded shell (`eval "$(echo <b64> | base64 -d)"`), from positional-parameter tricks (`${!1}`), or from a wrapper that `source`s a separate file in `.git/hooks/`, will pass the substance filter if the wrapper happens to contain any keyword — or fail with only a low-severity info finding if it contains none. rigscore does not tokenize bash, does not trace `source`/`.` directives, and does not flag entropy anomalies in hook content.

**Test coverage:** no characterization test exists for obfuscated-but-keyword-present hooks. `# TODO(stream-E): characterization test needed`.

### 3.6 LLM prompt-injection content inside docs/skills (beyond the canonical phrase list)

[`src/checks/skill-files.js`](src/checks/skill-files.js) catches a fixed catalog: *ignore previous instructions*, *disregard prior*, *you are now*, *pretend you are*, *from now on you*, etc. — plus homoglyph and zero-width variants of those phrases (see [`test/injection-evasion.test.js`](test/injection-evasion.test.js)). An injection authored in novel phrasing ("your task has been updated to the following rubric..."), or embedded in a multi-paragraph story, or delivered via a tool-output fixture, will pass. rigscore does not invoke an LLM judge; there is no semantic classifier.

Scoped mitigation path exists in Stream E of the campaign plan (`--llm-review` advisory flag). Until that ships, this is a known gap.

### 3.7 Anything after the scan

rigscore is point-in-time. A scan that passes at 09:00 says nothing about the state of the tree at 09:01. `--watch` mode re-runs the same point-in-time scan on file change; it does not stream telemetry or observe running agents. A malicious actor who modifies a skill file, triggers a Claude Code session, and reverts the file is invisible to any future rigscore scan. Continuous runtime observation is out of scope and would be a different tool.

No test covers this — it is a design property, not a check.

## 4. Coverage summary table

| Gap | Evidence | Characterization test | Stream E action |
|---|---|---|---|
| Semantic reversal in governance | [`claude-md.js`](src/checks/claude-md.js) keyword-only | [`keyword-gaming.test.js`](test/keyword-gaming.test.js) partial | extend: multi-sentence reversal |
| Runtime MCP tool-description drift | [`mcp-config.js:712`](src/checks/mcp-config.js) design note | [`mcp-runtime-hash.test.js`](test/mcp-runtime-hash.test.js) pin workflow | N/A — design limit |
| Install-time supply-chain compromise | no module inspects `node_modules` / lifecycle scripts | none | add: hostile-postinstall fixture |
| Binary / base64 / minified in skill files | [`skill-files.js:98`](src/checks/skill-files.js) anchored regex, warning severity | [`injection-evasion.test.js`](test/injection-evasion.test.js) covers phrases, not payloads | add: inline-base64, hex, `.bin` fixtures |
| Obfuscated bash in git hooks | [`git-hooks.js`](src/checks/git-hooks.js) keyword substance filter | none | add: `eval $(base64 -d)` fixture |
| Novel LLM prompt injection | [`skill-files.js`](src/checks/skill-files.js) fixed phrase list | [`injection-evasion.test.js`](test/injection-evasion.test.js) canonical phrases only | design: Stream E `--llm-review` advisory |
| Post-scan activity | design: point-in-time scanner | none | N/A — out of scope |

## 5. If you need coverage rigscore doesn't provide

- **Live MCP tool-description pinning:** [Snyk Agent Scan](https://snyk.io/product/agent-scan/) probes running MCP servers and anchors tool hashes live.
- **LLM-judge semantic review layer:** [AgentShield](https://agentshield.io/) and similar provide an adversarial LLM pass over governance docs and skill files.
- **Code SAST (taint analysis, dataflow):** [Semgrep](https://semgrep.dev/) — rigscore does not reason about source-code vulnerabilities.
- **Git-history secret scanning:** [gitleaks](https://github.com/gitleaks/gitleaks) — rigscore scans the working tree, not git history.
- **SBOM / dependency vulnerability:** [Trivy](https://trivy.dev/), [osv-scanner](https://osv.dev/) — rigscore publishes its own SBOM but does not scan yours.

rigscore is complementary to these tools. It closes the "did you configure it safely in the first place" gap that SAST and runtime scanners assume was handled upstream.

---

*Last updated: 2026-04-21. Source of truth lives in the check modules under [`src/checks/`](src/checks/) — if this document disagrees with the code, the code wins. File an issue.*
