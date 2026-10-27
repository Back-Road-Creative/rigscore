import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';

// release.yml publishes to npm with trusted publishing (OIDC): no stored token,
// the publish step runs after the tests and after the GitHub release.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const raw = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const job = YAML.parse(raw).jobs.release;
const steps = job.steps;
const idx = (re) => steps.findIndex((s) => re.test(s.run || '') || re.test(s.name || ''));

describe('release.yml — npm trusted publishing', () => {
  it('grants id-token: write and keeps the existing permissions', () => {
    expect(job.permissions['id-token']).toBe('write');
    for (const k of ['contents', 'actions', 'pull-requests']) {
      expect(job.permissions[k]).toBe('write');
    }
  });

  it('points setup-node at the npm registry', () => {
    const node = steps.find((s) => /actions\/setup-node/.test(s.uses || ''));
    expect(node.with['registry-url']).toBe('https://registry.npmjs.org');
  });

  it('pins an npm CLI that supports trusted publishing (>= 11.5.1)', () => {
    const m = raw.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)\b/);
    expect(m, 'no exact `npm install -g npm@X.Y.Z`').not.toBeNull();
    const [maj, min, pat] = m.slice(1).map(Number);
    expect(maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1)))).toBe(true);
  });

  it('publishes after the test step and the GitHub release, skipping an existing version', () => {
    const test = idx(/^npm test$/);
    const release = idx(/gh release create/);
    const publish = idx(/npm publish --access public/);
    expect(test).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(test);
    expect(publish).toBeGreaterThan(release);
    expect(steps[publish].run).toMatch(/npm view "?rigscore@\$\{?VERSION\}?"? version/);
  });

  it('does not use a long-lived npm token', () => {
    expect(raw).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });
});
