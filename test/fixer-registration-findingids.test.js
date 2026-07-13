import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findApplicableFixes } from '../src/fixer.js';
import { loadChecks, getRegisteredFixes } from '../src/checks/index.js';

// Tests the registration contract at src/checks/index.js: fixers may declare
// EITHER a `match` function OR a `findingIds` array. The newer fixer dispatch
// in src/fixer.js supports both, but the loader previously required `match` —
// dropping findingIds-only fixers at load time.
//
// The fixture check module lives in a throwaway temp dir handed to loadChecks
// via `extraCheckDirs`. It must NEVER be written into src/checks: that is a
// real source directory other suites readdir() concurrently (vitest runs test
// files in parallel), and a fixture landing there raced them red.

const FIXTURE_ID = '__fixer-registration-findingids-fixture';
let fixtureDir;

// A check module that exports a `fixes` array where the fix has ONLY
// findingIds + apply (no `match` function). Under the old registration guard
// this fixer is silently dropped and never reaches the dispatcher.
const fixtureSource = `
export const fixes = [
  {
    id: 'mock-finding-ids-only',
    findingIds: ['mock/no-match'],
    description: 'Test fixer with findingIds only — no match function',
    async apply() {
      return true;
    },
  },
];

export default {
  id: '${FIXTURE_ID}',
  enforcementGrade: 'mechanical',
  name: 'Fixer registration fixture (test-only)',
  category: 'governance',
  async run() {
    return { score: 100, findings: [] };
  },
};
`;

describe('fixer registration accepts findingIds-only fixers', () => {
  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-fixer-reg-'));
    // Without a type:module manifest Node parses a .js file under os.tmpdir()
    // as CommonJS and the ESM check module fails to import.
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(fixtureDir, `${FIXTURE_ID}.js`), fixtureSource);
    await loadChecks({ extraCheckDirs: [fixtureDir] });
  });

  afterAll(async () => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    // Re-run loadChecks so subsequent tests start from the clean registry.
    await loadChecks();
  });

  it('registers a fix that declares findingIds without a match function', () => {
    const registered = getRegisteredFixes();
    expect(registered['mock-finding-ids-only']).toBeDefined();
    expect(registered['mock-finding-ids-only'].findingIds).toEqual(['mock/no-match']);
    expect(typeof registered['mock-finding-ids-only'].apply).toBe('function');
  });

  it('findApplicableFixes resolves a findingIds-only fixer by finding.findingId', () => {
    const results = [{
      id: FIXTURE_ID,
      findings: [{
        findingId: 'mock/no-match',
        severity: 'warning',
        title: 'Whatever — title is irrelevant when findingId matches',
      }],
    }];
    const fixes = findApplicableFixes(results);
    expect(fixes.some((f) => f.id === 'mock-finding-ids-only')).toBe(true);
  });
});
