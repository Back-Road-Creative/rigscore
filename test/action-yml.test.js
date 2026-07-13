import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
