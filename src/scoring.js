import { SEVERITY_DEDUCTIONS, INFO_ONLY_FLOOR, WEIGHTS, PRACTICE_WEIGHTS, NOT_APPLICABLE_SCORE } from './constants.js';

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
 * "Coverage" (W) means the sum of WEIGHTS[id] for every check that was
 * actually applicable to this project (i.e. not N/A). Scoring is additive-
 * deduction within each check, then combined across checks as a weight-
 * proportional average. That average is then scaled by min(1, W / 100) —
 * ALWAYS, with no threshold and no step. Partial coverage means partial
 * confidence: W is the reachable ceiling, so a project where only part of
 * the check suite can reach a verdict cannot claim a perfect 100 (at W = 80,
 * an all-passing scan reports 80). Full coverage (W >= 100) is a no-op.
 *
 * Why additive deduction + coverage scaling, not averaged confidence:
 *   - The per-check score already answers "how clean is this one surface?".
 *   - The overall score additionally answers "how much of the attack
 *     surface did we actually measure?".
 *   - Conflating the two (e.g. ignoring N/A checks entirely) rewards
 *     under-configured projects for being invisible to the scanner.
 *
 * Order of operations: coverage scaling first, THEN the security-axis
 * compound-risk penalty (coherence CRITICAL) subtracts a flat 10 points from
 * the already-scaled score, floored at 0. The penalty is not itself scaled.
 *
 * test/scoring-coverage.test.js holds the characterization tests that pin
 * this behavior exactly. If you ever need to change coverage scaling, update
 * those tests first, get sign-off on the score shift, then update the
 * formula — in that order.
 */
export function calculateOverallScore(results, customWeights, options = {}) {
  const w = customWeights || WEIGHTS;
  const { compoundRiskPenalty = true } = options;
  // Weight-0 advisory checks MUST NOT affect coverage math. A check that
  // contributes 0 to the score should neither count toward applicable-check
  // totals nor inflate/deflate the coverage-penalty denominator. Prior bug:
  // adding the weight-0 `documentation` advisory shifted CI self-score from
  // 35 → 19 because advisory N/A states drifted the applicable ratio.
  const scoringApplicable = results.filter(
    (r) => r.score !== NOT_APPLICABLE_SCORE && (w[r.id] || 0) > 0,
  );
  if (scoringApplicable.length === 0) return 0;

  const totalApplicableWeight = scoringApplicable.reduce((sum, r) => sum + (w[r.id] || 0), 0);
  if (totalApplicableWeight === 0) return 0;

  let total = 0;
  for (const result of scoringApplicable) {
    const weight = w[result.id] || 0;
    // Scale weight proportionally so applicable weights sum to 100
    const scaledWeight = (weight / totalApplicableWeight) * 100;
    total += (result.score / 100) * scaledWeight;
  }

  // C6: continuous coverage scaling. Previous formula applied
  //   score *= (totalApplicableWeight / 100)
  // ONLY when totalApplicableWeight was below 50 — the legacy
  // COVERAGE_PENALTY_THRESHOLD, still exported from constants.js for external
  // consumers but deliberately no longer read here. That step created a
  // gameable cliff: a single stub governance file that pushed applicable
  // weight from 48 → 50 jumped the reported score from (scaled) to
  // (unscaled). Now the scale factor is always applied, up to a ceiling of 1
  // (i.e. coverage >= 100 is a no-op). Partial coverage means partial
  // confidence — every time.
  const scale = Math.min(1, totalApplicableWeight / 100);
  let score = Math.round(total * scale);

  // Compound risk penalty: coherence CRITICAL findings indicate systemic failure.
  // SECURITY-AXIS ONLY. `coherence` is a security concept (contradictory
  // instructions + over-broad tools), it carries no Practice weight, and letting
  // it dock 10 points off a Practice score would make a security failure look
  // like a workflow failure. Callers scoring a non-security axis opt out.
  if (compoundRiskPenalty) {
    const coherenceResult = results.find((r) => r.id === 'coherence');
    if (coherenceResult && coherenceResult.findings) {
      const hasCritical = coherenceResult.findings.some((f) => f.severity === 'critical');
      if (hasCritical) {
        score = Math.max(0, score - 10);
      }
    }
  }

  return score;
}

