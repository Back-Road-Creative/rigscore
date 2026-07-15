import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChecks } from '../src/checks/index.js';
import { listPacks, loadPack } from '../src/cli/packs.js';
import { PROFILES } from '../src/config.js';
import { suppressFindings } from '../src/findings.js';

// These tests make a check-id rename FAIL LOUDLY in CI instead of silently
// dropping a pack recommendation, a profile weight, or a learnMore doc link.
// Each is an upstream gate on a cross-reference no single-module test can see.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function registeredCheckIds() {
  const checks = await loadChecks();
  return new Set(checks.map((c) => c.id));
}

describe('check-id rename safety', () => {
  it('F2-1: every pack.json checks[] id is a registered check id', async () => {
    const ids = await registeredCheckIds();
    for (const name of listPacks()) {
      const pack = loadPack(name);
      for (const id of pack.checks) {
        expect(ids.has(id), `pack "${name}" claims unknown check id "${id}"`).toBe(true);
      }
    }
  });

  it('F2-2: every PROFILES.minimal / .home key is a registered check id', async () => {
    const ids = await registeredCheckIds();
    for (const profile of ['minimal', 'home']) {
      for (const key of Object.keys(PROFILES[profile])) {
        expect(ids.has(key), `PROFILES.${profile} weights unknown check id "${key}"`).toBe(true);
      }
    }
  });

  it('F2-3: every hardcoded learnMore docs/checks URL points at a real docs file', () => {
    const checksDir = path.join(ROOT, 'src', 'checks');
    const docsDir = path.join(ROOT, 'docs', 'checks');
    const re = /blob\/main\/docs\/checks\/([a-z0-9-]+)\.md/g;
    const referenced = new Set();
    for (const file of fs.readdirSync(checksDir)) {
      if (!file.endsWith('.js') || file === 'index.js') continue;
      const body = fs.readFileSync(path.join(checksDir, file), 'utf-8');
      for (const m of body.matchAll(re)) referenced.add(m[1]);
    }
    // Guard against a vacuous pass if the pattern ever stops matching.
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(fs.existsSync(path.join(docsDir, `${id}.md`)),
        `learnMore links docs/checks/${id}.md but that file does not exist`).toBe(true);
    }
  });
});

describe('suppress drift safety', () => {
  const findings = () => [
    { id: 'docker-security', score: 0, findings: [
      { findingId: 'docker-security/root-user', severity: 'warning', title: 'Running as root' },
    ] },
  ];

  it('F2-4: reports suppress patterns that matched nothing', () => {
    const results = findings();
    const summary = suppressFindings(results, ['docker-security/root-user', 'typo/nonexistent']);
    expect(summary.count).toBe(1);
    expect(summary.unmatched).toEqual(['typo/nonexistent']);
  });

  it('F2-4: a matched pattern is never reported as unmatched', () => {
    const summary = suppressFindings(findings(), ['docker-security']);
    expect(summary.count).toBe(1);
    expect(summary.unmatched).toEqual([]);
  });

  it('F2-4: a renamed id keeps an old suppress pattern working (alias path)', () => {
    const results = findings(); // finding carries the CURRENT id 'docker-security/...'
    // User's rc still names the OLD id; the rename table maps it to the current one.
    const summary = suppressFindings(results, ['legacy-docker'], { 'legacy-docker': 'docker-security' });
    expect(summary.count).toBe(1);
    expect(summary.unmatched).toEqual([]);
  });
});
