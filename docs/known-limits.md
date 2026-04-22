# Known Limits

rigscore is a configuration-hygiene scanner. It is intentionally scoped. This page is the short version of what it will *not* catch, so you can reach for the right tool when you need one rigscore isn't.

For the full reasoning and code pointers, see [`THREAT-MODEL.md`](../THREAT-MODEL.md).

## The seven we know about

| If you need... | rigscore's limit | Reach for |
|---|---|---|
| Governance prose that means what it says (not just uses the right words) | [`claude-md`](../src/checks/claude-md.js) is keyword-presence + single-sentence negation. Multi-sentence "unless/except" reversals pass. | An LLM-judge layer like [AgentShield](https://agentshield.io/) or a human review gate. |
| Live MCP tool-description pinning (CVE-2025-54136 class, between scans) | rigscore stores the hash you hand it via `rigscore mcp-pin`. It does not spawn the MCP server and cannot detect drift you didn't re-pin for. | [Snyk Agent Scan](https://snyk.io/product/agent-scan/) probes running servers and anchors tool hashes live. |
| Install-time supply-chain integrity of your project's dependencies | rigscore does not inspect `node_modules`, `package.json` lifecycle scripts, or registry provenance of your deps. | [Trivy](https://trivy.dev/), [osv-scanner](https://osv.dev/), npm/pnpm audit, or Socket.dev. |
| Binary / base64 / minified payloads in skill files | The base64 regex is anchored (contiguous ≥50 chars between whitespace) and raises only a warning. Hex, ROT13, binary dropped into `.claude/skills/`, and base64-in-prose all slip. | Manual review + entropy-based scanners (`detect-secrets`, custom `file --mime-type` sweep for non-text in skill dirs). |
| Obfuscated bash in git hooks | [`git-hooks`](../src/checks/git-hooks.js) keyword-matches for substance (`lint`, `gitleaks`, `test`). `eval "$(base64 -d)"` wrappers and `source`-chains can pass. | [ShellCheck](https://www.shellcheck.net/) + a bash-semantics linter in CI, or manual hook review. |
| Novel LLM prompt-injection content (beyond the canonical phrase list) | rigscore matches a fixed catalog of injection phrases plus their Unicode/homoglyph variants. Paraphrased or multi-paragraph injection walks past. | An LLM-judge advisory pass ([AgentShield](https://agentshield.io/)), or [Protect AI Guardian](https://protectai.com/guardian). |
| Source-code vulnerabilities (SQL injection, SSRF, deserialization, etc.) | rigscore does not do SAST. It has never claimed to. | [Semgrep](https://semgrep.dev/), [CodeQL](https://codeql.github.com/). |
| Secrets in git history | rigscore scans the working tree. A secret committed and then deleted is in history and invisible to rigscore. | [gitleaks](https://github.com/gitleaks/gitleaks), [trufflehog](https://github.com/trufflesecurity/trufflehog). |
| Anything that happens between scans | rigscore is point-in-time. `--watch` re-runs on file change; it is not continuous observation. | A runtime agent monitor (there is no clear category leader yet; log-based observability + [AgentShield](https://agentshield.io/) runtime hooks are the closest off-the-shelf option). |

## How to read a rigscore report, given the above

A green rigscore means: **the configuration surfaces rigscore inspects are clean at scan time.** It does not mean the project is secure. It is one signal among several. The intended pairing is:

1. rigscore — configuration hygiene (this tool).
2. Semgrep or CodeQL — source-code vulnerabilities.
3. gitleaks — historical secrets.
4. Snyk Agent Scan — live MCP behavior.
5. An LLM-judge pass or human review — semantic governance.

No single tool in that list is sufficient. rigscore aims to be the best-in-class option for layer 1 and nothing more.

---

Full threat model and per-gap evidence: [`THREAT-MODEL.md`](../THREAT-MODEL.md).
