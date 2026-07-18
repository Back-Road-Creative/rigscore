import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';

// Guards the meta / CI / packaging wave: windows CI leg, action.yml outputs +
// inputs + single-scan gate, changelog backfill/renumber, GitLab component,
// Homebrew formula, community-health files, SECURITY email fallback.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const parse = (rel) => YAML.parse(read(rel));

describe('CI — windows leg (RS-15)', () => {
  const ci = parse('.github/workflows/ci.yml');
  it('runs the suite on windows-latest', () => {
    expect(ci.jobs.test.strategy.matrix.os).toContain('windows-latest');
  });
});

describe('action.yml — outputs, inputs, single scan (RS-24)', () => {
  const action = parse('action.yml');
  const steps = action.runs.steps;

  it('declares score / grade / sarif-file outputs', () => {
    for (const k of ['score', 'grade', 'sarif-file']) {
      expect(action.outputs[k], `missing output ${k}`).toBeDefined();
    }
  });

  it('adds the missing inputs (path, check, baseline, ignore, online)', () => {
    for (const k of ['path', 'check', 'baseline', 'ignore', 'online']) {
      expect(action.inputs[k], `missing input ${k}`).toBeDefined();
    }
  });

  it('scans exactly once for the score/gate (a single --json scan)', () => {
    const jsonScans = steps.filter(
      (s) => typeof s.run === 'string' && /bin\/rigscore\.js/.test(s.run) && /--json/.test(s.run),
    );
    expect(jsonScans.length).toBe(1);
  });

  it('gates by reusing the scan exit code, not a second full scan', () => {
    const gate = steps.find((s) => s.name === 'Enforce threshold');
    expect(gate).toBeDefined();
    expect(gate.run).toMatch(/steps\.scan\.outputs\.exit-code/);
    // The gate itself must not re-run the scanner.
    expect(gate.run).not.toMatch(/bin\/rigscore\.js/);
  });
});

describe('changelog backfill + renumber (RS-4)', () => {
  const files = readdirSync(join(repoRoot, 'changelog.d'));
  it('backfills the post-2.1.0 user-visible PRs', () => {
    for (const id of ['326', '327', '328', '329', '353']) {
      expect(files.some((f) => f.startsWith(`${id}.`)), `missing changelog.d/${id}.*`).toBe(true);
    }
  });
  it('renumbers the mislabeled 347 fragment to 354 (its real PR)', () => {
    expect(files).toContain('354.added.md');
    expect(files).not.toContain('347.added.md');
  });
  it('CHANGELOG no longer points at the deleted enforcement-grade plan', () => {
    expect(read('CHANGELOG.md')).not.toContain('enforcement-grade-classification.md');
  });
});

describe('husky wiring (RS-4)', () => {
  const pkg = JSON.parse(read('package.json'));
  it('husky is a devDependency and prepare wires the hook', () => {
    expect(pkg.devDependencies.husky).toBeDefined();
    expect(pkg.scripts.prepare).toMatch(/husky/);
  });
});

describe('GitLab CI component (RS-25)', () => {
  const rel = 'templates/gitlab/rigscore.gitlab-ci.yml';
  it('ships a parseable component with spec inputs', () => {
    expect(existsSync(join(repoRoot, rel))).toBe(true);
    const docs = YAML.parseAllDocuments(read(rel));
    expect(docs.length).toBe(2);
    expect(docs[0].toJS().spec.inputs['fail-under']).toBeDefined();
  });
});

describe('Homebrew formula (RS-39)', () => {
  it('ships a formula pinned to a released tag + sha', () => {
    const f = read('Formula/rigscore.rb');
    expect(f).toMatch(/class Rigscore < Formula/);
    expect(f).toMatch(/archive\/refs\/tags\/v2\.1\.0\.tar\.gz/);
    expect(f).toMatch(/sha256 "[0-9a-f]{64}"/);
    expect(f).toMatch(/depends_on "node"/);
  });
  it('ships a prebuilt-archives release workflow', () => {
    const wf = parse('.github/workflows/prebuilt-binaries.yml');
    expect(wf.on.release.types).toContain('published');
  });
});

describe('community health + disclosure (RS-44, SECURITY)', () => {
  it('has CONTRIBUTING, CODE_OF_CONDUCT, and both issue templates', () => {
    for (const p of [
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
    ]) {
      expect(existsSync(join(repoRoot, p)), `missing ${p}`).toBe(true);
    }
  });
  it('SECURITY.md offers an email disclosure fallback', () => {
    expect(read('SECURITY.md')).toMatch(/[\w.]+@[\w.]+/);
  });
});