// AI-tooling surface checks. If NONE is applicable, the dir has no agent-config
// surface — so a sub-100 headline is pure coverage-scaling, not a verdict.
const AI_SURFACE_CHECK_IDS = new Set([
  'governance-docs', 'skill-files', 'mcp-config', 'coherence', 'claude-settings',
]);

// Checks that apply to ANY directory (they scan for the presence/absence of
// secret leaks and file-permission problems, so they never go N/A). Their being
// applicable does NOT mean the dir has a scannable surface — an empty dir still
// runs them. Any OTHER weight-bearing check that applied means a real artifact
// (a Dockerfile, git hooks, source secrets …) was actually scanned.
const ALWAYS_ON_CHECK_IDS = new Set(['env-exposure', 'permissions-hygiene']);

/**
 * True for a surface-free directory: no AI-tooling surface, ONLY the always-on
 * baseline checks applied, and every one of them scored a perfect 100. There, the
 * only reason the weighted score sits below 100 is coverage scaling on an empty
 * repo — reporting "12/100 Grade F" libels it. If any non-baseline check applied
 * (a Dockerfile was scanned) OR any applicable check found something, there IS a
 * verdict to report, so we return the honest score instead.
 */
function isNothingToScan(results, weights) {
  const w = weights || WEIGHTS;
  if (results.some((r) => AI_SURFACE_CHECK_IDS.has(r.id) && r.score !== NOT_APPLICABLE_SCORE)) {
    return false;
  }
  const scoring = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE && (w[r.id] || 0) > 0);
  if (scoring.length === 0) return false;
  if (scoring.some((r) => !ALWAYS_ON_CHECK_IDS.has(r.id))) return false;
  return scoring.every((r) => r.score === 100);
}

/**
 * THE single place a scan's headline score is computed; scanner and CLI both
 * route through it. Returns `{ score, notApplicable }`. Under `--check` the
 * weighted axis is meaningless, so selected checks are averaged; when EVERY
 * selected check is N/A there is nothing to average — `notApplicable`, `score:
 * null`, never a fabricated 0 (which rendered as 0/100 Grade F exit 1). An
 * unknown/typo'd `--check` id (no check matched) keeps its red.
 *
 * A surface-free dir (no AI surface, every scoring check perfect) also returns
 * `notApplicable` — "nothing to scan" is the honest answer, not "12/100 Grade F".
 */
export function scoreScan(results, weights, checkFilter) {
  if (!checkFilter) {
    if (isNothingToScan(results, weights)) {
      return { score: null, notApplicable: true, nothingToScan: true };
    }
    return { score: calculateOverallScore(results, weights), notApplicable: false };
  }
  if (results.length === 0) return { score: 0, notApplicable: false };
  const applicable = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  if (applicable.length === 0) return { score: null, notApplicable: true };
  const avg = applicable.reduce((sum, r) => sum + r.score, 0) / applicable.length;
  return { score: Math.round(avg), notApplicable: false };
}

/**
 * Practice-axis score (0-100), or `null` when the repo has NO practice surface
 * at all (every practice check N/A). Null — not 0 — is the honest answer there:
 * a repo with no agent loops, no specs and no memory files isn't "bad at driving
 * agents", it simply isn't in scope, and a 0 would libel it.
 *
 * Same scorer as the Security axis, same coverage scaling / N/A redistribution /
 * INFO floor — only the weights map differs. The security-only compound-risk
 * penalty is explicitly disabled (see above).
 */
export function calculatePracticeScore(results) {
  const applicable = results.filter(
    (r) => r.score !== NOT_APPLICABLE_SCORE && (PRACTICE_WEIGHTS[r.id] || 0) > 0,
  );
  if (applicable.length === 0) return null;
  return calculateOverallScore(results, PRACTICE_WEIGHTS, { compoundRiskPenalty: false });
}
