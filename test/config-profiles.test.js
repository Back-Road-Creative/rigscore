import { describe, it, expect } from 'vitest';
import { PROFILES, resolveWeights } from '../src/config.js';
import { WEIGHTS } from '../src/constants.js';

describe('scoring profiles', () => {
  it('default profile matches WEIGHTS', () => {
    expect(PROFILES.default).toEqual(WEIGHTS);
  });

  it('all profiles have weights summing to 100', () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const sum = Object.values(profile).reduce((a, b) => a + b, 0);
      expect(sum, `profile "${name}" sums to ${sum}`).toBe(100);
    }
  });

  it('minimal profile only enables moat checks', () => {
    const { minimal } = PROFILES;
    expect(minimal['docker-security']).toBe(0);
    expect(minimal['git-hooks']).toBe(0);
    expect(minimal['permissions-hygiene']).toBe(0);
    expect(minimal['mcp-config']).toBeGreaterThan(0);
    expect(minimal['coherence']).toBeGreaterThan(0);
  });
});

describe('resolveWeights', () => {
  it('returns default weights when no config', () => {
    const weights = resolveWeights({});
    expect(weights).toEqual(WEIGHTS);
  });

  it('uses profile weights', () => {
    const weights = resolveWeights({ profile: 'minimal' });
    expect(weights['docker-security']).toBe(0);
    expect(weights['mcp-config']).toBe(30);
  });

  it('applies weight overrides on top of profile', () => {
    const weights = resolveWeights({
      profile: 'default',
      weights: { 'mcp-config': 25 },
    });
    expect(weights['mcp-config']).toBe(25);
    expect(weights['claude-md']).toBe(WEIGHTS['claude-md']); // unchanged
  });

  it('zeros disabled checks', () => {
    const weights = resolveWeights({
      checks: { disabled: ['docker-security', 'git-hooks'] },
    });
    expect(weights['docker-security']).toBe(0);
    expect(weights['git-hooks']).toBe(0);
    expect(weights['mcp-config']).toBe(WEIGHTS['mcp-config']); // unchanged
  });

  it('throws for unknown profile', () => {
    expect(() => resolveWeights({ profile: 'nonexistent' })).toThrow('Unknown profile');
  });

  it('throws for invalid check ID in weights', () => {
    expect(() => resolveWeights({ weights: { 'fake-check': 10 } })).toThrow('Invalid check ID');
  });

  it('throws for invalid check ID in disabled', () => {
    expect(() => resolveWeights({ checks: { disabled: ['fake-check'] } })).toThrow('Invalid check ID');
  });
});
