import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/index.js';

describe('parseArgs', () => {
  it('parses --fail-under', () => {
    const opts = parseArgs(['--fail-under', '80']);
    expect(opts.failUnder).toBe(80);
  });

  it('defaults --fail-under to 70', () => {
    const opts = parseArgs([]);
    expect(opts.failUnder).toBe(70);
  });

  it('clamps --fail-under to 0-100', () => {
    expect(parseArgs(['--fail-under', '150']).failUnder).toBe(100);
    expect(parseArgs(['--fail-under', '-10']).failUnder).toBe(0);
  });

  it('parses --sarif', () => {
    const opts = parseArgs(['--sarif']);
    expect(opts.sarif).toBe(true);
  });

  it('parses --profile', () => {
    const opts = parseArgs(['--profile', 'minimal']);
    expect(opts.profile).toBe('minimal');
  });

  it('--ci enables sarif, noColor, noCta', () => {
    const opts = parseArgs(['--ci']);
    expect(opts.sarif).toBe(true);
    expect(opts.noColor).toBe(true);
    expect(opts.noCta).toBe(true);
  });

  it('parses --ignore with comma-separated values', () => {
    const opts = parseArgs(['--ignore', 'env,docker']);
    expect(opts.ignore).toEqual(['env', 'docker']);
  });

  it('--ignore defaults to null', () => {
    const opts = parseArgs([]);
    expect(opts.ignore).toBe(null);
  });

  it('--ignore trims whitespace from patterns', () => {
    const opts = parseArgs(['--ignore', ' env , docker ']);
    expect(opts.ignore).toEqual(['env', 'docker']);
  });

  it('preserves existing flags', () => {
    const opts = parseArgs(['--json', '--deep', '--online', '--verbose']);
    expect(opts.json).toBe(true);
    expect(opts.deep).toBe(true);
    expect(opts.online).toBe(true);
    expect(opts.verbose).toBe(true);
  });
});
