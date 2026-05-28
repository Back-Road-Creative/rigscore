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

  it('CTA is suppressed by default (opt-in via --cta)', () => {
    const opts = parseArgs([]);
    expect(opts.noCta).toBe(true);
  });

  it('--cta opts in to showing the CTA', () => {
    const opts = parseArgs(['--cta']);
    expect(opts.noCta).toBe(false);
  });

  it('--no-cta remains a back-compat alias (same as default)', () => {
    const opts = parseArgs(['--no-cta']);
    expect(opts.noCta).toBe(true);
  });

  it('last CTA flag wins when --cta and --no-cta are combined', () => {
    const optsA = parseArgs(['--cta', '--no-cta']);
    expect(optsA.noCta).toBe(true);

    const optsB = parseArgs(['--no-cta', '--cta']);
    expect(optsB.noCta).toBe(false);
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

  // Wave 11 — table-driven parser regression coverage.

  it('--no-color sets noColor without affecting noCta', () => {
    const opts = parseArgs(['--no-color']);
    expect(opts.noColor).toBe(true);
    expect(opts.noCta).toBe(true); // default
  });

  it('--refresh-mcp-registry implies --online', () => {
    const opts = parseArgs(['--refresh-mcp-registry']);
    expect(opts.refreshMcpRegistry).toBe(true);
    expect(opts.online).toBe(true);
  });

  it('--depth implies --recursive and parses the integer', () => {
    const opts = parseArgs(['--depth', '3']);
    expect(opts.depth).toBe(3);
    expect(opts.recursive).toBe(true);
  });

  it('--depth with a non-numeric value falls back to default depth 1', () => {
    const opts = parseArgs(['--depth', 'abc']);
    expect(opts.depth).toBe(1);
    expect(opts.recursive).toBe(true);
  });

  it('-v / -r / -y short aliases resolve to the same options', () => {
    expect(parseArgs(['-v']).verbose).toBe(true);
    expect(parseArgs(['-r']).recursive).toBe(true);
    expect(parseArgs(['-y']).yes).toBe(true);
  });

  it('unknown --flag is silently tolerated (no crash, no pollution)', () => {
    // Forward-compat: CI scripts may pass through extra flags; rigscore
    // must not reject them. The bare flag should not become the cwd
    // (which would happen if `!arg.startsWith('-')` accidentally fired).
    const opts = parseArgs(['--no-such-flag', '--json']);
    expect(opts.json).toBe(true);
    expect(opts.cwd).toBe(null);
  });

  it('bare positional becomes cwd; last positional wins', () => {
    const opts = parseArgs(['/path/one', '--json', '/path/two']);
    expect(opts.cwd).toBe('/path/two');
    expect(opts.json).toBe(true);
  });

  it('value-taking flag at the end of argv is tolerated (no crash)', () => {
    // Matches the prior behavior: `--check` with no following value
    // does not crash and does not set checkFilter to undefined.
    const opts = parseArgs(['--json', '--check']);
    expect(opts.json).toBe(true);
    expect(opts.checkFilter).toBe(null);
  });

  it('--ignore comma list with empty entries drops the empties', () => {
    const opts = parseArgs(['--ignore', 'env,,docker,']);
    expect(opts.ignore).toEqual(['env', 'docker']);
  });
});
