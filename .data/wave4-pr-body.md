## Summary

Five narrow security gaps from the 2026-05-27 health report. Wave 4 of the fix plan; touches `src/checks/mcp-config.js` and must land before Wave 13's god-function decomposition.

1. **`mcp-config` checkNpmRegistry — unbounded response buffer.** Buffered the entire npm registry response into a string with no upper bound. A hung connection, a compressed-and-bombed metadata blob, or a malicious redirect target could feed unbounded bytes until the 5s timeout fired (or OOM, on a long-running CI run). Adds `MAX_REGISTRY_BYTES = 512KB`, byte counter per chunk, `req.destroy()` + resolve null on cap trip. Exports `checkNpmRegistry` with injectable `httpGet`/`maxBytes` so the abort path is testable.

2. **CVE co-disclosure documented (no URL change).** The Checkpoint URL referenced for the CVE-2026-21852 (`ANTHROPIC_BASE_URL` redirect) finding has a slug naming CVE-2025-59536 — initially read as a mismatch in the audit. Actually a co-disclosure post covering both CVEs, asserted by existing test `correctness-bugs T3.14d`. Adds an inline comment so future readers don't repeat the "fix" attempt.

3. **`deep-secrets` raw-regex-source leak.** Finding `detail` was `Pattern: ${result.pattern.source.slice(0, 30)}...` — raw KEY_PATTERNS regex source dumped into SARIF / CI logs. The slice changed whenever a pattern was tightened, making finding bodies unstable across upgrades. Replaced with `labelForPattern(pattern)` → stable provider-name map. New test asserts every KEY_PATTERN has a mapped label so a future pattern addition can't silently regress to "credential".

4. **`mcp-registry` XDG_CACHE_HOME sanitization.** `getDefaultCachePath` accepted any `XDG_CACHE_HOME` value without validation — an attacker who can set env for the rigscore process could redirect the cache write to `/etc/rigscore-cache` or escape via `..`. Resolves homedir + candidate; accepts only paths equal to homedir or under `homedir + sep`; falls back to `~/.cache` otherwise.

5. **`http` strict `https://` prefix.** `url.startsWith('https')` matched `httpsfoo://attacker` and other near-protocol typos, falling through to plain HTTP. Tightened to `'https://'` in `fetchHeaders`, `fetchBody`, and `probeStatus`.

Closes Security #1 (warning), #2 (uncertain), #3 (info), #4 (info), #5 (info).

## Test plan

- [x] New `test/mcp-config.test.js`: stubbed `httpGet` emits 160KB across 4 chunks against a 100-byte cap; asserts `req.destroy` called and result is null
- [x] New `test/deep-secrets.test.js`: finding detail equals `"Detected provider: AWS access key"` (not regex source); separate test asserts `labelForPattern` returns a non-fallback label for every entry in `KEY_PATTERNS`
- [x] Existing `correctness-bugs T3.14d` (Checkpoint URL referenced in both files) still passes
- [x] Full `npx vitest run` — 1047 passed (was 1043), 2 skipped, 0 failures
- [x] Diff: 149 insertions, 13 deletions (162 sum, under 300 cap)
