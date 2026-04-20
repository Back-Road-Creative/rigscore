import { describe, it, expect } from 'vitest';
import { suppressFindings } from '../src/scanner.js';

/**
 * Suppress pattern semantics (Moat & Ship).
 *
 * Three supported forms:
 *   - Substring / exact id (legacy, backwards-compatible)
 *   - Glob using `*`
 *   - Regex using "re:/<body>/[flags]"
 *
 * All matching is case-insensitive.
 */
describe('suppress semantics', () => {
  function makeResults() {
    return [
      {
        id: 'skill-files',
        findings: [
          { severity: 'warning', title: 'skill drive-resume has issue', findingId: 'skill-files/drive-resume-has-issue' },
          { severity: 'warning', title: 'skill workflow-maturity is fine', findingId: 'skill-files/workflow-maturity-is-fine' },
        ],
      },
      {
        id: 'claude-settings',
        findings: [
          { severity: 'info', title: 'allow/deny conflict on sudo find', findingId: 'claude-settings/sudo-find-conflict' },
          { severity: 'info', title: 'allow/deny conflict on npm test', findingId: 'claude-settings/npm-test-conflict' },
        ],
      },
    ];
  }

  it('substring pattern matches legacy title substring (backwards compat)', () => {
    const results = makeResults();
    suppressFindings(results, ['drive-resume']);
    const titles = results.flatMap(r => r.findings.map(f => f.title));
    expect(titles).not.toContain('skill drive-resume has issue');
    expect(titles).toContain('skill workflow-maturity is fine');
  });

  it('exact findingId match removes only that one finding', () => {
    const results = makeResults();
    suppressFindings(results, ['claude-settings/sudo-find-conflict']);
    const ids = results.flatMap(r => r.findings.map(f => f.findingId));
    expect(ids).not.toContain('claude-settings/sudo-find-conflict');
    expect(ids).toContain('claude-settings/npm-test-conflict');
  });

  it('glob pattern with wildcard matches findingId prefix', () => {
    const results = makeResults();
    suppressFindings(results, ['skill-files/*']);
    const remaining = results[0].findings;
    expect(remaining).toEqual([]);
    // claude-settings untouched
    expect(results[1].findings.length).toBe(2);
  });

  it('glob pattern with mid-string star matches substring segment', () => {
    const results = makeResults();
    suppressFindings(results, ['claude-settings/*-conflict']);
    expect(results[1].findings).toEqual([]);
  });

  it('regex pattern with re:/ prefix matches against findingId OR title', () => {
    const results = makeResults();
    suppressFindings(results, ['re:/.*sudo.*/']);
    const ids = results.flatMap(r => r.findings.map(f => f.findingId));
    expect(ids).not.toContain('claude-settings/sudo-find-conflict');
    expect(ids).toContain('claude-settings/npm-test-conflict');
  });

  it('regex pattern is case-insensitive by default', () => {
    const results = makeResults();
    suppressFindings(results, ['re:/SUDO/']);
    const ids = results.flatMap(r => r.findings.map(f => f.findingId));
    expect(ids).not.toContain('claude-settings/sudo-find-conflict');
  });

  it('malformed regex falls through to substring match (no crash)', () => {
    const results = makeResults();
    expect(() => suppressFindings(results, ['re:/[unclosed/'])).not.toThrow();
  });

  it('mixing all three pattern forms composes additively', () => {
    const results = makeResults();
    suppressFindings(results, [
      'drive-resume',                         // substring
      'claude-settings/*-conflict',            // glob
      're:/workflow-maturity/',                // regex
    ]);
    expect(results[0].findings).toEqual([]);
    expect(results[1].findings).toEqual([]);
  });

  it('recalculates per-check score after removal', () => {
    const results = [
      {
        id: 'skill-files',
        findings: [
          { severity: 'warning', title: 'issue A', findingId: 'skill-files/a' },
          { severity: 'warning', title: 'issue B', findingId: 'skill-files/b' },
        ],
        score: 70, // stale pre-suppress score
      },
    ];
    suppressFindings(results, ['skill-files/a']);
    // One warning remaining → calculateCheckScore = 100 - 15 = 85
    expect(results[0].score).toBe(85);
  });
});
