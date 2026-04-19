import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { COVERAGE_PENALTY_THRESHOLD } from '../src/constants.js';

/**
 * Characterization tests for the coverage-scaling formula in
 * `calculateOverallScore` (src/scoring.js).
 *
 * Purpose: pin the CURRENT behavior of coverage scaling so any future
 * refactor that changes the user-visible score surfaces immediately.
 *
 * Context: a hostile review flagged (H1) that `score * applicable_weight / 100`
 * applied only when `applicable_weight < COVERAGE_PENALTY_THRESHOLD` produces a
 * mathematical discontinuity at the threshold. The user decision was:
 * document, do not smooth — partial coverage legitimately means partial
 * confidence, and smoothing would shift every user-visible score for zero
 * correctness benefit.
 *
 * These tests encode the formula as it stands today. They are NOT aspirational
 * — if one ever fails, it means behavior changed and the change needs an
 * explicit user decision.
 */
describe('coverage-scaling formula (characterization)', () => {
  describe('T3.1 — single low-weight check scales linearly with its weight', () => {
    // One applicable check, weight 14 (mcp-config). All others N/A.
    // Internal weighted average after proportional scaling to 100:
    //   (S/100) * ((14/14) * 100) = S
    // totalApplicableWeight = 14, which is < COVERAGE_PENALTY_THRESHOLD (50):
    //   final = round(S * 14 / 100)
    it.each([
      // [rawCheckScore, expectedFinal]
      [100, 14],  // round(100 * 14/100) = 14
      [80, 11],   // round(80 * 14/100) = round(11.2) = 11
      [50, 7],    // round(50 * 14/100) = 7
      [0, 0],     // zeroed
    ])('raw score %d on single weight-14 check → final %d', (raw, expected) => {
      const results = [{ id: 'mcp-config', score: raw }];
      expect(calculateOverallScore(results)).toBe(expected);
    });
  });

  describe('T3.2 — applicable weight == 50 sits exactly on the threshold (penalty NOT applied)', () => {
    // COVERAGE_PENALTY_THRESHOLD is 50 and the condition is strict `<`.
    // Sum of weights here: 14 + 14 + 10 + 8 + 4 = 50.
    // Because 50 is NOT less than 50, no coverage scaling is applied —
    // final score equals the internal weighted average.
    it('five checks totaling weight 50, all score 80 → final 80 (no penalty)', () => {
      const results = [
        { id: 'mcp-config', score: 80 },              // 14
        { id: 'coherence', score: 80 },               // 14
        { id: 'skill-files', score: 80 },             // 10
        { id: 'claude-settings', score: 80 },         // 8
        { id: 'unicode-steganography', score: 80 },   // 4
      ];
      // totalApplicableWeight = 50, threshold check (50 < 50) is false.
      // Internal: (80/100) * 100 (scaledWeights sum to 100) = 80.
      expect(calculateOverallScore(results)).toBe(80);
    });

    it('confirms the threshold constant has not drifted', () => {
      // If this assertion ever fails, update the T3.1/T3.2/T3.3 math.
      expect(COVERAGE_PENALTY_THRESHOLD).toBe(50);
    });
  });

  describe('T3.3 — monotonicity across the threshold (49 → 50 → 51)', () => {
    // Real weights are all even, so 49/51 are unreachable without custom
    // weights. We use customWeights to build the three boundary scenarios
    // and assert the final scores are non-decreasing.
    //
    // This is the characterization of H1: a visible cliff at the threshold
    // is permitted as long as the sequence is monotonically non-decreasing
    // (no dip). Current code satisfies this.
    it('all checks score 100: final scores are non-decreasing across 49 → 50 → 51', () => {
      const buildResults = (weight) => ({
        results: [{ id: 'solo', score: 100 }],
        weights: { solo: weight },
      });

      const at49 = buildResults(49);
      const at50 = buildResults(50);
      const at51 = buildResults(51);

      const s49 = calculateOverallScore(at49.results, at49.weights);
      const s50 = calculateOverallScore(at50.results, at50.weights);
      const s51 = calculateOverallScore(at51.results, at51.weights);

      // Expected exact values (pinned):
      //   s49 = round(100 * 49/100) = 49 (penalty applies: 49 < 50)
      //   s50 = 100                 (penalty skipped: 50 is NOT < 50)
      //   s51 = 100                 (penalty skipped: 51 > 50)
      expect(s49).toBe(49);
      expect(s50).toBe(100);
      expect(s51).toBe(100);

      // Monotonic non-decreasing — the core contract.
      expect(s49).toBeLessThanOrEqual(s50);
      expect(s50).toBeLessThanOrEqual(s51);
    });

    it('mid-range raw scores: non-decreasing across 49 → 50 → 51', () => {
      // Sanity check with a non-perfect raw score so the cliff is visible
      // but still monotonic.
      const results = [{ id: 'solo', score: 60 }];

      const s49 = calculateOverallScore(results, { solo: 49 });
      const s50 = calculateOverallScore(results, { solo: 50 });
      const s51 = calculateOverallScore(results, { solo: 51 });

      // s49 = round(60 * 49/100) = round(29.4) = 29
      // s50 = 60
      // s51 = 60
      expect(s49).toBe(29);
      expect(s50).toBe(60);
      expect(s51).toBe(60);

      expect(s49).toBeLessThanOrEqual(s50);
      expect(s50).toBeLessThanOrEqual(s51);
    });

    it('all-zero raw scores: threshold does not produce negative or dipping values', () => {
      const results = [{ id: 'solo', score: 0 }];

      const s49 = calculateOverallScore(results, { solo: 49 });
      const s50 = calculateOverallScore(results, { solo: 50 });
      const s51 = calculateOverallScore(results, { solo: 51 });

      expect(s49).toBe(0);
      expect(s50).toBe(0);
      expect(s51).toBe(0);
    });
  });

  // T3.4 intentionally skipped: smoothing was the not-chosen alternative.
  // See README "Scoring" section and src/scoring.js block comment for
  // the full rationale.
});
