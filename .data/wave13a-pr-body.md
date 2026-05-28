## Summary

Wave 13a — first phase of the `mcp-config.js` god-function decomposition (Complexity #1, critical: `run()` was 587 lines as of main). Extracts the three per-server checks that don't depend on outer-loop accumulator state beyond returning a transport flag:

- **`checkTransportType(server, name, relPath, safeHosts) → { findings, hasNetworkTransport }`.** SSE / HTTP / explicit `url` field counts as network; localhost targets get an INFO note instead of the larger-attack-surface WARNING. Returns the flag so the outer loop can roll it up into the check's `data` block.
- **`checkSensitiveEnv(server, name, relPath) → findings`.** ≥3 sensitive keys upgrades to CRITICAL ("wildcard" passthrough); 1-2 is a WARNING.
- **`checkAnthropicBaseUrl(server, name, relPath) → findings`.** CVE-2026-21852 detection; co-disclosed Checkpoint URL preserved as-is per the comment noting why the URL slug names the other CVE (`correctness-bugs T3.14d` pins both files to the same reference).

**`run()` shrinks from 587 to 531 lines (-56).** Behavior is bit-identical: same finding IDs, severities, evidence, learnMore URLs. All 88 existing mcp-config-related end-to-end tests still pass.

Wave 13b will tackle typosquat + npm-registry extractions; 13c covers hooks + CVE-2025-59536 compound; 13d closes with hash-pinning + drift detection. Final `run()` target: ~60 lines.

Closes Complexity #1 (partial), Complexity #3 (partial — the 6-level nesting drops as the helpers absorb their conditionals).

## Test plan

- [x] 9 new direct unit tests for the helpers:
    - `checkTransportType`: stdio empty, remote SSE WARNING + flag flip, localhost http INFO without flag flip
    - `checkSensitiveEnv`: 0 / 1-2 / ≥3 sensitive-key paths
    - `checkAnthropicBaseUrl`: empty / canonical / localhost / attacker host
- [x] Existing 88 mcp-config end-to-end tests still green (`mcp-config` 39, `mcp-evasion` 15, `mcp-supply-chain` 12, `mcp-expansion` 8, `correctness-bugs` 24 — overlap subset, full mcp-related)
- [x] Full `npx vitest run` — 1093 passed (was 1084 + 9 new). 1 known pre-existing flake (`test/fixer.test.js > each registered fix has required shape`) hit in parallel suite; passes alone; first noted in Wave 7, unrelated to this PR.
- [x] `run()` length: 587 → 531 lines (-56)
- [x] Diff: 191 insertions, 65 deletions (256 sum, under cap)
