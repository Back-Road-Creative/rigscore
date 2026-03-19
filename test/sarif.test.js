import { describe, it, expect } from 'vitest';
import { formatSarif } from '../src/sarif.js';

describe('SARIF output', () => {
  const mockResult = {
    score: 75,
    results: [
      {
        id: 'mcp-config',
        name: 'MCP server configuration',
        category: 'supply-chain',
        weight: 18,
        score: 85,
        findings: [
          { severity: 'warning', title: 'Network transport', detail: 'Server uses SSE.' },
          { severity: 'pass', title: 'Config looks good' },
        ],
      },
      {
        id: 'claude-md',
        name: 'CLAUDE.md governance',
        category: 'governance',
        weight: 12,
        score: 0,
        findings: [
          { severity: 'critical', title: 'No governance file', detail: 'No CLAUDE.md found.' },
        ],
      },
    ],
  };

  it('produces valid SARIF v2.1.0 structure', () => {
    const sarif = formatSarif(mockResult);
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe('rigscore');
  });

  it('maps critical severity to error', () => {
    const sarif = formatSarif(mockResult);
    const errorResults = sarif.runs[0].results.filter(r => r.level === 'error');
    expect(errorResults.length).toBe(1);
    expect(errorResults[0].ruleId).toBe('claude-md');
  });

  it('maps warning severity to warning', () => {
    const sarif = formatSarif(mockResult);
    const warningResults = sarif.runs[0].results.filter(r => r.level === 'warning');
    expect(warningResults.length).toBe(1);
    expect(warningResults[0].ruleId).toBe('mcp-config');
  });

  it('excludes pass findings from results', () => {
    const sarif = formatSarif(mockResult);
    // pass severity maps to 'none' and is skipped
    expect(sarif.runs[0].results.length).toBe(2); // 1 warning + 1 critical
  });

  it('includes rule definitions', () => {
    const sarif = formatSarif(mockResult);
    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules.length).toBe(2);
    expect(rules.map(r => r.id)).toContain('mcp-config');
    expect(rules.map(r => r.id)).toContain('claude-md');
  });

  it('includes logical locations', () => {
    const sarif = formatSarif(mockResult);
    const result = sarif.runs[0].results[0];
    expect(result.locations[0].logicalLocations[0].name).toBeDefined();
  });
});
