import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { formatTerminal, formatJson, stripAnsi } from '../src/reporter.js';
import { formatFixHint } from '../src/fixer.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const fixable = {
  severity: 'warning',
  findingId: 'unicode-steganography/zero-width',
  title: 'Zero-width characters in CLAUDE.md',
  detail: 'Hidden characters found.',
  remediation: 'Remove them.',
};
const unfixable = {
  severity: 'warning',
  findingId: 'some-check/no-fixer-for-this',
  title: 'Something with no fixer',
  detail: 'Nothing automatic applies.',
  remediation: 'Fix by hand.',
};

function wrap(findings) {
  return {
    score: 50,
    results: [{ id: 'unicode-steganography', name: 'Unicode steganography', weight: 5, score: 50, findings }],
  };
}

describe('--fix discoverability hint (UI-9)', () => {
  it('formatFixHint is null when no fixer matches', () => {
    expect(formatFixHint(wrap([unfixable]).results)).toBeNull();
    expect(formatFixHint([])).toBeNull();
  });

  it('formatFixHint names the count and the --fix flag when a fixer matches', () => {
    const hint = formatFixHint(wrap([fixable]).results);
    expect(hint).toContain('1 finding can be fixed automatically');
    expect(hint).toContain('rigscore --fix');
  });

  it('the terminal report shows the hint when a fixer applies', () => {
    const out = stripAnsi(formatTerminal(wrap([fixable, unfixable]), '/tmp/x', { width: 80 }));
    expect(out).toContain('can be fixed automatically');
    expect(out).toContain('rigscore --fix');
  });

  it('the terminal report omits the hint when nothing is fixable', () => {
    const out = stripAnsi(formatTerminal(wrap([unfixable]), '/tmp/x', { width: 80 }));
    expect(out).not.toContain('--fix');
  });

  it('the quiet summary stays a summary: no hint', () => {
    const out = stripAnsi(formatTerminal(wrap([fixable]), '/tmp/x', { quiet: true }));
    expect(out).not.toContain('--fix');
  });

  it('the hint wraps inside an 80-column report', () => {
    const out = stripAnsi(formatTerminal(wrap([fixable]), '/tmp/x', { width: 80 }));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('JSON output carries versions (F7)', () => {
  it('adds rigscoreVersion and schemaVersion to the single-project shape', () => {
    const parsed = JSON.parse(formatJson(wrap([unfixable])));
    expect(parsed.rigscoreVersion).toBe(version);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.score).toBe(50);
  });

  it('adds both keys to the recursive shape', () => {
    const parsed = JSON.parse(formatJson({ score: 80, projects: [{ path: 'a', score: 80, results: [] }] }));
    expect(parsed.rigscoreVersion).toBe(version);
    expect(parsed.schemaVersion).toBe(1);
  });
});
