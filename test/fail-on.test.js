import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, countGateFindings } from '../src/index.js';
import { withTmpDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'rigscore.js');
const FIX = path.join(ROOT, 'test', 'fixtures');

function run(args, home) {
  return spawnSync('node', [BIN, ...args, '--no-state-write'], {
    encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', HOME: home },
  });
}

describe('parseArgs --fail-on', () => {
  it('defaults to no severity gate', () => {
    expect(parseArgs([]).failOn).toBe(null);
  });

  it('accepts critical and warning', () => {
    expect(parseArgs(['--fail-on', 'critical']).failOn).toBe('critical');
    expect(parseArgs(['--fail-on', 'warning']).failOn).toBe('warning');
    expect(parseArgs(['--fail-on', 'warning']).argError).toBe(null);
  });

  it('is case-insensitive', () => {
    expect(parseArgs(['--fail-on', 'WARNING']).failOn).toBe('warning');
  });

  it('an unknown severity is a fatal argError, never a silent no-gate', () => {
    const o = parseArgs(['--fail-on', 'info']);
    expect(o.argError).toMatch(/--fail-on requires critical or warning, got "info"/);
    expect(o.failOn).toBe(null);
  });

  it('a dangling --fail-on is fatal', () => {
    expect(parseArgs(['--fail-on']).argError).toMatch(/--fail-on requires/);
  });

  it('a typo of the flag gets a did-you-mean hint', () => {
    expect(parseArgs(['--fail-o', 'warning']).warnings.join('\n')).toMatch(/did you mean --fail-on/);
  });
});

describe('countGateFindings', () => {
  const unit = (...sev) => ({ results: [{ findings: sev.map((severity) => ({ severity })) }] });

  it('counts critical only for critical', () => {
    expect(countGateFindings([unit('critical', 'warning', 'info')], 'critical')).toBe(1);
  });

  it('counts warning and critical for warning', () => {
    expect(countGateFindings([unit('critical', 'warning', 'info', 'pass', 'skipped')], 'warning')).toBe(2);
  });

  it('spans units and ignores a null level', () => {
    expect(countGateFindings([unit('warning'), unit('warning')], 'warning')).toBe(2);
    expect(countGateFindings([unit('critical')], null)).toBe(0);
  });
});

describe('--fail-on exit code (end-to-end)', () => {
  const WARN_ONLY = ['docker-run-unsafe', '--check', 'docker-security'];

  it('baseline: a warning-only scan passes when --fail-under is 0', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, WARN_ONLY[0]), ...WARN_ONLY.slice(1), '--fail-under', '0'], home);
      expect(res.status).toBe(0);
    });
  });

  it('--fail-on warning exits 1 on a warning-only scan that clears the score gate', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, WARN_ONLY[0]), ...WARN_ONLY.slice(1), '--fail-under', '0', '--fail-on', 'warning'], home);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/rigscore: FAIL \d+ finding\(s\) at warning or worse \(--fail-on warning\)/);
    });
  });

  it('--fail-on critical exits 0 when the scan has warnings but no critical', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, WARN_ONLY[0]), ...WARN_ONLY.slice(1), '--fail-under', '0', '--fail-on', 'critical'], home);
      expect(res.status).toBe(0);
    });
  });

  it('--fail-on critical exits 1 when a critical finding exists', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, 'env-exposed'), '--fail-under', '0', '--fail-on', 'critical'], home);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/--fail-on critical/);
    });
  });

  it('an invalid severity exits 2', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, 'docker-run-unsafe'), '--fail-on', 'bogus'], home);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/rigscore: --fail-on requires critical or warning/);
    });
  });

  it('--recursive honours --fail-on', async () => {
    await withTmpDir(async (home) => {
      await withTmpDir(async (root) => {
        fs.mkdirSync(path.join(root, 'a'));
        fs.copyFileSync(path.join(FIX, 'docker-run-unsafe', 'Dockerfile'), path.join(root, 'a', 'Dockerfile'));
        const plain = run([root, '--recursive', '--fail-under', '0', '--check', 'docker-security'], home);
        expect(plain.status).toBe(0);
        const gated = run([root, '--recursive', '--fail-under', '0', '--check', 'docker-security', '--fail-on', 'warning'], home);
        expect(gated.status).toBe(1);
        expect(gated.stderr).toMatch(/--fail-on warning/);
      });
    });
  });

  it('--json output is still emitted when the severity gate fails', async () => {
    await withTmpDir(async (home) => {
      const res = run([path.join(FIX, WARN_ONLY[0]), ...WARN_ONLY.slice(1), '--fail-under', '0', '--fail-on', 'warning', '--json'], home);
      expect(res.status).toBe(1);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    });
  });
});

describe('--fail-on documentation', () => {
  it('is listed in the README usage block', () => {
    expect(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')).toMatch(/--fail-on <critical\|warning>/);
  });
});
