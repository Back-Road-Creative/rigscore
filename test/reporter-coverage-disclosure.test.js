import { describe, it, expect } from 'vitest';
import { formatTerminal, stripAnsi } from '../src/reporter.js';
import { calculateOverallScore } from '../src/scoring.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

/**
 * The scorer scales the overall score by `min(1, applicableWeight / 100)`
 * (src/scoring.js) — ANY applicable weight below 100 scales the score down.
 * The terminal report must say so whenever it happens, or a user whose every
 * check scored a perfect 100 sees an unexplained 80/100.
 *
 * Regression: the disclosure used to fire only below weight 60 — a threshold
 * that matched nothing in the scorer — so weights 60..99 were silently scaled.
 */

/** Build a full 27-check result set; ids in `naIds` are N/A, everything else scores `score`. */
function buildResult(naIds, score = 100) {
  const na = new Set(naIds);
  const results = Object.entries(WEIGHTS).map(([id, weight]) => ({
    id,
    name: id,
    weight,
    score: na.has(id) ? NOT_APPLICABLE_SCORE : score,
    findings: [],
  }));
  return { score: calculateOverallScore(results), results };
}

function coverageLine(result) {
  return stripAnsi(formatTerminal(result, '/x'))
    .split('\n')
    .find((l) => l.includes('Coverage:'));
}

describe('coverage-scaling disclosure (reporter)', () => {
  it('weight 80, every check scores 100 → score is scaled AND the report says so', () => {
    // mcp-config (14) + credential-storage (6) N/A → applicable weight 80.
    const result = buildResult(['mcp-config', 'credential-storage']);

    // The premise: perfect checks, yet an 80.
    expect(result.score).toBe(80);

    const line = coverageLine(result);
    expect(line).toContain('weight 80/100');
    expect(line).toMatch(/scaled/);
  });

  it('weight 100 (only weight-0 advisories N/A) → nothing was scaled, so NO scaling claim', () => {
    // `documentation` carries weight 0: it drops the applicable *count* without
    // dropping any weight, so the coverage line prints but must not claim scaling.
    const result = buildResult(['documentation']);
    expect(result.score).toBe(100);

    const line = coverageLine(result);
    expect(line).toContain('weight 100/100');
    expect(line).not.toMatch(/scaled/);
    expect(stripAnsi(formatTerminal(result, '/x'))).not.toMatch(/scaled/);
  });

  it('weight below 60 still discloses (no regression on the old threshold)', () => {
    // Keep coherence (14) + skill-files (10) + claude-md (10) + claude-settings (8) = 42.
    const keep = new Set(['coherence', 'skill-files', 'governance-docs', 'claude-settings']);
    const naIds = Object.entries(WEIGHTS)
      .filter(([id, w]) => w > 0 && !keep.has(id))
      .map(([id]) => id);
    const result = buildResult(naIds);

    const line = coverageLine(result);
    expect(line).toContain('weight 42/100');
    expect(line).toMatch(/scaled/);
  });

  it('a disabled check drops weight with every check still applicable → still discloses', () => {
    // `checks.disabled` zeroes a weight, so the score is scaled even though no
    // check is N/A. The line must print on weight shortfall alone.
    const result = buildResult([]);
    result.config = { checks: { disabled: ['docker-security'] } }; // weight 6

    const line = coverageLine(result);
    expect(line).toContain('weight 94/100');
    expect(line).toMatch(/scaled/);
  });

  it('the disclosure states the cap a perfect scan can reach', () => {
    const result = buildResult(['mcp-config', 'credential-storage']);
    const plain = stripAnsi(formatTerminal(result, '/x'));
    expect(plain).toContain('caps at 80/100');
  });
});
