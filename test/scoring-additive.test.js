import { describe, it, expect } from 'vitest';
import { calculateCheckScore, calculateOverallScore } from '../src/scoring.js';
import { SEVERITY, NOT_APPLICABLE_SCORE } from '../src/constants.js';

describe('additive scoring model', () => {
  describe('WARNING curve', () => {
    it.each([
      [1, 85],
      [2, 70],
      [3, 55],
      [4, 40],
      [5, 25],
      [6, 10],
      [7, 0],
    ])('%d WARNING(s) → score %d', (count, expected) => {
      const findings = Array.from({ length: count }, () => ({ severity: SEVERITY.WARNING }));
      expect(calculateCheckScore(findings)).toBe(expected);
    });
  });

  describe('INFO curve', () => {
    it.each([
      [1, 98],
      [4, 92],
      [8, 84],
      [16, 68],
      [25, 50],  // hits INFO-only floor
      [32, 50],  // still at floor
      [50, 50],  // still at floor
    ])('%d INFO(s) → score %d', (count, expected) => {
      const findings = Array.from({ length: count }, () => ({ severity: SEVERITY.INFO }));
      expect(calculateCheckScore(findings)).toBe(expected);
    });
  });

  describe('INFO-only floor', () => {
    it('INFO alone cannot push below 50', () => {
      const findings = Array.from({ length: 100 }, () => ({ severity: SEVERITY.INFO }));
      expect(calculateCheckScore(findings)).toBe(50);
    });

    it('INFO floor does not apply when WARNINGs are present', () => {
      // 1 WARNING (-15) + 25 INFOs (-50) = 100 - 15 - 50 = 35
      const findings = [
        { severity: SEVERITY.WARNING },
        ...Array.from({ length: 25 }, () => ({ severity: SEVERITY.INFO })),
      ];
      expect(calculateCheckScore(findings)).toBe(35);
    });
  });

  describe('mixed findings', () => {
    it('WARNING + INFO deductions combine', () => {
      // 1 WARNING (-15) + 1 INFO (-2) = 83
      const findings = [
        { severity: SEVERITY.WARNING },
        { severity: SEVERITY.INFO },
      ];
      expect(calculateCheckScore(findings)).toBe(83);
    });

    it('CRITICAL still zeros regardless of other findings', () => {
      const findings = [
        { severity: SEVERITY.CRITICAL },
        { severity: SEVERITY.WARNING },
        { severity: SEVERITY.INFO },
        { severity: SEVERITY.PASS },
      ];
      expect(calculateCheckScore(findings)).toBe(0);
    });

    it('PASS and SKIPPED do not affect score', () => {
      const findings = [
        { severity: SEVERITY.PASS },
        { severity: SEVERITY.PASS },
        { severity: SEVERITY.SKIPPED },
      ];
      expect(calculateCheckScore(findings)).toBe(100);
    });
  });

  describe('coverage penalty', () => {
    it('no penalty when applicable weight >= 60', () => {
      // All checks present = weight 100
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: 100 },
        { id: 'env-exposure', score: 100 },
        { id: 'docker-security', score: 100 },
        { id: 'git-hooks', score: 100 },
        { id: 'skill-files', score: 100 },
        { id: 'permissions-hygiene', score: 100 },
      ];
      expect(calculateOverallScore(results)).toBe(100);
    });

    it('penalty applies when applicable weight < 60', () => {
      // Only claude-md (15) + env-exposure (13) = 28 applicable weight
      // Internal = 100, penalty: 100 * 0.28 = 28
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
        { id: 'env-exposure', score: 100 },
        { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
        { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
        { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
        { id: 'permissions-hygiene', score: NOT_APPLICABLE_SCORE },
      ];
      expect(calculateOverallScore(results)).toBe(28);
    });

    it('CLAUDE.md-only project scoring 100 internally gets penalized to 15', () => {
      // Only claude-md (15) applicable = weight 15
      // Internal = 100, penalty: 100 * 0.15 = 15
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
        { id: 'env-exposure', score: NOT_APPLICABLE_SCORE },
        { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
        { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
        { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
        { id: 'permissions-hygiene', score: NOT_APPLICABLE_SCORE },
      ];
      expect(calculateOverallScore(results)).toBe(15);
    });

    it('penalty applies at weight 40 (just below threshold)', () => {
      // claude-md:15 + docker:10 + git-hooks:8 + permissions:7 = 40
      // Internal = 100, penalty: 100 * 0.40 = 40
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
        { id: 'env-exposure', score: NOT_APPLICABLE_SCORE },
        { id: 'docker-security', score: 100 },
        { id: 'git-hooks', score: 100 },
        { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
        { id: 'permissions-hygiene', score: 100 },
      ];
      expect(calculateOverallScore(results)).toBe(40);
    });

    it('no penalty at weight 60 (exact threshold boundary)', () => {
      // claude-md:15 + mcp:12 + env:13 + deep-secrets:12 + git-hooks:8 = 60
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: 100 },
        { id: 'env-exposure', score: 100 },
        { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
        { id: 'git-hooks', score: 100 },
        { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
        { id: 'permissions-hygiene', score: NOT_APPLICABLE_SCORE },
        { id: 'coherence', score: NOT_APPLICABLE_SCORE },
        { id: 'deep-secrets', score: 100 },
      ];
      expect(calculateOverallScore(results)).toBe(100);
    });

    it('penalty applies at weight 45', () => {
      // claude-md:15 + env:13 + docker:10 + permissions:7 = 45
      // Internal = 100, penalty: 100 * 0.45 = 45
      const results = [
        { id: 'claude-md', score: 100 },
        { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
        { id: 'env-exposure', score: 100 },
        { id: 'docker-security', score: 100 },
        { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
        { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
        { id: 'permissions-hygiene', score: 100 },
      ];
      expect(calculateOverallScore(results)).toBe(45);
    });
  });

  describe('recursive average masking (known limitation)', () => {
    it('average of 9×95 + 1×10 = 87, Grade B, despite catastrophic project', () => {
      const scores = [...Array(9).fill(95), 10];
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      expect(avg).toBe(87);
      expect(avg).toBeGreaterThanOrEqual(75); // Grade B threshold
    });
  });
});
