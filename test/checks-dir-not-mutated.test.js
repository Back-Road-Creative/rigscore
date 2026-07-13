import {
  describe, it, expect, afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadChecks, getRegisteredFixes } from '../src/checks/index.js';

// src/checks/ is a SHARED SOURCE directory: test/verify-docs-ruleids.test.js
// readdir()s it and asserts every module there emits a ruleId. A suite that
// wrote a throwaway check module into it (to exercise the loader) raced that
// reader — vitest runs test FILES in parallel — and turned unrelated PRs red.
// loadChecks({ extraCheckDirs }) is the seam that lets a caller register a
// check module from anywhere; these tests hold the seam, and the invariant it
// protects, in place.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CHECKS = path.join(REPO, 'src', 'checks');

const tempDirs = [];
afterAll(() => tempDirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const FIXTURE_ID = '__extra-check-dir-fixture';
const FIXTURE_SOURCE = `
export const fixes = [{
  id: '${FIXTURE_ID}-fix',
  findingIds: ['${FIXTURE_ID}/x'],
  description: 'Fixture fixer registered from an injected dir',
  async apply() { return true; },
}];

export default {
  id: '${FIXTURE_ID}',
  enforcementGrade: 'mechanical',
  name: 'Injected check dir fixture (test-only)',
  category: 'governance',
  async run() { return { score: 100, findings: [] }; },
};
`;

/** A throwaway check dir outside the repo. */
function tempCheckDir(id, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-extra-checks-'));
  tempDirs.push(dir);
  // Without a type:module manifest Node parses a .js file under os.tmpdir()
  // as CommonJS and the ESM check module fails to import.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, `${id}.js`), source);
  return dir;
}

describe('loadChecks({ extraCheckDirs }) — register a check without touching src/checks', () => {
  it('loads the module and its fixes from an injected dir, leaving src/checks untouched', async () => {
    const before = fs.readdirSync(CHECKS).sort();
    const dir = tempCheckDir(FIXTURE_ID, FIXTURE_SOURCE);

    const checks = await loadChecks({ extraCheckDirs: [dir] });

    expect(checks.some((c) => c.id === FIXTURE_ID)).toBe(true);
    expect(getRegisteredFixes()[`${FIXTURE_ID}-fix`]).toBeDefined();
    expect(fs.readdirSync(CHECKS).sort()).toEqual(before);
  });

  it('defaults to src/checks alone when no extra dirs are passed', async () => {
    const checks = await loadChecks();
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.id === FIXTURE_ID)).toBe(false);
  });

  it('src/checks holds only git-tracked modules — no suite leaves a fixture behind', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', 'src/checks'], { cwd: REPO, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((p) => path.basename(p)),
    );
    const strays = fs.readdirSync(CHECKS).filter((f) => f.endsWith('.js') && !tracked.has(f));
    expect(strays, `untracked modules in src/checks: ${strays.join(', ')}`).toEqual([]);
  });
});
