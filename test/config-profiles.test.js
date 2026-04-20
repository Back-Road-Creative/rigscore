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

  it('home profile emphasizes governance / skill-files / MCP, disables infra', () => {
    const { home } = PROFILES;
    expect(home).toBeDefined();
    expect(home['claude-md']).toBeGreaterThan(0);
    expect(home['skill-files']).toBeGreaterThan(0);
    expect(home['mcp-config']).toBeGreaterThan(0);
    expect(home['docker-security']).toBe(0);
    expect(home['infrastructure-security']).toBe(0);
    expect(home['windows-security']).toBe(0);
  });

  it('monorepo profile preserves default scoring weights', () => {
    const { monorepo } = PROFILES;
    expect(monorepo).toBeDefined();
    expect(monorepo).toEqual(WEIGHTS);
  });

  it('exposes the 5 expected profile names (default, minimal, ci, home, monorepo)', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(
      ['ci', 'default', 'home', 'minimal', 'monorepo'].sort(),
    );
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

  it('accepts unknown check IDs in weights (for plugins)', () => {
    const resolved = resolveWeights({ weights: { 'fake-check': 10 } });
    expect(resolved['fake-check']).toBe(10);
  });

  it('accepts unknown check IDs in disabled (for plugins)', () => {
    const resolved = resolveWeights({ checks: { disabled: ['fake-check'] } });
    expect(resolved['fake-check']).toBe(0);
  });
});
