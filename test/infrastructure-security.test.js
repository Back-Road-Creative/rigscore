import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WEIGHTS } from '../src/constants.js';

// Dynamic import so we can mock utils before the check module loads
let check;

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
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('produces findings when infrastructure is present', async () => {
    // On this machine, infrastructure should exist
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/home/dev/workspaces',
      homedir: '/home/joe',
      config: { paths: { immutableDirs: [] } },
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

  it('returns data with infrastructure summary', async () => {
    if (process.platform !== 'linux') return;

    const result = await check.run({
      cwd: '/home/dev/workspaces',
      homedir: '/home/joe',
      config: {},
    });

    expect(result.data).toHaveProperty('hooksDir');
    expect(result.data).toHaveProperty('gitWrapper');
    expect(result.data).toHaveProperty('denyListEntries');
    expect(result.data).toHaveProperty('sandboxGateRegistered');
  });
});
