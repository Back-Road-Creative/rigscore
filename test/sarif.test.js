import { describe, it, expect } from 'vitest';
import { formatSarif, formatSarifMulti } from '../src/sarif.js';

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

  it('informationUri points to Back-Road-Creative org', () => {
    const sarif = formatSarif(mockResult);
    expect(sarif.runs[0].tool.driver.informationUri).toBe('https://github.com/Back-Road-Creative/rigscore');
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

  it('formatSarifMulti creates one run per project', () => {
    const projects = [
      { path: 'project-a', results: mockResult.results },
      { path: 'project-b', results: mockResult.results },
    ];
    const sarif = formatSarifMulti(projects);
    expect(sarif.runs).toHaveLength(2);
    expect(sarif.runs[0].automationDetails.id).toBe('project-a');
    expect(sarif.runs[1].automationDetails.id).toBe('project-b');
  });

  it('includes OWASP agentic tags in properties', () => {
    const sarif = formatSarif(mockResult);
    const result = sarif.runs[0].results[0]; // mcp-config warning
    expect(result.properties).toBeDefined();
    expect(result.properties.tags).toContain('owasp-agentic:ASI04');
    expect(result.properties.tags).toContain('category:supply-chain');
  });

  it('formatSarifMulti handles empty projects', () => {
    const sarif = formatSarifMulti([]);
    expect(sarif.runs).toHaveLength(1); // falls back to single empty run
  });

  it('adds physicalLocation when finding title references a file via "in <file>"', () => {
    const result = {
      score: 50,
      results: [{
        id: 'claude-settings',
        name: 'Claude settings',
        category: 'governance',
        weight: 8,
        score: 0,
        findings: [
          { severity: 'critical', title: 'Dangerous hook command in .claude/settings.json' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.locations[0].physicalLocation).toBeDefined();
    expect(sarifResult.locations[0].physicalLocation.artifactLocation.uri).toBe('.claude/settings.json');
  });

  it('adds physicalLocation from detail "Found in .mcp.json"', () => {
    const result = {
      score: 50,
      results: [{
        id: 'mcp-config',
        name: 'MCP config',
        category: 'supply-chain',
        weight: 16,
        score: 50,
        findings: [
          { severity: 'warning', title: 'Unpinned MCP version', detail: 'Server uses @latest. Found in .mcp.json.' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.locations[0].physicalLocation).toBeDefined();
    expect(sarifResult.locations[0].physicalLocation.artifactLocation.uri).toBe('.mcp.json');
  });

  it('no physicalLocation when no file reference found', () => {
    const result = {
      score: 50,
      results: [{
        id: 'claude-md',
        name: 'CLAUDE.md governance',
        category: 'governance',
        weight: 10,
        score: 0,
        findings: [
          { severity: 'critical', title: 'No governance file found' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.locations[0].logicalLocations).toBeDefined();
    expect(sarifResult.locations[0].physicalLocation).toBeUndefined();
  });

  it('preserves logicalLocations alongside physicalLocation', () => {
    const result = {
      score: 50,
      results: [{
        id: 'env-exposure',
        name: 'Secret exposure',
        category: 'secrets',
        weight: 8,
        score: 0,
        findings: [
          { severity: 'critical', title: 'Hardcoded API key found in config.json', detail: 'A secret was found.' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.locations[0].logicalLocations).toBeDefined();
    expect(sarifResult.locations[0].physicalLocation).toBeDefined();
    expect(sarifResult.locations[0].physicalLocation.artifactLocation.uri).toBe('config.json');
  });
});
