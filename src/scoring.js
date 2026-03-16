import { SEVERITY_MULTIPLIERS, WEIGHTS, NOT_APPLICABLE_SCORE } from './constants.js';

/**
 * Calculate a check's score (0-100) from its findings.
 * CRITICAL zeros the score, WARNINGs multiply down by 0.5 each.
 */
export function calculateCheckScore(findings) {
  if (findings.length === 0) return 100;

  let multiplier = 1;
  for (const finding of findings) {
    const m = SEVERITY_MULTIPLIERS[finding.severity];
    if (m === undefined) continue;
    multiplier *= m;
  }

  return Math.round(multiplier * 100);
}

/**
 * Calculate overall weighted score from check results.
 * Each result: { id, score }. Weights come from constants.
 * N/A checks (score === -1) are excluded and their weight is
 * redistributed proportionally among applicable checks.
 */
export function calculateOverallScore(results) {
  const applicable = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  if (applicable.length === 0) return 0;

  const totalApplicableWeight = applicable.reduce((sum, r) => sum + (WEIGHTS[r.id] || 0), 0);
  if (totalApplicableWeight === 0) return 0;

  let total = 0;
  for (const result of applicable) {
    const weight = WEIGHTS[result.id] || 0;
    // Scale weight proportionally so applicable weights sum to 100
    const scaledWeight = (weight / totalApplicableWeight) * 100;
    total += (result.score / 100) * scaledWeight;
  }
  return Math.round(total);
}
