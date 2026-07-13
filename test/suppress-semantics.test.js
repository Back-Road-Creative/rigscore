import { describe, it, expect } from 'vitest';
import { suppressFindings, deduplicateFindings } from '../src/scanner.js';
import { calculateOverallScore } from '../src/scoring.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

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

  it('bare check id suppresses every finding in that check namespace', () => {
    const results = [
      {
        id: 'mcp-config',
        findings: [
          { severity: 'critical', title: 'Broad filesystem access', findingId: 'mcp-config/broad-filesystem-access' },
          { severity: 'warning', title: 'Network transport enabled', findingId: 'mcp-config/network-transport' },
        ],
      },
      {
        id: 'docker-security',
        findings: [
          { severity: 'critical', title: 'Container runs privileged', findingId: 'docker-security/container-running-with-privileged-true' },
        ],
      },
    ];
    suppressFindings(results, ['mcp-config']);
    // The bare check id is documented (FINDING_IDS.md) to mute the whole check.
    expect(results[0].findings).toEqual([]);
    // A different check is left completely untouched.
    expect(results[1].findings.length).toBe(1);
  });

  it('bare check id never suppresses a different check with a shared prefix', () => {
    // `docker` is a text-prefix of the `docker-security` check id but is not
    // its own check segment. The trailing-slash anchor must keep it isolated,
    // so a bare `docker` token silences nothing here.
    const results = [
      {
        id: 'docker-security',
        findings: [
          { severity: 'critical', title: 'Container runs privileged', findingId: 'docker-security/container-running-with-privileged-true' },
          { severity: 'warning', title: 'Host network mode', findingId: 'docker-security/container-uses-host-network-mode' },
        ],
      },
    ];
    suppressFindings(results, ['docker']);
    expect(results[0].findings.length).toBe(2);
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

/**
 * Suppression MUST NOT promote a NOT-APPLICABLE check into coverage.
 *
 * Several weight-bearing checks report N/A (score === -1) *and* attach a
 * cosmetic "nothing here" INFO finding (e.g. mcp-config/no-config-found).
 * Muting that INFO — an ordinary, documented use of `--ignore` / the
 * `suppress:` rc key — must not recalculate the check to 100 and hand the
 * project weight it never earned. N/A is a property of the project, not of
 * the finding list.
 */
describe('suppression must not promote an N/A check into coverage', () => {
  // Two weight-bearing checks: one genuinely applicable, one N/A-with-INFO.
  function makeNaResults() {
    return [
      {
        id: 'claude-md',
        score: 60,
        findings: [
          { severity: 'warning', title: 'Missing section', findingId: 'claude-md/missing-section' },
        ],
      },
      {
        id: 'mcp-config',
        score: NOT_APPLICABLE_SCORE,
        findings: [
          { severity: 'info', title: 'No MCP configuration found', findingId: 'mcp-config/no-config-found' },
        ],
      },
    ];
  }

  it('leaves an N/A check at NOT_APPLICABLE after its sole INFO is suppressed', () => {
    const results = makeNaResults();
    suppressFindings(results, ['mcp-config/no-config-found']);

    expect(results[1].findings).toEqual([]);
    expect(results[1].score).toBe(NOT_APPLICABLE_SCORE);
  });

  it('leaves the overall score unchanged when an N/A check\'s INFO is suppressed', () => {
    const before = calculateOverallScore(makeNaResults());

    const results = makeNaResults();
    suppressFindings(results, ['mcp-config/no-config-found']);
    const after = calculateOverallScore(results);

    // The N/A check's weight must stay out of coverage — muting a cosmetic
    // INFO cannot move the score, and so cannot flip a --fail-under gate.
    expect(after).toBe(before);
  });

  it('still recalculates an applicable check whose findings are wholly suppressed', () => {
    // Positive control: legitimate suppression must keep working. An
    // applicable check that is fully muted still rises to 100.
    const results = makeNaResults();
    suppressFindings(results, ['claude-md/missing-section']);

    expect(results[0].findings).toEqual([]);
    expect(results[0].score).toBe(100);
  });

  it('deduplicateFindings does not promote an N/A check either', () => {
    // Defensive sibling guard: the same unguarded recalc lives in dedup.
    // No live check currently emits an N/A result carrying a dedupable
    // (warning/critical) finding, so this pins the invariant rather than
    // fixing an observed failure.
    const results = [
      {
        id: 'claude-md',
        score: 85,
        findings: [
          { severity: 'warning', title: 'Duplicate concern', findingId: 'claude-md/duplicate-concern' },
        ],
      },
      {
        id: 'git-hooks',
        score: NOT_APPLICABLE_SCORE,
        findings: [
          { severity: 'warning', title: 'Duplicate concern', findingId: 'git-hooks/duplicate-concern' },
        ],
      },
    ];
    deduplicateFindings(results);

    // Lower-weighted git-hooks loses the duplicate and empties out...
    expect(results[1].findings).toEqual([]);
    // ...but stays N/A rather than being recalculated to 100.
    expect(results[1].score).toBe(NOT_APPLICABLE_SCORE);
  });
});
