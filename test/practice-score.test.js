import { describe, it, expect } from 'vitest';
import { calculateOverallScore, calculatePracticeScore } from '../src/scoring.js';
import { formatTerminal, formatJson, stripAnsi } from '../src/reporter.js';
import { NOT_APPLICABLE_SCORE, PRACTICE_WEIGHTS } from '../src/constants.js';

// Synthetic result sets only — the six sibling Practice checks are separate
// PRs, so a real scan cannot be used to exercise the Practice axis yet.
const r = (id, score, weight = 0) => ({ id, name: id, weight, score, findings: [] });

const securityResults = [r('governance-docs', 40, 10), r('coherence', 100, 14), r('env-exposure', 100, 8)];

const practiceResults = [
  r('loop-governance', 100),                    // practice weight 25
  r('spec-goals', 50),                          // 20
  r('workflow-maturity', 100),                  // 20
  r('sandbox-posture', NOT_APPLICABLE_SCORE),   // 15
  r('ci-agent-caps', NOT_APPLICABLE_SCORE),     // 10
  r('memory-hygiene', 100),                     // 5
  r('ai-disclosure', 100),                      // 5
];

describe('Practice axis scoring', () => {
  it('scores a synthetic result set on the Practice weights', () => {
    // Applicable practice weight = 25 + 20 + 20 + 5 + 5 = 75.
    // weighted avg = (100*25 + 50*20 + 100*20 + 100*5 + 100*5) / 75 = 86.67
    // coverage scale = 75/100 → 65
    expect(calculatePracticeScore([...securityResults, ...practiceResults])).toBe(65);
  });

  it('ignores Security checks entirely', () => {
    const withBadSecurity = [
      ...practiceResults,
      { id: 'env-exposure', score: 0, findings: [] },
      { id: 'governance-docs', score: 0, findings: [] },
    ];
    expect(calculatePracticeScore(withBadSecurity)).toBe(
      calculatePracticeScore(practiceResults),
    );
  });

  it('returns null (N/A), never 0, when no practice check is applicable', () => {
    const noSurface = [
      ...securityResults,
      { id: 'workflow-maturity', score: NOT_APPLICABLE_SCORE, findings: [] },
    ];
    expect(calculatePracticeScore(noSurface)).toBeNull();
    expect(calculatePracticeScore(securityResults)).toBeNull();
  });

  it('does not leak the coherence compound-risk penalty onto the Practice axis', () => {
    const coherenceCritical = {
      id: 'coherence',
      score: 0,
      findings: [{ severity: 'critical', title: 'compound risk' }],
    };
    const withCoherence = [...practiceResults, coherenceCritical];
    // Practice is unaffected: coherence is a Security concept.
    expect(calculatePracticeScore(withCoherence)).toBe(calculatePracticeScore(practiceResults));
    // ...but the Security axis still takes the -10 hit.
    const secBase = calculateOverallScore([...securityResults]);
    const secWithCritical = calculateOverallScore([
      ...securityResults.filter((r) => r.id !== 'coherence'),
      coherenceCritical,
    ]);
    expect(secBase - secWithCritical).toBeGreaterThanOrEqual(10);
  });
});

describe('Security axis freeze', () => {
  it('is byte-identical whether or not practice results are present', () => {
    const before = calculateOverallScore(securityResults);
    const after = calculateOverallScore([...securityResults, ...practiceResults]);
    expect(after).toBe(before);
    expect(before).toBe(26); // golden: claude-md 40 + coherence 100 + env 100 over weight 32
  });

  it('gives practice checks zero weight on the Security axis', () => {
    for (const id of Object.keys(PRACTICE_WEIGHTS)) {
      const withCheck = calculateOverallScore([
        ...securityResults,
        { id, score: 0, findings: [] },
      ]);
      expect(withCheck, `${id} must not move the Security score`).toBe(
        calculateOverallScore(securityResults),
      );
    }
  });
});

describe('Practice axis reporting', () => {
  it('prints "Practice: n/a" — never 0/100 — on a repo with no practice surface', () => {
    const out = stripAnsi(formatTerminal({ score: 26, results: securityResults }, '/x'));
    expect(out).toContain('Practice: n/a');
    expect(out).not.toContain('Practice: 0/100');
  });

  it('renders both axes when a practice surface exists', () => {
    const results = [...securityResults, ...practiceResults];
    const out = stripAnsi(formatTerminal({ score: 26, results }, '/x'));
    expect(out).toContain('HYGIENE SCORE: 26/100');
    expect(out).toContain('Practice: 65/100');
  });

  it('includes practiceScore in --json output', () => {
    const results = [...securityResults, ...practiceResults];
    const parsed = JSON.parse(formatJson({ score: 26, results, practiceScore: 65 }));
    expect(parsed.practiceScore).toBe(65);
  });
});

describe('reporter coverage line uses resolved weights', () => {
  const results = [
    { id: 'governance-docs', name: 'CLAUDE.md governance', weight: 10, score: 100, findings: [] },
    { id: 'docker-security', name: 'Docker security', weight: 6, score: 100, findings: [] },
    { id: 'mcp-config', name: 'MCP', weight: 14, score: NOT_APPLICABLE_SCORE, findings: [] },
  ];

  it('excludes checks disabled in .rigscorerc.json from the applicable weight', () => {
    const config = { checks: { disabled: ['docker-security'] } };
    const out = stripAnsi(formatTerminal({ score: 10, results, config }, '/x'));
    // docker-security is disabled → weight 0 in resolveWeights → the scorer
    // excludes it, so the coverage line must too (was: weight 16/100).
    expect(out).toContain('weight 10/100');
  });

  it('counts the full weight when nothing is disabled', () => {
    const out = stripAnsi(formatTerminal({ score: 16, results, config: {} }, '/x'));
    expect(out).toContain('weight 16/100');
  });
});
