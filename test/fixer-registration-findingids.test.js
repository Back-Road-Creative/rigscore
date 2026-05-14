import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApplicableFixes } from '../src/fixer.js';
import { loadChecks, getRegisteredFixes } from '../src/checks/index.js';

// Tests the registration contract at src/checks/index.js: fixers may declare
// EITHER a `match` function OR a `findingIds` array. The newer fixer dispatch
// in src/fixer.js supports both, but the loader previously required `match` —
// dropping findingIds-only fixers at load time.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checksDir = path.resolve(__dirname, '..', 'src', 'checks');
const FIXTURE_NAME = '__fixer-registration-findingids-fixture.js';
const fixturePath = path.join(checksDir, FIXTURE_NAME);

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
  id: '__fixer-registration-findingids-fixture',
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
    fs.writeFileSync(fixturePath, fixtureSource);
    await loadChecks();
  });

  afterAll(async () => {
    try {
      fs.unlinkSync(fixturePath);
    } catch {
      // best effort
    }
    // Re-run loadChecks so subsequent test files start from the clean registry.
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
      id: '__fixer-registration-findingids-fixture',
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
