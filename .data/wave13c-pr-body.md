## Summary

Wave 13c — third phase of the `mcp-config.js` god-function decomposition. Pulls the `.claude/settings.json` scan + the CVE-2025-59536 compound detection out of `run()` into two named helpers:

- **`checkClaudeSettings(cwd, homedir) → { findings, autoApproveEnabled }`.** Scans both the project-level and homedir-level `.claude/settings.json` for `enableAllProjectMcpServers` (auto-approve CRITICAL) and for `hooks[*][*].command` matching `DANGEROUS_HOOK_PATTERNS` (CRITICAL). Returns the auto-approve flag so the compound check can reuse it without re-reading the JSON.
- **`checkCve2025_59536(hasRepoMcpJson, autoApproveEnabled) → findings`.** Pure flag-AND combinator: only emits when both conditions are true. Replaces a double-loop over the same `settingsPaths` that had to re-call `readJsonSafe` — that inefficiency went away naturally once the settings parse was hoisted into its own helper.

**`run()` shrinks from 475 to 417 lines (-58).** Combined Wave 13 a+b+c reduction: **587 → 417 (-170).** Behavior is bit-identical — same finding IDs, severities, evidence, learnMore URLs, settings-path order.

Wave 13d closes the decomposition with the hash-pinning + cross-client drift extractions.

Closes Complexity #1 (partial — only hash-pinning + drift remain), Complexity #3 (partial).

## Test plan

- [x] 7 new direct unit tests:
    - `checkClaudeSettings`: no-settings empty, `enableAllProjectMcpServers` CRITICAL + flag flip, curl-pipe-sh hook CRITICAL, benign hook silent pass-through
    - `checkCve2025_59536`: 3 combinator branches (only `(true, true)` fires)
- [x] All 118 existing mcp-config + hook-validation end-to-end tests still green
- [x] Full `npx vitest run` — 1112 passed (was 1105 + 7 new), 0 skipped, 0 failures (Wave 7 fixer flake hit once in parallel suite; passes alone, unrelated to this PR)
- [x] `run()` length: 475 → 417 lines (-58)
- [x] Diff: 180 insertions, 64 deletions (244 sum, under cap)
