import { describe, it, expect } from 'vitest';
import check from '../src/checks/governance-docs.js';
import { WEIGHTS } from '../src/constants.js';
import { FINDING_ID_RENAMES, suppressFindings, compileSuppressPattern } from '../src/findings.js';
import { resolveWeights } from '../src/config.js';
import { formatSarif } from '../src/sarif.js';

// AG-2: the flagship 10-point governance check was named `claude-md`, which
// misbrands the vendor-neutral GOVERNANCE_FILES scan as Claude-only. It is
// renamed to `governance-docs`; the old `claude-md` id survives as a working
// suppress/weights alias via FINDING_ID_RENAMES (docs/FINDING_IDS.md promise).
describe('governance-docs rename (AG-2)', () => {
  it('(a) the check reports the new id governance-docs', () => {
    expect(check.id).toBe('governance-docs');
  });

  it('(c) WEIGHTS resolves governance-docs to 10', () => {
    expect(WEIGHTS['governance-docs']).toBe(10);
    // Old key is gone from the (sum-100) map — it lives on only as an alias.
    expect(WEIGHTS['claude-md']).toBeUndefined();
  });

  it('FINDING_ID_RENAMES maps the old id to the new one', () => {
    expect(FINDING_ID_RENAMES['claude-md']).toBe('governance-docs');
  });

  it('(b) a suppress pattern keyed on the OLD id claude-md mutes the renamed finding', () => {
    const results = [{
      id: 'governance-docs',
      score: 0,
      findings: [{
        findingId: 'governance-docs/no-governance-file',
        severity: 'critical',
        title: 'No governance file found',
      }],
    }];
    const summary = suppressFindings(results, ['claude-md']);
    expect(summary.count).toBe(1);
    expect(results[0].findings).toHaveLength(0);
  });

  it('compileSuppressPattern aliases claude-md onto governance-docs findings', () => {
    const predicate = compileSuppressPattern('claude-md');
    expect(predicate({ findingId: 'governance-docs/injection-pattern' })).toBe(true);
  });

  it('(b) a weights rc keyed on the OLD id claude-md scores the renamed check', () => {
    const resolved = resolveWeights({ weights: { 'claude-md': 20 } });
    expect(resolved['governance-docs']).toBe(20);
  });

  it('the new id governance-docs also works directly as a suppress token', () => {
    const predicate = compileSuppressPattern('governance-docs');
    expect(predicate({ findingId: 'governance-docs/no-governance-file' })).toBe(true);
  });

  it('SARIF carries the old id on the governance-docs rule as deprecatedIds', () => {
    const sarif = formatSarif({
      results: [{
        id: 'governance-docs',
        name: 'CLAUDE.md governance',
        category: 'governance',
        findings: [{
          findingId: 'governance-docs/no-governance-file',
          severity: 'critical',
          title: 'No governance file found',
        }],
      }],
    });
    const rule = sarif.runs[0].tool.driver.rules.find((r) => r.id === 'governance-docs');
    expect(rule).toBeDefined();
    expect(rule.deprecatedIds).toEqual(['claude-md']);
  });
});
