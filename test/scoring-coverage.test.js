import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { COVERAGE_PENALTY_THRESHOLD } from '../src/constants.js';

/**
 * Characterization tests for the coverage-scaling formula in
 * `calculateOverallScore` (src/scoring.js).
 *
 * C6 (Track C): coverage scaling is now CONTINUOUS — the previous step at
 * `applicable_weight < COVERAGE_PENALTY_THRESHOLD (50)` has been removed in
 * favour of `scale = min(1, totalApplicableWeight / 100)`, applied always.
 * The old gameable cliff ("add one stub file to cross weight 50 and jump
 * from scaled to unscaled") is gone. These tests pin the new behavior.
 *
 * BREAKING: every test expectation below for totalApplicableWeight >= 50
 * has shifted. The accompanying commit documents the recalibration.
 */
describe('coverage-scaling formula (characterization — C6 continuous)', () => {
  describe('T3.1 — single low-weight check scales linearly with its weight', () => {
    // One applicable check, weight 14 (mcp-config). All others N/A.
    // Internal weighted average after proportional scaling to 100: S.
    // scale = min(1, 14/100) = 0.14; final = round(S * 0.14).
    it.each([
      // [rawCheckScore, expectedFinal]
      [100, 14],  // round(100 * 0.14) = 14
      [80, 11],   // round(80 * 0.14) = round(11.2) = 11
      [50, 7],    // round(50 * 0.14) = 7
      [0, 0],     // zeroed
    ])('raw score %d on single weight-14 check → final %d', (raw, expected) => {
      const results = [{ id: 'mcp-config', score: raw }];
      expect(calculateOverallScore(results)).toBe(expected);
    });
  });

  describe('T3.2 — applicable weight == 50 now scales continuously (no cliff)', () => {
    // Sum of weights here: 14 + 14 + 10 + 8 + 4 = 50. Under C6, scale = 0.5.
    it('five checks totaling weight 50, all score 80 → final 40 (continuous scaling)', () => {
      const results = [
        { id: 'mcp-config', score: 80 },              // 14
        { id: 'coherence', score: 80 },               // 14
        { id: 'skill-files', score: 80 },             // 10
        { id: 'claude-settings', score: 80 },         // 8
        { id: 'unicode-steganography', score: 80 },   // 4
      ];
      // scale = 50/100 = 0.5 → final = round(80 * 0.5) = 40
      expect(calculateOverallScore(results)).toBe(40);
    });

    it('legacy COVERAGE_PENALTY_THRESHOLD constant still exported (backwards compat)', () => {
      // Kept as an exported constant even though the formula no longer
      // references it — external consumers may still import it.
      expect(COVERAGE_PENALTY_THRESHOLD).toBe(50);
    });
  });

  describe('T3.3 — monotonicity and no cliff at 49 → 50 → 51', () => {
    it('all checks score 100: final scores are smoothly non-decreasing across 49 → 50 → 51', () => {
      const buildResults = (weight) => ({
        results: [{ id: 'solo', score: 100 }],
        weights: { solo: weight },
      });

      const s49 = calculateOverallScore(buildResults(49).results, buildResults(49).weights);
      const s50 = calculateOverallScore(buildResults(50).results, buildResults(50).weights);
      const s51 = calculateOverallScore(buildResults(51).results, buildResults(51).weights);

      // New values under continuous scaling (scale = min(1, w/100)):
      //   s49 = round(100 * 0.49) = 49
      //   s50 = round(100 * 0.50) = 50
      //   s51 = round(100 * 0.51) = 51
      // No cliff; strictly monotonic.
      expect(s49).toBe(49);
      expect(s50).toBe(50);
      expect(s51).toBe(51);
      expect(s49).toBeLessThanOrEqual(s50);
      expect(s50).toBeLessThanOrEqual(s51);
    });

    it('mid-range raw scores: smoothly monotonic across 49 → 50 → 51', () => {
      const results = [{ id: 'solo', score: 60 }];

      const s49 = calculateOverallScore(results, { solo: 49 });
      const s50 = calculateOverallScore(results, { solo: 50 });
      const s51 = calculateOverallScore(results, { solo: 51 });

      // s49 = round(60 * 0.49) = round(29.4) = 29
      // s50 = round(60 * 0.50) = 30
      // s51 = round(60 * 0.51) = round(30.6) = 31
      expect(s49).toBe(29);
      expect(s50).toBe(30);
      expect(s51).toBe(31);
      expect(s49).toBeLessThanOrEqual(s50);
      expect(s50).toBeLessThanOrEqual(s51);
    });

    it('all-zero raw scores: scale factor does not produce negative values', () => {
      const results = [{ id: 'solo', score: 0 }];
      expect(calculateOverallScore(results, { solo: 49 })).toBe(0);
      expect(calculateOverallScore(results, { solo: 50 })).toBe(0);
      expect(calculateOverallScore(results, { solo: 51 })).toBe(0);
    });
  });

  describe('T3.4 — full coverage is a no-op', () => {
    // scale = min(1, totalApplicableWeight / 100) caps at 1 so projects with
    // every applicable check contributing don't lose points to coverage.
    it('total applicable weight == 100 → scale = 1 (no coverage penalty)', () => {
      const results = [{ id: 'solo', score: 90 }];
      expect(calculateOverallScore(results, { solo: 100 })).toBe(90);
    });

    it('total applicable weight > 100 still caps scale at 1', () => {
      const results = [{ id: 'solo', score: 90 }];
      expect(calculateOverallScore(results, { solo: 150 })).toBe(90);
    });
  });
});
