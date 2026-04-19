import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as YAML from 'yaml';

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
