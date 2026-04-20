import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

/**
 * Characterization tests for advisory-check isolation in `calculateOverallScore`.
 *
 * Purpose: pin the invariant that weight-0 "advisory" checks (e.g.
 * documentation, site-security, workflow-maturity) NEVER influence the
 * overall score regardless of their per-check score or N/A state.
 *
 * Context: the previous implementation included weight-0 checks in the
 * applicable set used to compute `totalApplicableWeight`. While a weight
 * of 0 contributes 0 to the sum directly, it broadened the set that the
 * coverage-penalty denominator was derived from. Adding the weight-0
 * `documentation` advisory caused the CI self-score to drop from 35 → 19
 * because the applicable-check accounting drifted. The fix excludes
 * weight-0 checks from the scoring applicable set entirely.
 */
describe('advisory-check isolation (coverage-scaling regression fix)', () => {
  it('adding a weight-0 check scoring 100 does not change the overall score', () => {
    const base = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: 100 },
      { id: 'coherence', score: 100 },
      { id: 'env-exposure', score: 100 },
    ];
    // Baseline: totalApplicableWeight = 10+14+14+8 = 46 (< 50 → penalty)
    const baseline = calculateOverallScore(base);

    const withAdvisoryPass = [
      ...base,
      { id: 'documentation', score: 100 }, // weight 0, advisory
      { id: 'workflow-maturity', score: 100 }, // weight 0, advisory
      { id: 'site-security', score: 100 }, // weight 0, advisory
    ];
    expect(calculateOverallScore(withAdvisoryPass)).toBe(baseline);
  });

  it('adding a weight-0 check scoring 0 does not change the overall score', () => {
    const base = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: 100 },
      { id: 'coherence', score: 100 },
    ];
    const baseline = calculateOverallScore(base);

    const withAdvisoryFail = [
      ...base,
      { id: 'documentation', score: 0 },
      { id: 'instruction-effectiveness', score: 0 },
    ];
    expect(calculateOverallScore(withAdvisoryFail)).toBe(baseline);
  });

  it('a weight-0 check going from N/A to applicable does not reduce the score', () => {
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'env-exposure', score: 100 },
      { id: 'permissions-hygiene', score: 100 },
    ];
    const whenAdvisoryNA = [...results, { id: 'documentation', score: NOT_APPLICABLE_SCORE }];
    const whenAdvisoryApplicable = [...results, { id: 'documentation', score: 100 }];

    expect(calculateOverallScore(whenAdvisoryApplicable)).toBe(
      calculateOverallScore(whenAdvisoryNA),
    );
  });

  it('a project with ONLY weight-0 applicable checks scores 0', () => {
    const results = [
      { id: 'claude-md', score: NOT_APPLICABLE_SCORE },
      { id: 'documentation', score: 100 },
      { id: 'workflow-maturity', score: 50 },
    ];
    expect(calculateOverallScore(results)).toBe(0);
  });

  it('regression pin — rigscore self-scan (simulated) stays at ~35 after adding documentation', () => {
    // Simulates the observed self-scan applicable set: claude-md(10, 100),
    // claude-settings(8, 96), env-exposure(8, 100), git-hooks(2, 85),
    // permissions-hygiene(4, 100), unicode-steganography(4, 100) +
    // advisories that must not perturb the score.
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'claude-settings', score: 96 },
      { id: 'env-exposure', score: 100 },
      { id: 'git-hooks', score: 85 },
      { id: 'permissions-hygiene', score: 100 },
      { id: 'unicode-steganography', score: 100 },
      { id: 'documentation', score: 100 },       // weight 0
      { id: 'workflow-maturity', score: 78 },    // weight 0
      { id: 'skill-coherence', score: 96 },      // weight 0
    ];
    // totalApplicableWeight (scored) = 10+8+8+2+4+4 = 36 (< 50 → penalty)
    // Internal weighted average ≈ 98.3 → penalty 98.3 * 0.36 ≈ 35.4 → 35
    expect(calculateOverallScore(results)).toBe(35);
  });
});
