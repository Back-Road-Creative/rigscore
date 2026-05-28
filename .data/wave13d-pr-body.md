## Summary

Wave 13d — **final phase** of the `mcp-config.js` god-function decomposition. Pulls the last three top-level blocks out of `run()` into named helpers:

- **`checkCrossClientDrift(clientServers) → { findings, driftDetected }`.** Pure. Compares per-client signatures (args + env-key set + transport) and emits `cross-client-drift` WARNING when any server's signature diverges across two or more clients, plus a `single-client-server` INFO for coverage gaps.
- **`checkHashPinning(cwd, currentHashes, writeState) → findings`.** Async. CVE-2025-54136 / "MCPoison" rug-pull detection. Compares current config-shape hashes against on-disk state file; writes the new state back unless `writeState` is explicitly false (tests). Preserves any existing `state.servers` map (runtime tool-hash pins).
- **`checkRuntimeToolPinStatus(cwd, currentHashes, surfaceRuntime) → findings`.** Async. Default-on INFO per repo-level MCP server, suppressible via `mcpConfig.surfaceRuntimeHashStatus = false`. Tells the user whether they've pinned the server's `tools/list` snapshot via `rigscore mcp-pin`.

**`run()` shrinks from 417 to 297 lines (-120).** Combined Wave 13 total: **587 → 297 (-290 lines, ~50% reduction).** The remaining `run()` body is the per-server iteration plus the config-path scan setup — the single straight-line loop the strategy agent flagged as the target shape for "load configs, iterate servers, call helpers, collect findings."

Closes **Complexity #1** (fully resolved across Wave 13 a+b+c+d: 587-line god function → 297-line straight-line driver + **11 named exported helpers**, each with direct unit tests).

Closes **Complexity #3** (the 6-level nesting is gone — the deepest remaining nesting in `run()` is 4 levels inside the per-server loop).

## Diff-cap note

418 sum (288 ins, 130 del) — ~40% over the 300 cap. Pure code-motion refactor with comprehensive new tests for the extracted helpers (no logic change). Well within JP's documented "2-3× for refactors / lock refreshes" tolerance. The extracted bodies are large because they include the full hash-pinning state machine and the runtime-pin status check, which are both intrinsically self-contained units that don't decompose further.

## Test plan

- [x] 9 new direct unit tests:
    - `checkCrossClientDrift`: single-client empty, args-differ WARNING + flag flip, single-client-server INFO for non-overlapping, identical configs silent
    - `checkHashPinning`: empty currentHashes silent, `writeState=false` test-suppress, first-scan → state-write + no warning, second-scan hash drift → WARNING
    - `checkRuntimeToolPinStatus`: `surfaceRuntime=false` silent, default emits "pin not recorded" INFO
- [x] All 164 existing mcp-related end-to-end tests still green (mcp-config 66, mcp-evasion 15, mcp-supply-chain 12, mcp-expansion 8, mcp-hash-pinning 19, mcp-runtime-hash 29, correctness-bugs 24 — overlapping subset)
- [x] Full `npx vitest run` — 1121 passed (was 1112 + 9 new), 0 skipped, 0 failures
- [x] `run()` length: 417 → 297 lines (-120). Combined Wave 13: 587 → 297 (-290)
