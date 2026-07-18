import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', 'README.md');

// AG-5 — "runs in any CI" docs. The CI Integration section must not read as
// GitHub-only: it documents a platform-agnostic recipe (exit-code contract +
// the --ci / --sarif / --fail-under flags) and ships a GitLab CI example next
// to the existing GitHub Action one.
describe('README CI Integration — runs in any CI', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const section = (readme.match(/^## CI Integration[\s\S]*?(?=^## )/m) || [''])[0];

  it('has a CI Integration section', () => {
    expect(section).not.toBe('');
  });

  it('documents a generic exit-code contract with the real CI flags', () => {
    const lower = section.toLowerCase();
    expect(lower).toContain('exit code');
    // Real flags (grounded in bin/rigscore.js) — not invented.
    expect(section).toContain('--ci');
    expect(section).toContain('--sarif');
    expect(section).toContain('--fail-under');
    // The gate branches on 0 vs 1.
    expect(section).toMatch(/\b0\b[\s\S]*\b1\b/);
  });

  it('ships a GitLab CI example next to the GitHub Action one', () => {
    const lower = section.toLowerCase();
    expect(lower).toContain('github');
    expect(lower).toContain('gitlab');
    // A concrete GitLab pipeline file, not just a passing mention.
    expect(lower).toContain('gitlab-ci');
  });

  it('signals it is not GitHub-only (any CI)', () => {
    expect(section.toLowerCase()).toMatch(/any ci|other ci|generic ci|platform|agnostic/);
  });

  it('does not name a third-party competitor scanner in the CI copy', () => {
    const lower = section.toLowerCase();
    // "github"/"gitlab" are CI platforms and fine; competitor scanners are not.
    expect(lower).not.toContain('snyk');
    expect(lower).not.toContain('semgrep');
  });
});
