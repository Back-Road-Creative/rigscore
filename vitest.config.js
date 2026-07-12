import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude vitest defaults plus agent worktrees. Parallel-agent runs
    // (Agent isolation:"worktree") create `.claude/worktrees/agent-*/`
    // clones of the repo; vitest's default glob walks into them and
    // discovers every test file N+1 times. The harness never auto-unlocks
    // these post-merge, so the inflation compounds across sessions.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '.claude/worktrees/**',
    ],
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
      // 75% line coverage floor. Actual coverage at the time of writing is
      // 84.7% lines (91 test files / 1157 tests), so the floor sits ~10
      // points under the real number. That buffer is deliberate: it absorbs
      // per-run variance across the Node 18/20/22 x ubuntu/macOS CI matrix
      // (platform-gated branches leave a few lines unexecuted on any single
      // leg) while still failing on a genuine regression. The previous 40%
      // floor was 45 points of slack — it could not catch anything.
      // If a legitimate change drops coverage below 75, add tests; only
      // lower the floor with a stated reason.
      thresholds: {
        lines: 75,
      },
    },
  },
});
