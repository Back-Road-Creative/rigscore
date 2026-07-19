import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';

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
    //
    // WINDOWS gets 3x. That headroom note was written when the matrix was
    // ubuntu + macOS; process spawn on the windows runners is several times
    // slower, and the tests that spawn hardest (baseline, order-determinism,
    // spec-goals — all of which fork `git` and the CLI repeatedly) are the
    // three slowest files in the suite on a HEALTHY windows run: 25.5s / 11.3s
    // / 10.7s per file against a 10s PER-TEST limit. A routine runner slowdown
    // therefore times them out with no code change — measured on main @1c8cb5e,
    // where those exact three files failed on 6 timeouts (zero assertion
    // failures) and a plain re-run of the same commit went green.
    //
    // The windows legs are BLOCKING as of the ci.yml change, so a flaky red
    // there costs a --force on every merge, which is what that change removed.
    // Scaling only the windows number keeps genuine hangs failing fast on the
    // platforms where 10s is honest.
    testTimeout: isWindows ? 30000 : 10000,
    // Same reasoning: two of the six timeouts on that run were `Hook timed out
    // in 10000ms` (vitest's default), not test bodies — the beforeEach hooks in
    // those files mint git fixtures.
    hookTimeout: isWindows ? 30000 : 10000,
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
