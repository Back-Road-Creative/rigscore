import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 10s per test. The bulk of our suite is sub-second pure-function
    // unit tests; the long-pole are the spawn-based CLI integration
    // tests (test/error-handling.test.js, test/explain-subcommand.test.js,
    // test/mcp-runtime-hash.test.js) which fork a `node bin/rigscore.js`
    // child. Cold-start on CI macOS runners can take 2-3s; 10s leaves
    // generous headroom while still flagging genuine hangs.
    // Per-test override example:
    //   it('long-running case', { timeout: 30000 }, async () => { ... })
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      // 40% line coverage floor. Matches the historical baseline noted
      // in CLAUDE.md / project conventions. Raising the gate needs a
      // coordinated PR adding tests, not just bumping the number.
      thresholds: {
        lines: 40,
      },
    },
  },
});
