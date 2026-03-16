import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

describe('N/A score weight redistribution', () => {
  it('redistributes weight when some checks are N/A', () => {
    // Only claude-md (weight 20) and env-exposure (weight 20) are applicable
    // Both score 100 => should be 100
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(100);
  });

  it('returns 0 when all checks are N/A', () => {
    const results = [
      { id: 'claude-md', score: NOT_APPLICABLE_SCORE },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: NOT_APPLICABLE_SCORE },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: NOT_APPLICABLE_SCORE },
    ];
    expect(calculateOverallScore(results)).toBe(0);
  });

  it('calculates correctly with mixed N/A and scored checks', () => {
    // claude-md (w20) = 50, env-exposure (w20) = 100, permissions (w10) = 100
    // Total applicable weight = 50. Scaled weights: 40, 40, 20
    // Score = (50/100)*40 + (100/100)*40 + (100/100)*20 = 20 + 40 + 20 = 80
    const results = [
      { id: 'claude-md', score: 50 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(80);
  });

  it('gives same result as before when no checks are N/A', () => {
    const results = [
      { id: 'claude-md', score: 50 },
      { id: 'mcp-config', score: 80 },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: 0 },
      { id: 'git-hooks', score: 100 },
      { id: 'skill-files', score: 60 },
      { id: 'permissions-hygiene', score: 100 },
    ];
    // Same as existing test: 10 + 12 + 20 + 0 + 10 + 6 + 10 = 68
    expect(calculateOverallScore(results)).toBe(68);
  });
});
