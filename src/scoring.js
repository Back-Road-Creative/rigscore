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
 * ── Coverage scaling (design note) ──────────────────────────────────────
 *
 * "Coverage" means the sum of WEIGHTS[id] for every check that was actually
 * applicable to this project (i.e. not N/A). Scoring is additive-deduction
 * within each check, then combined across checks as a weight-proportional
 * average. When applicable coverage is low — fewer than
 * COVERAGE_PENALTY_THRESHOLD points of weight out of 100 — we additionally
 * scale the result by (totalApplicableWeight / 100). A project where only a
 * handful of checks can reach a verdict should not be able to claim a
 * perfect 100; partial coverage means partial confidence.
 *
 * Why additive deduction + coverage scaling, not averaged confidence:
 *   - The per-check score already answers "how clean is this one surface?".
 *   - The overall score additionally answers "how much of the attack
 *     surface did we actually measure?".
 *   - Conflating the two (e.g. ignoring N/A checks entirely) rewards
 *     under-configured projects for being invisible to the scanner.
 *
 * Known edge — discontinuity at the threshold:
 *   At coverage just below 50, the reported score is scaled; at coverage of
 *   exactly 50 and above, it is not. This produces a visible step. It is
 *   intentional and user-decision-gated: smoothing the curve would shift
 *   every existing score for zero correctness benefit. The sequence is
 *   monotonically non-decreasing (no dip), which is the hard contract.
 *   See H1 in the hostile review and test/scoring-coverage.test.js for the
 *   characterization tests that pin this behavior exactly.
 *
 * If you ever need to change coverage scaling, update the characterization
 * tests first, get sign-off on the score shift, then update the formula —
 * in that order.
 */
export function calculateOverallScore(results, customWeights) {
  const w = customWeights || WEIGHTS;
  const applicable = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  if (applicable.length === 0) return 0;

  const totalApplicableWeight = applicable.reduce((sum, r) => sum + (w[r.id] || 0), 0);
  if (totalApplicableWeight === 0) return 0;

  let total = 0;
  for (const result of applicable) {
    const weight = w[result.id] || 0;
    // Scale weight proportionally so applicable weights sum to 100
    const scaledWeight = (weight / totalApplicableWeight) * 100;
    total += (result.score / 100) * scaledWeight;
  }

  let score = Math.round(total);

  // Coverage penalty: projects with low applicable weight get scaled down
  if (totalApplicableWeight < COVERAGE_PENALTY_THRESHOLD) {
    score = Math.round(score * (totalApplicableWeight / 100));
  }

  // Compound risk penalty: coherence CRITICAL findings indicate systemic failure
  const coherenceResult = results.find((r) => r.id === 'coherence');
  if (coherenceResult && coherenceResult.findings) {
    const hasCritical = coherenceResult.findings.some((f) => f.severity === 'critical');
    if (hasCritical) {
      score = Math.max(0, score - 10);
    }
  }

  return score;
}
