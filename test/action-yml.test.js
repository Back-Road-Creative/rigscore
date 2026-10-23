import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as YAML from 'yaml';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Resolve action.yml relative to this test file (repo root / action.yml)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const actionYmlPath = path.resolve(__dirname, '..', 'action.yml');

const rawAction = readFileSync(actionYmlPath, 'utf8');
const action = YAML.parse(rawAction);

function flattenSteps(action) {
  if (!action?.runs?.steps || !Array.isArray(action.runs.steps)) return [];
  return action.runs.steps;
}

describe('action.yml — GitHub composite action distribution', () => {
  describe('T1.1: does not install stale rigscore from npm', () => {
    it('does not contain the string "npm install -g rigscore"', () => {
      expect(rawAction).not.toMatch(/npm\s+install\s+-g\s+rigscore/);
    });

    it('does not contain any step running "npm install" for rigscore globally', () => {
      const steps = flattenSteps(action);
      for (const step of steps) {
        if (typeof step.run === 'string') {
          // Allow npm ci/npm install for local deps, but never -g rigscore
          expect(step.run).not.toMatch(/npm\s+install\s+-g\s+rigscore/);
        }
      }
    });

    it('does not invoke a globally-installed `rigscore` binary (only the checked-out source)', () => {
      const steps = flattenSteps(action);
      for (const step of steps) {
        if (typeof step.run !== 'string') continue;
        // A line that starts with "rigscore " (bare global binary invocation) is forbidden.
        // We allow "node bin/rigscore.js ..." and "npx ... rigscore ..." forms.
        const lines = step.run.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (/^rigscore\s/.test(trimmed) || trimmed === 'rigscore') {
            throw new Error(
              `action.yml step "${step.name}" invokes the global rigscore binary: "${trimmed}". ` +
              `Use "node bin/rigscore.js" or equivalent source-based invocation instead.`
            );
          }
        }
      }
    });
  });

  describe('T1.2: installs rigscore from the GitHub source at the action ref', () => {
    it('has a checkout step that clones the rigscore repo at the current action ref', () => {
      const steps = flattenSteps(action);
      const checkoutSteps = steps.filter(s =>
        typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@')
      );
      // At least one checkout step that targets the rigscore repo (self).
      // Because composite actions don't have access to the caller's checkout of
      // the action source, we must explicitly check out this repo.
      const selfCheckouts = checkoutSteps.filter(s => {
        const w = s.with || {};
        // repository: Back-Road-Creative/rigscore (or equivalent); ref anchored to the action.
        return typeof w.repository === 'string' && /rigscore/i.test(w.repository);
      });
      expect(selfCheckouts.length).toBeGreaterThanOrEqual(1);
    });

    it('installs dependencies from the checked-out source via npm ci', () => {
      const steps = flattenSteps(action);
      const hasNpmCi = steps.some(s =>
        typeof s.run === 'string' && /\bnpm\s+ci\b/.test(s.run)
      );
      expect(hasNpmCi).toBe(true);
    });

    it('invokes rigscore via "node bin/rigscore.js" using the checked-out source', () => {
      const steps = flattenSteps(action);
      const hasNodeInvocation = steps.some(s =>
        typeof s.run === 'string' && /node\s+[^\s]*bin\/rigscore\.js/.test(s.run)
      );
      expect(hasNodeInvocation).toBe(true);
    });

    it('pins the self-checkout ref to the action-invoking ref (github.action_ref or equivalent)', () => {
      const steps = flattenSteps(action);
      const selfCheckouts = steps.filter(s =>
        typeof s.uses === 'string' &&
        s.uses.startsWith('actions/checkout@') &&
        typeof s.with?.repository === 'string' &&
        /rigscore/i.test(s.with.repository)
      );
      expect(selfCheckouts.length).toBeGreaterThanOrEqual(1);
      // The self-checkout should anchor to the action's own ref so the user
      // gets exactly the version they pinned (e.g. @v0.8.0 → v0.8.0 source).
      for (const step of selfCheckouts) {
        const ref = step.with?.ref;
        expect(ref, `step "${step.name}" should pin a ref`).toBeDefined();
        // Accept github.action_ref (preferred), github.ref, or a literal sha/ref.
        expect(
          /github\.action_ref|github\.sha|github\.ref/.test(String(ref)) || /^[A-Za-z0-9._\-\/]+$/.test(String(ref))
        ).toBe(true);
      }
    });
  });

  describe('T1.3: documented action refs satisfy the action.yml semver guard', () => {
    // The guard in action.yml rejects any github.action_ref that is not an exact
    // vX.Y.Z tag (no moving @v1 / @v2 major tag is published, and a floating ref
    // is re-pointable — the exact supply-chain drift the guard exists to stop).
    // Extract that regex from action.yml itself rather than restating it, so the
    // docs are checked against the live guard and cannot drift from it.
    const guardMatch = rawAction.match(/grep\s+-Eq\s+'(\^v\[0-9\][^']*)'/);

    it('action.yml still contains an extractable semver guard', () => {
      expect(
        guardMatch,
        'could not find the ACTION_REF semver guard in action.yml — update this test if the guard moved',
      ).not.toBeNull();
    });

    it('every rigscore action ref shown in the docs is an exact semver tag', () => {
      const semverRe = new RegExp(guardMatch[1]);

      const docFiles = ['README.md'];
      const docsDir = path.resolve(__dirname, '..', 'docs');
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md')) docFiles.push(path.relative(path.resolve(__dirname, '..'), full));
        }
      };
      walk(docsDir);

      const offenders = [];
      for (const rel of docFiles) {
        const body = readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
        const lines = body.split('\n');
        lines.forEach((line, i) => {
          for (const m of line.matchAll(/Back-Road-Creative\/rigscore@([^\s`'"),]+)/g)) {
            const ref = m[1].replace(/[.,;:)]+$/, '');
            // Skip templated refs (e.g. `@v${version}` in a code sample) — those
            // are resolved at run time, not a literal ref a user would copy.
            if (ref.includes('$') || ref.includes('{')) continue;
            if (!semverRe.test(ref)) offenders.push(`${rel}:${i + 1}: @${ref}`);
          }
        });
      }

      expect(
        offenders,
        `These documented action refs would be rejected by the action.yml semver guard.\n` +
          `Pin the docs to an exact released tag (e.g. @v${pkg.version}):\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
    });
  });

  describe('structural sanity', () => {
    it('is a valid composite action', () => {
      expect(action.runs?.using).toBe('composite');
      expect(Array.isArray(action.runs?.steps)).toBe(true);
    });

    it('declares standard inputs (fail-under, profile, recursive, depth, deep, upload-sarif)', () => {
      const inputs = action.inputs || {};
      for (const key of ['fail-under', 'profile', 'recursive', 'depth', 'deep', 'upload-sarif']) {
        expect(inputs[key], `missing input: ${key}`).toBeDefined();
      }
    });
  });
});


describe('action.yml — job summary (UI-5)', () => {
  const steps = flattenSteps(action);
  const scanIdx = steps.findIndex((s) => s.id === 'scan');
  const summaryIdx = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('GITHUB_STEP_SUMMARY'));
  const summaryStep = steps[summaryIdx];

  it('has a summary step that runs after the scan and even when the scan failed', () => {
    expect(summaryIdx, 'no step writes to GITHUB_STEP_SUMMARY').toBeGreaterThan(scanIdx);
    expect(String(summaryStep.if)).toMatch(/always\(\)/);
  });

  it('runs before the threshold gate so a failing scan still reports', () => {
    const gateIdx = steps.findIndex((s) => s.name === 'Enforce threshold');
    expect(summaryIdx).toBeLessThan(gateIdx);
  });

  it('passes inputs through env, never interpolated into the script', () => {
    expect(summaryStep.run).not.toMatch(/\$\{\{/);
  });

  // Pull the embedded node program out of the step so it can be run against
  // fixture JSON exactly as the runner would run it.
  function runSummary(json, { exit = '0', failUnder = '70' } = {}) {
    const m = summaryStep.run.match(/<<'(\w+)'[^\n]*\n([\s\S]*?)\n\s*\1\n/);
    expect(m, 'summary step must embed its node program as a quoted heredoc').not.toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rigscore-summary-'));
    const jsonPath = path.join(dir, 'rigscore.json');
    const outPath = path.join(dir, 'summary.md');
    if (json !== null) writeFileSync(jsonPath, typeof json === 'string' ? json : JSON.stringify(json));
    const r = spawnSync(process.execPath, ['-'], {
      input: m[2],
      encoding: 'utf8',
      env: {
        ...process.env,
        RIGSCORE_JSON: jsonPath,
        SCAN_EXIT: exit,
        FAIL_UNDER: failUnder,
        GITHUB_STEP_SUMMARY: outPath,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  }

  const single = {
    score: 42,
    grade: 'D',
    results: [
      { id: 'mcp-config', name: 'MCP config', score: 20, findings: [
        { findingId: 'mcp-config/unpinned', severity: 'critical', title: 'MCP server is unpinned', remediation: 'Pin the version.' },
        { findingId: 'mcp-config/x', severity: 'info', title: 'Minor note' },
      ] },
      { id: 'git-hooks', name: 'Git hooks', score: 100, findings: [{ findingId: 'git-hooks/ok', severity: 'pass', title: 'Hooks fine' }] },
      { id: 'windows-security', name: 'Windows security', score: -1, findings: [] },
    ],
  };

  it('single project: headline, per-check table, and the finding with its id', () => {
    const md = runSummary(single, { exit: '1' });
    expect(md).toMatch(/^## rigscore/m);
    expect(md).toContain('42');
    expect(md).toContain('D');
    expect(md).toMatch(/below the threshold of 70|threshold.*70/i);
    expect(md).toContain('mcp-config');
    expect(md).toContain('mcp-config/unpinned');
    expect(md).toContain('MCP server is unpinned');
    expect(md).not.toContain('Hooks fine');
  });

  it('reports a pass when the gate passed', () => {
    const md = runSummary({ ...single, score: 95, grade: 'A' }, { exit: '0' });
    expect(md).toMatch(/pass/i);
  });

  it('recursive: one row per project plus the worst project', () => {
    const rec = {
      score: 60,
      grade: 'C',
      worstProject: { path: 'pkgs/b', score: 30 },
      projects: [
        { path: 'pkgs/a', score: 90, grade: 'A', results: [] },
        { path: 'pkgs/b', score: 30, grade: 'F', results: single.results },
        { path: 'pkgs/c', score: null, notApplicable: true, grade: 'n/a', results: [] },
      ],
    };
    const md = runSummary(rec, { exit: '1' });
    expect(md).toContain('pkgs/a');
    expect(md).toContain('pkgs/b');
    expect(md).toContain('pkgs/c');
    expect(md).toMatch(/worst/i);
    expect(md).toContain('mcp-config/unpinned');
  });

  it('crash or unparseable JSON: says the scan did not complete, still exits 0', () => {
    const md = runSummary('not json', { exit: '2' });
    expect(md).toMatch(/did not complete/i);
    expect(md).toContain('2');
  });

  it('missing JSON file: same, no throw', () => {
    const md = runSummary(null, { exit: '2' });
    expect(md).toMatch(/did not complete/i);
  });

  it('escapes markdown table breakers in finding text', () => {
    const evil = { ...single, results: [{ id: 'c', name: 'C', score: 10, findings: [
      { findingId: 'c/a', severity: 'warning', title: 'pipe | and\nnewline <b>' },
    ] }] };
    const md = runSummary(evil, { exit: '1' });
    expect(md).not.toContain('pipe | and');
    expect(md).not.toContain('<b>');
  });

  it('caps the finding list so a huge scan cannot blow the summary size limit', () => {
    const many = { score: 10, grade: 'F', results: [{ id: 'c', name: 'C', score: 0, findings:
      Array.from({ length: 500 }, (_, i) => ({ findingId: `c/f${i}`, severity: 'warning', title: `t${i}` })) }] };
    const md = runSummary(many, { exit: '1' });
    expect(md.length).toBeLessThan(60000);
    expect(md).toMatch(/more/i);
  });
});

describe('action.yml — input descriptions (UI-12)', () => {
  it('check input says what a valid value is and where to find ids', () => {
    const d = action.inputs.check.description;
    expect(d).toMatch(/check id/i);
    expect(d).toMatch(/comma/i);
    expect(d).toMatch(/docs\/checks/);
    expect(d).toMatch(/empty/i);
  });
});
