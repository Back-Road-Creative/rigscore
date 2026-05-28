## Summary

Wave 12 Phase 2b — finishes the `skill-files.js` god-function decomposition started in P1 (`accumulatePatternMatches` / `forEachPatternMatch` primitives) and P2a (`checkInjection` / `checkShellExec` / `checkExfiltration`).

- **`checkUnicode(file)`** — bidi-override (CRITICAL), zero-width (WARNING), classic homoglyphs + modern prompt-injection ranges that NFKC-normalize to ASCII (WARNING). Returns 0-3 findings per file.
- **`checkPosixPermissions(file)`** — WARNING when a skill file has the others-write bit set. No-op on win32 (windows-security check covers that surface separately). Async because `statSafe` is async.

**`run()` shrinks from 318 → 248 lines (-70).** Combined Wave 12 reduction: **472 → 248 (-224 lines net).** The per-file body in `run()` is now a tight sequence of helper calls covering injection, shell-exec, exfiltration, escalation, persistence, indirect-injection, trust-exploitation, URL/base64, unicode, and POSIX permissions.

Behavior is bit-identical to pre-extraction. All skill-file end-to-end tests still pass.

Closes **Complexity #2** (fully resolved across Wave 12 P1 + P2a + P2b).

## Test plan

- [x] 5 new direct unit tests:
    - `checkUnicode`: bidi CRITICAL, zero-width WARNING, clean ASCII empty
    - `checkPosixPermissions`: mode 666 → world-writable WARNING; mode 644 → empty; both gated on non-win32
- [x] Full `npx vitest run` — 1084 passed (was 1079 + 5 new), 0 skipped, 0 failures
- [x] `run()` length verified — 248 lines (was 318 after P2a; 472 before P1)
- [x] Diff: 62 insertions, 74 deletions (136 sum, well under cap)
