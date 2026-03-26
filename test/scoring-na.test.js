import { describe, it, expect } from 'vitest';
import { calculateOverallScore } from '../src/scoring.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

describe('N/A score weight redistribution', () => {
  it('redistributes weight when some checks are N/A (above threshold)', () => {
    // claude-md(12) + mcp(18) + env(10) + git-hooks(6) + skill(12) + perms(6) = 64
    // Total applicable weight = 64 >= 60 — no penalty
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
    // claude-md (w10) + env-exposure (w8) + permissions (w4) = 22 applicable weight
    // Internal = (50*10 + 100*8 + 100*4)/22 = (500+800+400)/22 = 1700/22 = 77.27 → 77
    // Coverage penalty: 77 * (22/100) = 16.94 → 17
    const results = [
      { id: 'claude-md', score: 50 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(17);
  });

  it('all-100 with low applicable weight gets coverage penalty', () => {
    // claude-md (w10) + env-exposure (w8) + permissions (w4) = 22 applicable weight
    // Internal = 100, penalty: 100 * 0.22 = 22
    const results = [
      { id: 'claude-md', score: 100 },
      { id: 'mcp-config', score: NOT_APPLICABLE_SCORE },
      { id: 'env-exposure', score: 100 },
      { id: 'docker-security', score: NOT_APPLICABLE_SCORE },
      { id: 'git-hooks', score: NOT_APPLICABLE_SCORE },
      { id: 'skill-files', score: NOT_APPLICABLE_SCORE },
      { id: 'permissions-hygiene', score: 100 },
    ];
    expect(calculateOverallScore(results)).toBe(22);
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
    // totalApplicableWeight = 12+18+10+8+6+12+6 = 72 >= 60, no penalty
    // (50*12+80*18+100*10+0*8+100*6+60*12+100*6)/72 = (600+1440+1000+0+600+720+600)/72 = 4960/72 = 68.89 → 69
    expect(calculateOverallScore(results)).toBe(69);
  });
});
