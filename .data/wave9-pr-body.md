## Summary

`walkDirSafe` carried two near-identical inner functions: `walk()` (top-level entry; computed the resolved-inode key, checked it against `visited`, added it) and `walkUnder()` (called from the symlinked-dir branch; skipped the inode check because the caller had already added the resolved inode before recursing). The two bodies were ~40 lines of straight copy-paste; any future drift between their symlink handling, dotfile skip, or `skipDirs` allowlist would have been a silent finding-count divergence visible only via flaky fixture tests.

Merged via `walk(current, depth, { skipRootInode = false } = {})`. The symlinked-dir recursion now reads `walk(realPath, depth + 1, { skipRootInode: true })`. Net: -37 lines of source, one source of truth for the per-entry symlink/dir/file dispatch.

Closes Complexity #5 (`utils.js:321 walkUnder` near-duplicate).

Wave 9 of the fix plan — smaller, lower-risk refactor that establishes the "no-behavior-change under test" workflow before the bigger god-function decompositions in Waves 10 and beyond.

## Test plan

- [x] **New `test/walk.test.js`** pins the documented behaviors that previously lived implicitly across walk + walkUnder:
    - `skipHidden` default drops dot-dirs; `skipHidden: false` keeps them
    - `skipDirs` blocks named dirs regardless of hidden status
    - `maxFiles` caps file accumulation
    - symlink-to-dir is traversed via the `skipRootInode` branch; the same file appears exactly once with `loopDetected=true`
- [x] **Existing coverage stays green:**
    - `test/symlink-dos.test.js` (self-symlink cycle, criss-cross symlinks, maxDepth pathological nesting)
    - `test/deep-secrets.test.js` "respects maxFiles config"
    - `test/skill-files.test.js` symlink-cycle tolerance
- [x] **Full `npx vitest run`** — 1058 passed (was 1053 + 5 new walk tests), 0 skipped, 0 failures
- [x] Diff: 108 insertions, 56 deletions (164 sum); source-only delta is -37 lines
