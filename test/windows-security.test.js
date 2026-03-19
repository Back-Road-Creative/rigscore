import { describe, it, expect, vi } from 'vitest';
import { withTmpDir } from './helpers.js';

describe('windows-security check', () => {
  it('returns N/A on non-Windows platforms', async () => {
    // Default platform in tests is linux, so it should be N/A
    const mod = await import('../src/checks/windows-security.js');
    const check = mod.default;
    const result = await check.run({ cwd: '/tmp', homedir: '/tmp' });
    expect(result.score).toBe(-1);
    expect(result.findings[0].severity).toBe('skipped');
  });

  it('has correct check metadata', async () => {
    const mod = await import('../src/checks/windows-security.js');
    const check = mod.default;
    expect(check.id).toBe('windows-security');
    expect(check.name).toBe('Windows/WSL security');
    expect(check.category).toBe('isolation');
  });

  it('has weight 0 in constants', async () => {
    const { WEIGHTS } = await import('../src/constants.js');
    expect(WEIGHTS['windows-security']).toBe(0);
  });
});
