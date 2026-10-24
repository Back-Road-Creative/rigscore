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

  describe('off Linux', () => {
    /** Run `fn` with `process.platform` stubbed, always restoring it. */
    async function withPlatform(platform, fn) {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        return await fn();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    }

    function writeSettings(dir, deny) {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny } }),
      );
    }

    it.each(['darwin', 'win32'])('is not skipped on %s: the deny-list arm still runs', async (platform) => {
      const fx = makeRepoFixture({ hooks: ['pre-commit', 'pre-push', 'commit-msg'] });
      writeSettings(fx.dir, ['rm -rf']);
      const result = await withPlatform(platform, () => runWithFixture(fx, {
        cwd: fx.dir, homedir: path.join(fx.dir, 'nohome'), config: {},
      }));
      expect(result.score).not.toBe(-1);
      expect(result.findings.some((f) => f.severity === 'skipped')).toBe(false);
      const ids = result.findings.map((f) => f.findingId);
      expect(ids).toContain('infrastructure-security/deny-list-missing-patterns');
    });

    it('checks the detected git hooks path on darwin', async () => {
      const fx = makeRepoFixture({ hooks: ['pre-commit'] });
      const result = await withPlatform('darwin', () => runWithFixture(fx, {
        cwd: fx.dir, homedir: path.join(fx.dir, 'nohome'), config: {},
      }));
      const missing = result.findings.filter(
        (f) => f.findingId === 'infrastructure-security/required-hook-missing',
      );
      expect(missing.map((f) => f.context.hook).sort()).toEqual(['commit-msg', 'pre-push']);
      expect(result.data.hooksDir).toBe(fx.hooksDir);
    });

    it('still reports the nothing-to-scan skip (not a platform skip) on darwin', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-bare-'));
      const result = await withPlatform('darwin', () => check.run({
        cwd: dir, homedir: path.join(dir, 'nohome'), config: {},
      }));
      expect(result.score).toBe(-1);
      expect(result.findings[0].title).toMatch(/nothing found at the default locations/i);
      expect(result.findings[0].title).not.toMatch(/linux-only/i);
    });

    it('gates the Linux-only immutability arm instead of running lsattr', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-imm-'));
      const result = await withPlatform('darwin', () => check.run({
        cwd: dir,
        homedir: path.join(dir, 'nohome'),
        config: { paths: { immutableDirs: [dir] } },
      }));
      const f = result.findings.find((x) => x.findingId === 'infrastructure-security/cannot-check-immutability');
      expect(f).toBeDefined();
      expect(f.severity).toBe('info');
      expect(f.detail).toMatch(/linux/i);
      expect(f.detail).toContain('darwin');
      expect(result.findings.some(
        (x) => x.findingId === 'infrastructure-security/immutable-flag-not-set',
      )).toBe(false);
    });

    describe('default safety-guard lookup', () => {
      const guard = ['', 'etc', 'profile.d', 'safety-gates.sh'].join('/');

      /** Make the default guard path look present regardless of the host. */
      function pretendGuardExists() {
        const realAccess = fs.promises.access.bind(fs.promises);
        vi.spyOn(fs.promises, 'access').mockImplementation(async (p, ...rest) => {
          if (String(p) === guard) return undefined;
          return realAccess(p, ...rest);
        });
      }

      async function detectedGuard(platform) {
        const fx = makeRepoFixture({ hooks: ['pre-commit', 'pre-push', 'commit-msg'] });
        pretendGuardExists();
        const result = await withPlatform(platform, () => runWithFixture(fx, {
          cwd: fx.dir, homedir: path.join(fx.dir, 'nohome'), config: {},
        }));
        return result.data.safetyGates;
      }

      it('finds the guard on linux when it exists', async () => {
        expect(await detectedGuard('linux')).toBe(guard);
      });

      it.each(['darwin', 'win32'])('does not look for the guard on %s even if the path exists', async (platform) => {
        expect(await detectedGuard(platform)).toBeNull();
      });
    });

    it('does not apply POSIX mode or root-ownership rules on win32', async () => {
      const fx = makeRepoFixture();
      // Hooks without the owner-execute bit and a dir that is not uid 0.
      for (const hook of ['pre-commit', 'pre-push', 'commit-msg']) {
        fs.writeFileSync(path.join(fx.hooksDir, hook), '@echo off\r\n', { mode: 0o644 });
      }
      const result = await withPlatform('win32', () => runWithFixture(fx, {
        cwd: fx.dir,
        homedir: path.join(fx.dir, 'nohome'),
        config: { paths: { hooksDir: fx.hooksDir } },
      }));
      const ids = result.findings.map((f) => f.findingId);
      expect(ids).not.toContain('infrastructure-security/hook-not-executable');
      expect(ids).not.toContain('infrastructure-security/hooks-dir-not-root-owned');
    });
  });

  it('keeps the POSIX mode rule on Linux', async () => {
    if (process.platform !== 'linux') return;
    const fx = makeRepoFixture();
    for (const hook of ['pre-commit', 'pre-push', 'commit-msg']) {
      fs.writeFileSync(path.join(fx.hooksDir, hook), '#!/bin/sh\n', { mode: 0o644 });
    }
    const result = await runWithFixture(fx, {
      cwd: fx.dir,
      homedir: path.join(fx.dir, 'nohome'),
      config: { paths: { hooksDir: fx.hooksDir } },
    });
    const ids = result.findings.map((f) => f.findingId);
    expect(ids).toContain('infrastructure-security/hook-not-executable');
  });

  it('produces findings when infrastructure is present (with opt-in paths)', async () => {
    // On this machine, infrastructure should exist
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/home/user/workspace',
      homedir: '/home/user',
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
      cwd: '/home/user/workspace',
      homedir: '/home/user',
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

  // ── Home scope ──────────────────────────────────────────────────────────

  function writeSettings(root, settings) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings));
  }

  function denyFindings(result) {
    return result.findings
      .filter((f) => /deny list/i.test(f.title || ''))
      .map((f) => `${f.severity}:${f.findingId || ''}:${f.title}`)
      .sort();
  }

  it('home settings do not change deny-list findings without --include-home-skills', async () => {
    if (process.platform !== 'linux') return;
    const fx = makeRepoFixture({ hooks: ['pre-commit'] });
    const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-barehome-'));
    const richHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-richhome-'));
    try {
      const { REQUIRED_DENY_PATTERNS } = await import('../src/checks/infrastructure-security.js');
      writeSettings(richHome, { permissions: { deny: [...REQUIRED_DENY_PATTERNS] } });

      const bare = await runWithFixture(fx, { cwd: fx.dir, homedir: bareHome, config: {} });
      const rich = await runWithFixture(fx, { cwd: fx.dir, homedir: richHome, config: {} });

      // Same project, different operator home: identical verdict.
      expect(denyFindings(rich)).toEqual(denyFindings(bare));
      expect(rich.score).toBe(bare.score);
      expect(rich.data.denyListEntries).toBe(0);

      // Opting in does read the home profile.
      const optedIn = await runWithFixture(fx, {
        cwd: fx.dir, homedir: richHome, includeHomeSkills: true, config: {},
      });
      expect(
        optedIn.findings.some((f) => f.severity === 'pass' && /all required patterns/.test(f.title)),
      ).toBe(true);
    } finally {
      for (const d of [fx.dir, bareHome, richHome]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('project settings are read whether or not home scope is enabled', async () => {
    if (process.platform !== 'linux') return;
    const fx = makeRepoFixture({ hooks: ['pre-commit'] });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-infra-home-'));
    try {
      const { REQUIRED_DENY_PATTERNS } = await import('../src/checks/infrastructure-security.js');
      writeSettings(fx.dir, { permissions: { deny: [...REQUIRED_DENY_PATTERNS] } });
      const result = await runWithFixture(fx, { cwd: fx.dir, homedir: home, config: {} });
      expect(
        result.findings.some((f) => f.severity === 'pass' && /all required patterns/.test(f.title)),
      ).toBe(true);
    } finally {
      for (const d of [fx.dir, home]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
