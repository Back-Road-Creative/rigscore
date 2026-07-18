import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rigscore.js');
function runCli(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' }, ...opts,
  });
}

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

  it('--depth with a non-numeric value is a FATAL argError, not a silent depth-1 / recursive flip', () => {
    const opts = parseArgs(['--depth', 'abc']);
    expect(opts.argError).toMatch(/--depth requires a numeric value/);
    // It must NOT silently flip a single-project scan into recursive mode.
    expect(opts.recursive).toBe(false);
    expect(opts.depth).toBe(1); // unchanged default
  });

  it('-v / -r / -y short aliases resolve to the same options', () => {
    expect(parseArgs(['-v']).verbose).toBe(true);
    expect(parseArgs(['-r']).recursive).toBe(true);
    expect(parseArgs(['-y']).yes).toBe(true);
  });

  it('unknown --flag is tolerated but surfaced as a warning (no crash, no pollution)', () => {
    // Forward-compat: CI scripts may pass through extra flags; rigscore
    // must not reject them. The bare flag should not become the cwd
    // (which would happen if `!arg.startsWith('-')` accidentally fired).
    // It MUST still be surfaced — a typo like `--fail-unde` cannot silently
    // gate at the default with nothing on stderr.
    const opts = parseArgs(['--no-such-flag', '--json']);
    expect(opts.json).toBe(true);
    expect(opts.cwd).toBe(null);
    expect(opts.warnings.join('\n')).toMatch(/unknown flag --no-such-flag/);
    expect(opts.argError).toBe(null);
  });

  it('bare positional becomes cwd; last positional wins', () => {
    const opts = parseArgs(['/path/one', '--json', '/path/two']);
    expect(opts.cwd).toBe('/path/two');
    expect(opts.json).toBe(true);
  });

  it('value-taking flag at the end of argv is tolerated but warns (no crash)', () => {
    // `--check` with no following value does not crash and does not set
    // checkFilter to undefined, but it is surfaced as a warning now.
    const opts = parseArgs(['--json', '--check']);
    expect(opts.json).toBe(true);
    expect(opts.checkFilter).toBe(null);
    expect(opts.warnings.join('\n')).toMatch(/--check expects a value/);
    expect(opts.argError).toBe(null);
  });

  it('--ignore comma list with empty entries drops the empties', () => {
    const opts = parseArgs(['--ignore', 'env,,docker,']);
    expect(opts.ignore).toEqual(['env', 'docker']);
  });

  // H-unknown-flags — mis-parsed flags must not look like a clean scan.

  it('valid flags produce no warnings and no argError', () => {
    const opts = parseArgs(['--json', '--fail-under', '80', '.']);
    expect(opts.warnings).toEqual([]);
    expect(opts.argError).toBe(null);
  });

  it('a dangling safety flag (--fail-under with no value) is a FATAL argError, not a silent fallback', () => {
    const opts = parseArgs(['--fail-under']);
    expect(opts.argError).toMatch(/--fail-under requires a numeric value/);
    // It must NOT quietly gate at the default threshold.
    expect(opts.warnings).toEqual([]);
  });

  it('a typo of the safety flag (--fail-unde 90) is surfaced, never a silent default gate', () => {
    const opts = parseArgs(['--fail-unde', '90', '.']);
    expect(opts.warnings.join('\n')).toMatch(/unknown flag --fail-unde/);
    expect(opts.argError).toBe(null);
    // The gate stays at the default — but now it is not silent.
    expect(opts.failUnder).toBe(70);
  });
});

describe('run() surfaces argv problems (H-unknown-flags, end-to-end)', () => {
  it('exits 2 with a clear stderr line on a dangling --fail-under (no silent gate)', () => {
    const res = runCli(['--fail-under']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/rigscore: --fail-under requires a numeric value/);
    expect(res.stderr).not.toMatch(/^\s*at /m); // no Node stack trace
  });

  it('warns on stderr for an unknown flag while still running the scan', () => {
    const res = runCli(['--totally-bogus-flag', '.']);
    expect(res.stderr).toMatch(/rigscore: warning: unknown flag --totally-bogus-flag/);
  });
});
