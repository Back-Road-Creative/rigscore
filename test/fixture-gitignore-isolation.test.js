import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');

// Walk test/fixtures/ for every .env file. Skip node_modules and dot-dirs
// inside fixtures (none today; future-proof).
function findFixtureEnvFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...findFixtureEnvFiles(full));
    } else if (entry.name === '.env') {
      out.push(full);
    }
  }
  return out;
}

// Regression test for PR #145 → #152 chain. An unanchored `.env` line in
// the repo-root .gitignore cascades to test/fixtures/**/.env via
// git check-ignore's parent-chain lookup, shadowing the env-exposure
// fixtures and turning every CI job red. Anchoring to `/.env` (PR #152)
// fixed it. This test pins the invariant: no fixture .env may be ignored
// by a rule outside test/fixtures/.
describe('test/fixtures .env files are not shadowed by ancestor .gitignore', () => {
  const envFiles = findFixtureEnvFiles(FIXTURES_ROOT);

  it('discovers at least one fixture .env (sanity)', () => {
    expect(envFiles.length).toBeGreaterThan(0);
  });

  it.each(envFiles)('%s is either not ignored, or ignored only by a fixture-local .gitignore', (file) => {
    const rel = path.relative(REPO_ROOT, file);
    const res = spawnSync('git', ['check-ignore', '-v', '--no-index', rel], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });

    // Exit 1 = not ignored. That's the green path.
    if (res.status === 1) return;

    // Exit 0 = ignored. Output format: "<source>:<line>:<pattern>\t<path>".
    // The source must live under test/fixtures/ — never the root .gitignore.
    expect(res.status).toBe(0);
    const source = res.stdout.split(':')[0];
    expect(
      source.startsWith('test/fixtures/'),
      `${rel} is ignored by ${source}, but only fixture-local .gitignore files may ignore fixture .env paths. ` +
        `Root .gitignore patterns cascading into test/fixtures/ break the env-exposure check (see PR #145 → #152).`,
    ).toBe(true);
  });
});
