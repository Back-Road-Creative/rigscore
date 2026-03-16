import { describe, it, expect } from 'vitest';
import { calculateCheckScore, calculateOverallScore } from '../src/scoring.js';
import { SEVERITY } from '../src/constants.js';

describe('calculateCheckScore', () => {
  it('returns 100 when all findings are PASS', () => {
    const findings = [
      { severity: SEVERITY.PASS },
      { severity: SEVERITY.PASS },
    ];
    expect(calculateCheckScore(findings)).toBe(100);
  });

  it('returns 0 when any finding is CRITICAL', () => {
    const findings = [
      { severity: SEVERITY.PASS },
      { severity: SEVERITY.CRITICAL },
    ];
    expect(calculateCheckScore(findings)).toBe(0);
  });

  it('returns 85 when one finding is WARNING (additive -15)', () => {
    const findings = [
      { severity: SEVERITY.PASS },
      { severity: SEVERITY.WARNING },
    ];
    expect(calculateCheckScore(findings)).toBe(85);
  });

  it('returns 100 for empty findings', () => {
    expect(calculateCheckScore([])).toBe(100);
  });

  it('INFO findings reduce score by 2 each', () => {
    const findings = [
      { severity: SEVERITY.PASS },
      { severity: SEVERITY.INFO },
    ];
    expect(calculateCheckScore(findings)).toBe(98);
  });

  it('multiple WARNINGs stack additively', () => {
    const findings = [
      { severity: SEVERITY.WARNING },
      { severity: SEVERITY.WARNING },
    ];
    // 100 - 15 - 15 = 70
    expect(calculateCheckScore(findings)).toBe(70);
  });
});

describe('calculateOverallScore', () => {
  it('returns 100 when all checks score 100', () => {
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

  it('returns 0 when all checks score 0', () => {
    const results = [
      { id: 'claude-md', score: 0 },
      { id: 'mcp-config', score: 0 },
      { id: 'env-exposure', score: 0 },
      { id: 'docker-security', score: 0 },
      { id: 'git-hooks', score: 0 },
      { id: 'skill-files', score: 0 },
      { id: 'permissions-hygiene', score: 0 },
    ];
    expect(calculateOverallScore(results)).toBe(0);
  });

  it('calculates weighted sum correctly', () => {
    const results = [
      { id: 'claude-md', score: 50 },              // 50 * 20/100 = 10
      { id: 'mcp-config', score: 80 },             // 80 * 15/100 = 12
      { id: 'env-exposure', score: 100 },           // 100 * 20/100 = 20
      { id: 'docker-security', score: 0 },          // 0 * 15/100 = 0
      { id: 'git-hooks', score: 100 },              // 100 * 10/100 = 10
      { id: 'skill-files', score: 60 },             // 60 * 10/100 = 6
      { id: 'permissions-hygiene', score: 100 },    // 100 * 10/100 = 10
    ];
    // Total = 10 + 12 + 20 + 0 + 10 + 6 + 10 = 68
    expect(calculateOverallScore(results)).toBe(68);
  });

  it('rounds to integer', () => {
    const results = [
      { id: 'claude-md', score: 33 },
      { id: 'mcp-config', score: 33 },
      { id: 'env-exposure', score: 33 },
      { id: 'docker-security', score: 33 },
      { id: 'git-hooks', score: 33 },
      { id: 'skill-files', score: 33 },
      { id: 'permissions-hygiene', score: 33 },
    ];
    // 33 * (20+15+20+15+10+10+10)/100 = 33 * 1 = 33
    expect(calculateOverallScore(results)).toBe(33);
  });
});
