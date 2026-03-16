import { SEVERITY_DEDUCTIONS, INFO_ONLY_FLOOR, WEIGHTS, NOT_APPLICABLE_SCORE, COVERAGE_PENALTY_THRESHOLD } from './constants.js';

/**
 * Calculate a check's score (0-100) from its findings.
 * Uses additive deductions: CRITICAL zeros the score,
 * WARNINGs deduct 15pts each, INFOs deduct 2pts each.
 * INFO-only findings cannot push below INFO_ONLY_FLOOR.
 */
export function calculateCheckScore(findings) {
  if (findings.length === 0) return 100;

  let warningCount = 0;
  let infoCount = 0;

  for (const finding of findings) {
    const deduction = SEVERITY_DEDUCTIONS[finding.severity];
    if (deduction === undefined) continue;
    // CRITICAL → zero the check
    if (deduction === null) return 0;
    if (deduction === -15) warningCount++;
    if (deduction === -2) infoCount++;
  }

  let score = 100 - (warningCount * 15) - (infoCount * 2);
  score = Math.max(0, score);

  // INFO-only floor: if there are no WARNINGs, INFO alone can't push below the floor
  if (warningCount === 0) {
    score = Math.max(INFO_ONLY_FLOOR, score);
  }

  return Math.round(score);
}

/**
 * Calculate overall weighted score from check results.
 * Each result: { id, score }. Weights come from constants.
 * N/A checks (score === -1) are excluded and their weight is
 * redistributed proportionally among applicable checks.
 *
 * Coverage penalty: if total applicable weight < COVERAGE_PENALTY_THRESHOLD,
 * the score is scaled down by (totalApplicableWeight / 100).
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

  let score = Math.round(total);

  // Coverage penalty: projects with low applicable weight get scaled down
  if (totalApplicableWeight < COVERAGE_PENALTY_THRESHOLD) {
    score = Math.round(score * (totalApplicableWeight / 100));
  }

  return score;
}
