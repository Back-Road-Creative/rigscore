import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scan, runChecks } from '../src/scanner.js';
import { WEIGHTS } from '../src/constants.js';
import { withTmpDir } from './helpers.js';

/**
 * A check disabled via `.rigscorerc.json` (`checks.disabled`) is implemented
 * as weight 0 by `resolveWeights` (src/config.js). The runner used to stamp
 * `result.weight` from the STATIC `WEIGHTS` map, so a disabled check still
 * rendered on its own line at its full static weight (e.g. `6/6`) even though
 * it contributed nothing to the score.
 *
 * These tests pin the resolved weight all the way through `scan()` — for both
 * the pass-1 and the pass-2 runner call-sites — while locking the
 * backward-compatible static fallback for direct `runChecks` consumers that
 * pass no resolved map.
 */

// `claude-md` is a pass-1 check; `coherence` is a pass-2 check. Disabling one
// of each proves BOTH runChecks call-sites in scanner.js get resolved weights.
const DISABLED_PASS1 = 'claude-md';
const DISABLED_PASS2 = 'coherence';
const KEPT = 'mcp-config';

/** Build a minimal scannable project that disables two checks. */
async function withDisabledFixture(callback) {
  await withTmpDir(async (dir) => {
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'disabled-fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project\n\nGovernance.\n');
    fs.writeFileSync(
      path.join(project, '.rigscorerc.json'),
      JSON.stringify({ checks: { disabled: [DISABLED_PASS1, DISABLED_PASS2] } }),
    );
    await callback({ project, home });
  });
}

const byId = (results, id) => results.find((r) => r.id === id);

describe('runner stamps RESOLVED weights (disabled checks land at 0)', () => {
  it('a check disabled in .rigscorerc.json reports weight 0, not its static weight', async () => {
    await withDisabledFixture(async ({ project, home }) => {
      const { results } = await scan({ cwd: project, homedir: home });

      const disabled = byId(results, DISABLED_PASS1);
      expect(disabled, `${DISABLED_PASS1} should still run and render`).toBeDefined();
      // Guard the premise: this check has a non-zero static weight, so a
      // static-map regression is genuinely distinguishable from the fix.
      expect(WEIGHTS[DISABLED_PASS1]).toBeGreaterThan(0);
      expect(disabled.weight).toBe(0);
    });
  });

  it('the pass-2 runChecks call-site also gets resolved weights', async () => {
    await withDisabledFixture(async ({ project, home }) => {
      const { results } = await scan({ cwd: project, homedir: home });

      const disabled = byId(results, DISABLED_PASS2);
      expect(disabled, `${DISABLED_PASS2} is a pass-2 check and should render`).toBeDefined();
      expect(WEIGHTS[DISABLED_PASS2]).toBeGreaterThan(0);
      expect(disabled.weight).toBe(0);
    });
  });

  it('checks that are NOT disabled keep their configured weight', async () => {
    await withDisabledFixture(async ({ project, home }) => {
      const { results } = await scan({ cwd: project, homedir: home });

      const kept = byId(results, KEPT);
      expect(kept).toBeDefined();
      expect(kept.weight).toBe(WEIGHTS[KEPT]);
    });
  });

  it('an explicit weight override in .rigscorerc.json reaches result.weight', async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, 'home');
      const project = path.join(dir, 'project');
      fs.mkdirSync(home);
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'package.json'), '{"name":"w","version":"1.0.0"}');
      fs.writeFileSync(
        path.join(project, '.rigscorerc.json'),
        JSON.stringify({ weights: { [KEPT]: 3 } }),
      );

      const { results } = await scan({ cwd: project, homedir: home });
      expect(byId(results, KEPT).weight).toBe(3);
    });
  });
});

describe('runChecks backward compatibility (no resolved map supplied)', () => {
  const context = { cwd: '/tmp', homedir: '/tmp' };
  const mkCheck = (id, over = {}) => ({
    id,
    name: id,
    category: 'test',
    async run() {
      return { score: 100, findings: [] };
    },
    ...over,
  });

  it('falls back to the static WEIGHTS map when called directly', async () => {
    const results = await runChecks([mkCheck(DISABLED_PASS1)], context);
    expect(results[0].weight).toBe(WEIGHTS[DISABLED_PASS1]);
  });

  it('falls back to check.weight for plugin ids absent from WEIGHTS', async () => {
    const results = await runChecks([mkCheck('rigscore-plugin-x', { weight: 7 })], context);
    expect(results[0].weight).toBe(7);
  });

  it('honors an explicitly supplied resolved map, including a 0 entry', async () => {
    const resolvedWeights = { [DISABLED_PASS1]: 0, 'rigscore-plugin-x': 0 };
    const results = await runChecks(
      [mkCheck(DISABLED_PASS1), mkCheck('rigscore-plugin-x', { weight: 7 })],
      context,
      { resolvedWeights },
    );
    expect(results.map((r) => r.weight)).toEqual([0, 0]);
  });

  it('applies the resolved map on the invalid-shape branch', async () => {
    const bad = mkCheck(DISABLED_PASS1, { async run() { return { score: 'nope' }; } });
    const results = await runChecks([bad], context, {
      resolvedWeights: { [DISABLED_PASS1]: 0 },
    });
    expect(results[0].weight).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
  });

  it('applies the resolved map on the rejected-promise branch', async () => {
    const boom = mkCheck(DISABLED_PASS1, {
      async run() { throw new Error('boom'); },
    });
    const results = await runChecks([boom], context, {
      resolvedWeights: { [DISABLED_PASS1]: 0 },
    });
    expect(results[0].weight).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
  });
});
