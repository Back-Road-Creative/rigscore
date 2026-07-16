import { describe, it, expect } from 'vitest';
import { suppressFindings } from '../src/scanner.js';
import { formatTerminal, formatJson, stripAnsi } from '../src/reporter.js';
import { formatSarif } from '../src/sarif.js';

/**
 * Suppression transparency (Wave 10b). `suppress:` / `--ignore` still DELETE
 * matching findings from scoring exactly as before — this suite only locks that
 * the count + ids of what was muted are now VISIBLE (human report, SARIF, JSON),
 * so a muted finding shows up in rigscore's own output/CI log, not only in a
 * .rigscorerc.json diff.
 */
function makeResults() {
  return [
    {
      id: 'skill-files',
      findings: [
        { severity: 'warning', title: 'a', findingId: 'skill-files/a' },
        { severity: 'warning', title: 'b', findingId: 'skill-files/b' },
      ],
      score: 70,
    },
    {
      id: 'claude-settings',
      findings: [
        { severity: 'info', title: 'sudo find', findingId: 'claude-settings/sudo-find-conflict' },
      ],
    },
  ];
}

describe('suppressFindings return value', () => {
  it('returns {count, ids} matching what it removed, and still mutates', () => {
    const results = makeResults();
    const summary = suppressFindings(results, ['skill-files/a']);
    expect(summary.count).toBe(1);
    expect(summary.ids).toEqual(['skill-files/a']);
    // Mutation preserved: finding gone AND per-check score recalculated.
    expect(results[0].findings.map((f) => f.findingId)).not.toContain('skill-files/a');
    expect(results[0].score).toBe(85); // one warning left → 100 - 15
  });

  it('counts every removed finding and dedupes ids across checks', () => {
    const summary = suppressFindings(makeResults(), ['skill-files', 'claude-settings/sudo-find-conflict']);
    expect(summary.count).toBe(3);
    expect(summary.ids).toEqual(['skill-files/a', 'skill-files/b', 'claude-settings/sudo-find-conflict']);
    expect(new Set(summary.ids).size).toBe(summary.ids.length);
  });

  it('returns a zero summary when there is nothing to suppress', () => {
    expect(suppressFindings(makeResults(), [])).toEqual({ count: 0, ids: [], unmatched: [] });
    // A pattern that removed nothing is reported in `unmatched` so a stale/typo'd
    // suppress can be warned about instead of silently no-op'ing.
    expect(suppressFindings(makeResults(), ['nonexistent/finding']))
      .toEqual({ count: 0, ids: [], unmatched: ['nonexistent/finding'] });
  });
});

describe('human report surfaces suppression', () => {
  const baseResult = () => ({
    score: 80,
    results: [{ id: 'claude-md', name: 'CLAUDE.md governance', weight: 20, score: 100, findings: [{ severity: 'pass', title: 'ok' }] }],
  });

  it('prints a "Suppressed N" line with ids when suppressions apply', () => {
    const result = baseResult();
    result.suppressed = { count: 2, ids: ['mcp-config/broad-filesystem-access', 'skill-files/shell-exec'] };
    const plain = stripAnsi(formatTerminal(result, '/repo'));
    expect(plain).toContain('Suppressed 2 findings');
    expect(plain).toContain('mcp-config/broad-filesystem-access');
    expect(plain).toContain('skill-files/shell-exec');
  });

  it('uses singular "finding" for a single suppression', () => {
    const result = baseResult();
    result.suppressed = { count: 1, ids: ['mcp-config/broad-filesystem-access'] };
    const plain = stripAnsi(formatTerminal(result, '/repo'));
    expect(plain).toContain('Suppressed 1 finding via config/--ignore');
    expect(plain).not.toContain('Suppressed 1 findings');
  });

  it('truncates a long id list with a "+N more" suffix', () => {
    const result = baseResult();
    result.suppressed = { count: 12, ids: Array.from({ length: 12 }, (_, i) => `check/finding-${i}`) };
    const plain = stripAnsi(formatTerminal(result, '/repo'));
    expect(plain).toContain('Suppressed 12 findings');
    expect(plain).toContain('more)');
  });

  it('prints no suppression line when none apply or count is zero', () => {
    expect(stripAnsi(formatTerminal(baseResult(), '/repo'))).not.toContain('Suppressed');
    const zero = baseResult();
    zero.suppressed = { count: 0, ids: [] };
    expect(stripAnsi(formatTerminal(zero, '/repo'))).not.toContain('Suppressed');
  });
});

describe('SARIF and JSON record suppression', () => {
  const mockResult = () => ({
    score: 75,
    results: [{ id: 'mcp-config', name: 'MCP server configuration', category: 'supply-chain', weight: 18, score: 85, findings: [{ severity: 'warning', title: 'Network transport', detail: 'SSE.' }] }],
  });

  it('SARIF carries suppressedCount/suppressedIds on run properties, without resurrecting results', () => {
    const result = mockResult();
    result.suppressed = { count: 2, ids: ['mcp-config/broad-filesystem-access', 'skill-files/shell-exec'] };
    const sarif = formatSarif(result);
    expect(sarif.runs[0].properties.suppressedCount).toBe(2);
    expect(sarif.runs[0].properties.suppressedIds).toEqual(['mcp-config/broad-filesystem-access', 'skill-files/shell-exec']);
    expect(sarif.runs[0].results.map((r) => r.ruleId)).not.toContain('mcp-config/broad-filesystem-access');
  });

  it('SARIF omits the property when nothing was suppressed', () => {
    expect(formatSarif(mockResult()).runs[0].properties).toBeUndefined();
  });

  it('JSON includes a suppressed summary field', () => {
    const parsed = JSON.parse(formatJson({ score: 90, results: [], suppressed: { count: 1, ids: ['mcp-config/broad-filesystem-access'] } }));
    expect(parsed.suppressed).toEqual({ count: 1, ids: ['mcp-config/broad-filesystem-access'] });
  });
});
