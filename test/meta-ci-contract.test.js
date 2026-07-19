import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { readFragments, renderRelease } from '../scripts/assemble-changelog.js';

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

describe('changelog can fold (RS-4 follow-up)', () => {
  // This block used to pin specific fragment FILES by id (backfilled PRs
  // 326/327/328/329/353, and 347 renumbered to 354) — a one-time migration
  // check. Those assertions were self-defeating: `assemble-changelog --release`
  // deletes the fragments as it folds them into CHANGELOG.md, so the assertions
  // could only ever hold until the FIRST real release, then failed forever. That
  // silently made the repo unable to cut a release with folded notes without
  // reddening CI (the fragments piled up unfolded instead). Replaced with a test
  // of the property that actually matters and can't rot: that the current
  // changelog.d folds cleanly.
  it('renderRelease folds every changelog.d fragment without error', () => {
    const changelog = read('CHANGELOG.md');
    const fragments = readFragments(join(repoRoot, 'changelog.d'));
    // Pure function: returns the folded text, writes/deletes nothing — robust by
    // construction (no network, no filesystem mutation). Fails only if folding is
    // genuinely broken.
    const folded = renderRelease(changelog, fragments, '0.0.0-fold-check', '2026-01-01');
    expect(folded).toContain('## [0.0.0-fold-check] - 2026-01-01');
    // A fresh empty Unreleased section must remain for the next cycle.
    expect(folded).toContain('## [Unreleased]');
    // Every fragment's first content line must survive into the folded output —
    // proves fragments are folded IN, not dropped.
    for (const f of fragments) {
      const firstLine = f.body.split('\n').find((l) => l.trim());
      if (firstLine) expect(folded, `fragment ${f.file} dropped`).toContain(firstLine.trim());
    }
  });

  // There is intentionally NO "every fragment id maps to a real PR" assertion.
  // That needs the GitHub API (network → a flaky unit test) and even then cannot
  // catch the real RS-4 defect: a fragment numbered for a REAL but WRONG PR. The
  // structural guard is `assemble-changelog --check` (names/types/bodies);
  // correct PR attribution is a human-review property, not a static one.

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
