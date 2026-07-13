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
    // Per-finding ruleId: `<checkId>/<slug>` when no findingId is supplied.
    expect(errorResults[0].ruleId.startsWith('claude-md/')).toBe(true);
  });

  it('maps warning severity to warning', () => {
    const sarif = formatSarif(mockResult);
    const warningResults = sarif.runs[0].results.filter(r => r.level === 'warning');
    expect(warningResults.length).toBe(1);
    expect(warningResults[0].ruleId.startsWith('mcp-config/')).toBe(true);
  });

  it('excludes pass findings from results', () => {
    const sarif = formatSarif(mockResult);
    // pass severity maps to 'none' and is skipped
    expect(sarif.runs[0].results.length).toBe(2); // 1 warning + 1 critical
  });

  it('includes rule definitions (check-level + per-finding)', () => {
    const sarif = formatSarif(mockResult);
    const rules = sarif.runs[0].tool.driver.rules;
    const ids = rules.map(r => r.id);
    // Check-level (tool-component) rules stay as fallback.
    expect(ids).toContain('mcp-config');
    expect(ids).toContain('claude-md');
    // Per-finding rules are registered alongside the check-level entries.
    expect(ids.some((id) => id.startsWith('claude-md/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mcp-config/'))).toBe(true);
  });

  it('per-finding ruleId uses findingId when present', () => {
    const result = {
      score: 50,
      results: [{
        id: 'env-exposure',
        name: 'Secret exposure',
        category: 'secrets',
        weight: 8,
        score: 0,
        findings: [
          { severity: 'critical', title: '.env tracked', findingId: 'env-exposure/env-tracked' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    expect(sarif.runs[0].results[0].ruleId).toBe('env-exposure/env-tracked');
  });

  it('evidence field is surfaced on SARIF result.properties', () => {
    const result = {
      score: 50,
      results: [{
        id: 'claude-md',
        name: 'CLAUDE.md governance',
        category: 'governance',
        weight: 10,
        score: 0,
        findings: [
          { severity: 'warning', title: 'Weak rule', evidence: 'Line 42: always use your judgment' },
        ],
      }],
    };
    const sarif = formatSarif(result);
    expect(sarif.runs[0].results[0].properties.evidence).toBe('Line 42: always use your judgment');
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

  // --- remediation / learnMore reach the SARIF surface -------------------
  //
  // Checks already compute `remediation` (how to fix) and sometimes a
  // `learnMore` URL, and the terminal reporter renders both. Before this
  // suite they never reached SARIF, so a user whose only surface is GitHub
  // code scanning saw *what* was wrong but never the fix.
  //
  // Placement (SARIF 2.1.0):
  //   - `remediation` is PER-RESULT: several findings share one ruleId (e.g.
  //     `workflow-maturity/skill-no-eval` fires once per skill, each with its
  //     own fix text), so it must NOT be hoisted to the rule — a rule-level
  //     `help` would show the first skill's fix next to every other skill's
  //     finding. It goes in the result property bag (§3.8) and is appended to
  //     `message.text`, the per-result text GitHub code scanning renders.
  //   - `learnMore` IS per-rule (a constant doc URL per finding class), so it
  //     becomes the reportingDescriptor's `helpUri` (§3.49.12) and `help`
  //     (§3.49.13) — `helpUri` is a rule property, never a result property.
  const remediationResult = {
    score: 40,
    results: [{
      id: 'docker-security',
      name: 'Docker security',
      category: 'infrastructure',
      weight: 10,
      score: 0,
      findings: [
        {
          severity: 'critical',
          title: 'Docker socket mounted',
          detail: 'Container can control the host daemon.',
          evidence: 'volumes: /var/run/docker.sock',
          remediation: 'Remove the /var/run/docker.sock bind mount.',
          learnMore: 'https://headlessmode.com/tools/rigscore/#docker-socket-risk',
        },
        { severity: 'warning', title: 'Running as root' }, // no remediation, no learnMore
      ],
    }],
  };

  function ruleFor(sarif, ruleId) {
    return sarif.runs[0].tool.driver.rules.find((rule) => rule.id === ruleId);
  }

  it('carries finding.remediation into SARIF result.properties.remediation', () => {
    const sarif = formatSarif(remediationResult);
    const sarifResult = sarif.runs[0].results[0];
    expect(sarifResult.properties.remediation).toBe('Remove the /var/run/docker.sock bind mount.');
  });

  it('appends remediation to message.text (the per-result text GitHub renders)', () => {
    const sarif = formatSarif(remediationResult);
    const text = sarif.runs[0].results[0].message.text;
    // Existing message shape (`<title>: <detail>`) is preserved verbatim...
    expect(text).toContain('Docker socket mounted: Container can control the host daemon.');
    // ...and the fix now rides along on the same rendered surface.
    expect(text).toContain('Fix: Remove the /var/run/docker.sock bind mount.');
  });

  it('keeps a remediation-less message.text byte-identical to the old shape', () => {
    const sarif = formatSarif(remediationResult);
    expect(sarif.runs[0].results[1].message.text).toBe('Running as root');
  });

  it('surfaces learnMore as rule-level helpUri, not a result property', () => {
    const sarif = formatSarif(remediationResult);
    const sarifResult = sarif.runs[0].results[0];
    const rule = ruleFor(sarif, sarifResult.ruleId);
    expect(rule.helpUri).toBe('https://headlessmode.com/tools/rigscore/#docker-socket-risk');
    // helpUri is a reportingDescriptor property (§3.49.12) — never on a result.
    expect(sarifResult.helpUri).toBeUndefined();
    // GitHub does not render helpUri, so the link is also woven into `help`,
    // which it does render next to the result.
    expect(rule.help.markdown).toContain('https://headlessmode.com/tools/rigscore/#docker-socket-risk');
    expect(rule.help.text).toContain('https://headlessmode.com/tools/rigscore/#docker-socket-risk');
  });

  it('never hoists per-result remediation onto the shared rule', () => {
    // Two findings, ONE ruleId, different fixes — the exact shape that makes
    // rule-level remediation a misattribution.
    const sarif = formatSarif({
      score: 10,
      results: [{
        id: 'workflow-maturity',
        name: 'Workflow maturity',
        category: 'governance',
        weight: 10,
        score: 0,
        findings: [
          { severity: 'warning', title: 'Skill has no eval', findingId: 'workflow-maturity/skill-no-eval', remediation: 'Create `evals/audit/`.' },
          { severity: 'warning', title: 'Skill has no eval', findingId: 'workflow-maturity/skill-no-eval', remediation: 'Create `evals/publish/`.' },
        ],
      }],
    });
    const [first, second] = sarif.runs[0].results;
    expect(first.ruleId).toBe(second.ruleId);
    // Each result keeps its OWN fix...
    expect(first.properties.remediation).toBe('Create `evals/audit/`.');
    expect(second.properties.remediation).toBe('Create `evals/publish/`.');
    // ...and the shared rule claims neither.
    const rule = ruleFor(sarif, first.ruleId);
    expect('help' in rule).toBe(false);
  });

  it('omits remediation entirely when the finding has none (no null/empty noise)', () => {
    const sarif = formatSarif(remediationResult);
    const bare = sarif.runs[0].results[1]; // 'Running as root'
    expect(bare.properties.remediation).toBeUndefined();
    expect('remediation' in bare.properties).toBe(false);
    const rule = ruleFor(sarif, bare.ruleId);
    expect('help' in rule).toBe(false);
    expect('helpUri' in rule).toBe(false);
    expect(JSON.stringify(sarif)).not.toContain('"remediation":null');
    expect(JSON.stringify(sarif)).not.toContain('"remediation":""');
  });

  it('omits whitespace-only remediation and non-http learnMore', () => {
    const sarif = formatSarif({
      score: 10,
      results: [{
        id: 'claude-md',
        name: 'CLAUDE.md governance',
        category: 'governance',
        weight: 10,
        score: 0,
        findings: [
          { severity: 'critical', title: 'Empty fix', remediation: '   ', learnMore: 'javascript:alert(1)' },
        ],
      }],
    });
    const sarifResult = sarif.runs[0].results[0];
    expect('remediation' in sarifResult.properties).toBe(false);
    expect(sarifResult.message.text).toBe('Empty fix');
    const rule = ruleFor(sarif, sarifResult.ruleId);
    expect('help' in rule).toBe(false);
    expect('helpUri' in rule).toBe(false);
  });

  it('strips ANSI from remediation before it reaches SARIF', () => {
    const sarif = formatSarif({
      score: 10,
      results: [{
        id: 'env-exposure',
        name: 'Secret exposure',
        category: 'secrets',
        weight: 8,
        score: 0,
        findings: [
          { severity: 'critical', title: '.env tracked', remediation: '[31mRun git rm --cached .env[0m' },
        ],
      }],
    });
    expect(sarif.runs[0].results[0].properties.remediation).toBe('Run git rm --cached .env');
  });

  it('regression: tags, evidence and enforcementGrade still emit alongside remediation', () => {
    const sarif = formatSarif({
      score: 40,
      results: [{
        id: 'mcp-config',
        name: 'MCP server configuration',
        category: 'supply-chain',
        weight: 18,
        score: 0,
        enforcementGrade: 'deterministic',
        findings: [
          {
            severity: 'warning',
            title: 'Network transport',
            evidence: 'Server uses SSE.',
            remediation: 'Pin the server to stdio transport.',
          },
        ],
      }],
    });
    const properties = sarif.runs[0].results[0].properties;
    expect(properties.tags).toContain('owasp-agentic:ASI04');
    expect(properties.tags).toContain('category:supply-chain');
    expect(properties.evidence).toBe('Server uses SSE.');
    expect(properties.enforcementGrade).toBe('deterministic');
    expect(properties.remediation).toBe('Pin the server to stdio transport.');
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
