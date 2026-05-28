## Summary

Wave 13b — second phase of the `mcp-config.js` god-function decomposition. Pulls the supply-chain block out of `run()` into three named helpers:

- **`extractPackageName(args)`** — pure utility. Walks the server args list, skips flags, matches the first arg shaped like a package spec, and strips any trailing `@version` while preserving the scope prefix for scoped packages. Returns `null` when no plausible package found.
- **`checkTyposquatCurated(name, packageName) → { findings, hadCuratedMatch }`** — offline detection against the hand-curated `KNOWN_MCP_SERVERS` list. Returns the curated-match flag so the registry check can skip a duplicate signal.
- **`checkTyposquatRegistry(name, packageName, registryResult, hadCuratedMatch) → findings`** — online detection against the MCP registry mirror. Bails silently when no `packageName`, when curated already fired, or when the registry fetch produced no usable server list.

**`run()` shrinks from 531 to 475 lines (-56).** Combined Wave 13 a+b reduction: **587 → 475 (-112).** Behavior is bit-identical — same finding IDs, severities, evidence, learnMore URLs.

Wave 13c will tackle settings/hooks + CVE-2025-59536 compound; 13d closes with hash-pinning + cross-client drift.

Closes Complexity #1 (partial), Complexity #3 (partial).

## Test plan

- [x] 11 new direct unit tests:
    - `extractPackageName`: first-non-flag pick, scoped `@version` strip, `null` when empty/all-flags, defensive non-string skip
    - `checkTyposquatCurated`: null pkg, known pkg (no finding), 1-edit match (WARNING + flag flip)
    - `checkTyposquatRegistry`: null pkg, `hadCuratedMatch` skip, empty/null registry servers, 1-edit match (CRITICAL)
- [x] All 98 existing mcp-config-related end-to-end tests still green
- [x] Full `npx vitest run` — 1105 passed (was 1093 + 11 new + 1 transient flake recovered), 0 skipped, 0 failures
- [x] `run()` length: 531 → 475 lines (-56)
- [x] Diff: 145 insertions, 61 deletions (206 sum, under cap)
