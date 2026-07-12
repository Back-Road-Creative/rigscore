import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WEIGHTS } from '../src/constants.js';

// Dynamic import so we can mock utils before the check module loads
let check;

/**
 * A real git repo in a temp dir, optionally with hooks in `.git/hooks` and a
 * `git` wrapper script to put first on PATH. Global/system gitconfig is
 * neutralized so the host's own `core.hooksPath` can't leak into the fixture
 * (this box sets one globally).
 */
function makeRepoFixture({ hooks = [], wrapper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-'));
  const gitConfig = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', dir], { env });

  const hooksDir = path.join(dir, '.git', 'hooks');
  for (const hook of hooks) {
    fs.writeFileSync(path.join(hooksDir, hook), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  let binDir = null;
  if (wrapper) {
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    // Realistic wrapper: strips --no-verify, forwards to the real git (with
    // the original PATH restored so it doesn't re-find itself).
    fs.writeFileSync(
      path.join(binDir, 'git'),
      `#!/bin/sh\n# safety wrapper: strips --no-verify\nPATH="${process.env.PATH}" exec git "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { dir, hooksDir, binDir, gitConfig };
}

/** Run the check with the fixture's PATH / gitconfig visible to execSafe. */
async function runWithFixture(fx, context) {
  const saved = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = fx.gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  if (fx.binDir) process.env.PATH = `${fx.binDir}${path.delimiter}${saved.PATH}`;
  try {
    return await check.run(context);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('infrastructure-security check', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Fresh import each test
    check = (await import('../src/checks/infrastructure-security.js')).default;
  });

  it('has required shape', () => {
    expect(check.id).toBe('infrastructure-security');
    expect(check.name).toBeDefined();
    expect(check.category).toBe('process');
    expect(typeof check.run).toBe('function');
    expect(WEIGHTS[check.id]).toBe(6);
  });

  it('returns NOT_APPLICABLE on non-Linux', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    try {
      const result = await check.run({ cwd: '/tmp', homedir: '/tmp', config: {} });
      expect(result.score).toBe(-1);
      expect(result.findings[0].severity).toBe('skipped');
      // The skip must name the condition that fired, so "wrong platform" and
      // "nothing to scan" are distinguishable in output.
      expect(result.findings[0].title).toMatch(/linux-only/i);
      expect(result.findings[0].title).toContain('darwin');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('produces findings when infrastructure is present (with opt-in paths)', async () => {
    // On this machine, infrastructure should exist
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/home/dev/workspaces',
      homedir: '/home/joe',
      config: {
        paths: {
          hooksDir: '/opt/git-hooks',
          gitWrapper: '/usr/local/bin/git',
          safetyGates: '/etc/profile.d/safety-gates.sh',
          immutableDirs: [],
        },
      },
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.data).toBeDefined();
    expect(result.data.hooksDir).toBeDefined();
  });

  it('reports critical when hooks dir does not exist', async () => {
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp/nonexistent-home',
      config: {
        paths: {
          hooksDir: '/tmp/nonexistent-hooks-dir',
          gitWrapper: '/tmp/nonexistent-git-wrapper',
          safetyGates: '/tmp/nonexistent-safety-gates',
          immutableDirs: [],
        },
      },
    });

    const criticals = result.findings.filter((f) => f.severity === 'critical');
    expect(criticals.length).toBeGreaterThan(0);
    expect(criticals.some((f) => f.title.includes('hooks directory missing'))).toBe(true);
  });

  it('returns data with infrastructure summary (with opt-in paths)', async () => {
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/home/dev/workspaces',
      homedir: '/home/joe',
      config: {
        paths: {
          hooksDir: '/opt/git-hooks',
          gitWrapper: '/usr/local/bin/git',
          safetyGates: '/etc/profile.d/safety-gates.sh',
        },
      },
    });

    expect(result.data).toHaveProperty('hooksDir');
    expect(result.data).toHaveProperty('gitWrapper');
    expect(result.data).toHaveProperty('denyListEntries');
    expect(result.data).toHaveProperty('sandboxGateRegistered');
  });

  // ── Default path detection (no .rigscorerc.json required) ───────────────

  it('scans via detected defaults when no .rigscorerc.json paths are configured', async () => {
    if (process.platform !== 'linux') return;
    const fx = makeRepoFixture({ hooks: ['pre-commit'], wrapper: true });
    try {
      const result = await runWithFixture(fx, { cwd: fx.dir, homedir: fx.dir, config: {} });

      // The check reaches a verdict with zero config.
      expect(result.score).not.toBe(-1);
      expect(result.data.hooksDir).toBe(fx.hooksDir);
      expect(result.data.pathSources.hooksDir).toBe('default');
      expect(result.data.pathSources.gitWrapper).toBe('default');
      expect(
        result.findings.some((f) => f.severity === 'pass' && /pre-commit/.test(f.title)),
      ).toBe(true);
      expect(
        result.findings.some((f) => f.severity === 'pass' && /strips --no-verify/.test(f.title)),
      ).toBe(true);

      // A detected (never-declared) hooks dir reports gaps as WARNING, not
      // CRITICAL: a critical zeroes the whole check, and root-ownership is
      // meaningless for a repo-local hooks dir git itself has to write to.
      const missingPrePush = result.findings.find((f) => /missing: pre-push/.test(f.title || ''));
      expect(missingPrePush).toBeDefined();
      expect(missingPrePush.severity).toBe('warning');
      expect(result.findings.some((f) => f.severity === 'critical')).toBe(false);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('explicit .rigscorerc.json paths win over detected defaults', async () => {
    if (process.platform !== 'linux') return;
    const fx = makeRepoFixture({ hooks: ['pre-commit'], wrapper: true });
    try {
      const result = await runWithFixture(fx, {
        cwd: fx.dir,
        homedir: fx.dir,
        config: { paths: { hooksDir: '/tmp/rigscore-nonexistent-hooks' } },
      });

      // Declared path is used verbatim; the detectable default is not
      // substituted for it, and today's behavior (CRITICAL when it's missing)
      // is preserved exactly.
      expect(result.data.hooksDir).toBe('/tmp/rigscore-nonexistent-hooks');
      expect(result.data.pathSources.hooksDir).toBe('config');
      const criticals = result.findings.filter((f) => f.severity === 'critical');
      expect(criticals.some((f) => /hooks directory missing/i.test(f.title))).toBe(true);
      expect(
        result.findings.some((f) => f.severity === 'pass' && /pre-commit/.test(f.title)),
      ).toBe(false);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('N/As with "nothing found" (not "configure paths") when defaults detect nothing', async () => {
    if (process.platform !== 'linux') return;
    // Not a git repo → no hooks dir, no wrapper surface, nothing to scan.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-bare-'));
    try {
      const result = await check.run({ cwd: tmp, homedir: tmp, config: {} });

      expect(result.score).toBe(-1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('skipped');
      expect(result.findings[0].title).toMatch(/nothing found at the default locations/i);
      // A missing optional artifact is never a finding.
      expect(result.findings.some((f) => f.severity === 'critical')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
