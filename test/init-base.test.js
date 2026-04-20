import { describe, it, expect } from 'vitest';
import { buildStarter } from '../src/cli/init.js';

describe('rigscore init (base)', () => {
  it('produces a starter referencing all 5 profile names', () => {
    const out = buildStarter(null);
    for (const p of ['default', 'minimal', 'ci', 'home', 'monorepo']) {
      expect(out).toContain(p);
    }
  });

  it('pre-fills the profile when one is provided', () => {
    const out = buildStarter('home');
    expect(out).toMatch(/"profile":\s*"home"/);
  });

  it('starter JSON parses after comment stripping', async () => {
    const { stripJsonComments } = await import('../src/utils.js');
    const raw = buildStarter(null);
    const parsed = JSON.parse(stripJsonComments(raw));
    expect(Array.isArray(parsed.suppress)).toBe(true);
    expect(Array.isArray(parsed.checks.disabled)).toBe(true);
    expect(typeof parsed.weights).toBe('object');
  });
});
