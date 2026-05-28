import { describe, it, expect } from 'vitest';
import { WEIGHTS } from '../src/constants.js';
import check from '../src/checks/site-security.js';

describe('site-security check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('site-security');
    expect(check.name).toBeDefined();
    expect(check.category).toBe('isolation');
    expect(typeof check.run).toBe('function');
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('returns NOT_APPLICABLE when online is false', async () => {
    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp',
      config: { sites: ['https://example.com'] },
      online: false,
    });

    expect(result.score).toBe(-1);
    expect(result.findings[0].severity).toBe('skipped');
  });

  it('returns NOT_APPLICABLE when no sites configured', async () => {
    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp',
      config: { sites: [] },
      online: true,
    });

    expect(result.score).toBe(-1);
    expect(result.findings[0].severity).toBe('info');
  });

  it('returns NOT_APPLICABLE when sites key is missing', async () => {
    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp',
      config: {},
      online: true,
    });

    expect(result.score).toBe(-1);
  });

  it('rejects non-http(s) schemes with an info finding instead of dispatching to fetch*', async () => {
    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp',
      config: { sites: ['file:///etc/passwd', 'ftp://example.com'] },
      online: true,
    });
    const ids = result.findings.map((f) => f.findingId);
    expect(ids).toContain('site-security/unsupported-scheme');
    expect(result.findings.filter((f) => f.findingId === 'site-security/unsupported-scheme').length).toBe(2);
  });

  it('rejects malformed URLs with an invalid-url info finding', async () => {
    const result = await check.run({
      cwd: '/tmp',
      homedir: '/tmp',
      config: { sites: ['not a url at all'] },
      online: true,
    });
    const ids = result.findings.map((f) => f.findingId);
    expect(ids).toContain('site-security/invalid-url');
  });
});
