import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

describe('N/A score weight redistribution', () => {
  it('redistributes weight when some checks are N/A (above threshold)', () => {
    // claude-md(15) + mcp(12) + env(13) + git-hooks(8) + skill(8) + perms(7) = 63
    // Total applicable weight = 63 >= 60 — no penalty
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: 100 },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: 100 },
      { id: 'skill-files', score: 100 },
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
      { id: 'coherence', score: NOT_APPLICABLE_SCORE },
      { id: 'deep-secrets', score: NOT_APPLICABLE_SCORE },
    ];
    expect(calculateOverallScore(results)).toBe(0);
  });

  it('applies coverage penalty when applicable weight is below threshold', () => {
    // claude-md (w15) + env-exposure (w13) + permissions (w7) = 35 applicable weight
    // Internal = (50*15 + 100*13 + 100*7)/35 = (750+1300+700)/35 = 2750/35 = 78.57 → 79
    // Coverage penalty: 79 * (35/100) = 27.65 → 28
    const results = [
      { id: 'claude-md', score: 50 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(28);
  });

  it('all-100 with low applicable weight gets coverage penalty', () => {
    // claude-md (w15) + env-exposure (w13) + permissions (w7) = 35 applicable weight
    // Internal = 100, penalty: 100 * 0.35 = 35
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(35);
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
    // totalApplicableWeight = 73 >= 60, no penalty
    // (750+960+1300+0+800+480+700)/73 = 4990/73 = 68.36 → 68
    expect(calculateOverallScore(results)).toBe(68);
  });
});
