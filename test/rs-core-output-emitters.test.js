import { describe, it, expect } from 'vitest';
import {
  formatJUnit, formatCodeClimate, formatBadge, formatJson, getRiskProfile,
} from '../src/reporter.js';
import { formatSarif } from '../src/sarif.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const mockResult = () => ({
  score: 54,
  config: {},
  results: [
    {
      id: 'mcp-config', name: 'MCP server configuration', category: 'supply-chain',
      weight: 14, score: 60, enforcementGrade: 'mechanical',
      findings: [{ severity: 'warning', title: 'MCP server unpinned', detail: 'Unpinned.', findingId: 'mcp-config/unpinned' }],
    },
    {
      id: 'skill-files', name: 'Skill file safety', category: 'governance',
      weight: 10, score: 0, enforcementGrade: 'pattern',
      findings: [{ severity: 'critical', title: 'Injection in skill.md', detail: 'Bad.', findingId: 'skill-files/injection' }],
    },
    {
      id: 'env-exposure', name: 'Secret exposure', category: 'secrets',
      weight: 8, score: 100, findings: [{ severity: 'pass', title: 'clean' }],
    },
  ],
});

// ── RS-23: JUnit XML + GitLab Code Quality (CodeClimate JSON) emitters ────────
describe('RS-23: JUnit + Code Quality emitters', () => {
  it('JUnit renders one testcase per check, failures for bad checks', () => {
    const xml = formatJUnit(mockResult());
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toMatch(/<testsuites name="rigscore"/);
    expect(xml).toMatch(/tests="3"/);
    expect(xml).toMatch(/<testcase name="mcp-config"/);
    expect(xml).toMatch(/<failure message="MCP server unpinned"/);
    expect(xml).toMatch(/failures="2"/); // mcp-config + skill-files
  });

  it('Code Quality is a CodeClimate JSON array with stable fingerprints + mapped severity', () => {
    const issues = JSON.parse(formatCodeClimate(mockResult()));
    expect(Array.isArray(issues)).toBe(true);
    const crit = issues.find((i) => i.check_name === 'skill-files');
    expect(crit.severity).toBe('critical');
    const warn = issues.find((i) => i.check_name === 'mcp-config');
    expect(warn.severity).toBe('major');
    expect(crit.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    // pass findings are not issues
    expect(issues.some((i) => i.check_name === 'env-exposure')).toBe(false);
  });
});

// ── RS-27: badge formats (endpoint JSON + self-contained SVG) ────────────────
describe('RS-27: badge output formats', () => {
  it('endpoint format is valid shields.io Endpoint Badge JSON', () => {
    const j = JSON.parse(formatBadge(mockResult(), { format: 'endpoint' }));
    expect(j).toMatchObject({ schemaVersion: 1, label: 'rigscore', message: '54/100' });
    expect(j.color).toBeTruthy();
  });

  it('svg format is a self-contained SVG (no external resource references)', () => {
    const svg = formatBadge(mockResult(), { format: 'svg' });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('54/100');
    // The only URL is the inert SVG namespace; nothing is fetched.
    expect(svg).not.toContain('shields.io');
    expect(svg).not.toMatch(/(?:href|src)\s*=/i);
  });

  it('markdown (default) is unchanged — shields.io static snippet', () => {
    const md = formatBadge(mockResult());
    expect(md).toContain('shields.io');
    expect(md).toContain('54');
  });
});

// ── RS-14: grade + riskProfile in JSON/SARIF; getRiskProfile excludes weight-0 ─
describe('RS-14: grade + posture in JSON and SARIF', () => {
  it('JSON carries grade + riskProfile at top level', () => {
    const parsed = JSON.parse(formatJson(mockResult()));
    expect(parsed.grade).toBe('D'); // 54 -> D
    expect(parsed.riskProfile).toBeTruthy();
    expect(parsed.score).toBe(54); // additive — existing keys preserved
  });

  it('SARIF run.properties carries score/grade/riskProfile', () => {
    const props = formatSarif(mockResult()).runs[0].properties;
    expect(props.score).toBe(54);
    expect(props.grade).toBe('D');
    expect(props.riskProfile).toBeTruthy();
  });

  it('getRiskProfile ignores weight-0 advisory checks', () => {
    // 7 weight-bearing checks, all passing -> Hardened.
    const passing = [
      'mcp-config', 'coherence', 'skill-files', 'governance-docs',
      'claude-settings', 'deep-secrets', 'env-exposure',
    ].map((id) => ({ id, score: 100 }));
    expect(getRiskProfile(passing)).toBe('Hardened');
    // A weight-0 advisory check that is applicable but FAILING must NOT drop the tier.
    const withAdvisory = [...passing, { id: 'documentation', score: 40 }];
    expect(getRiskProfile(withAdvisory)).toBe('Hardened');
  });
});

// ── RS-31: OWASP MCP + Agentic-Skills tags + security-severity in SARIF ──────
describe('RS-31: SARIF framework tags + security-severity', () => {
  it('adds owasp-mcp + owasp-agentic-skills tags alongside owasp-agentic (extends, not dupes)', () => {
    const sarif = formatSarif(mockResult());
    const tags = sarif.runs[0].results.flatMap((r) => r.properties.tags);
    expect(tags).toContain('owasp-agentic:ASI04');   // pre-existing (mcp-config)
    expect(tags).toContain('owasp-mcp:MCP04');        // NEW (mcp-config)
    expect(tags).toContain('owasp-agentic-skills:AST01'); // NEW (skill-files)
  });

  it('sets a numeric security-severity on the per-finding rules', () => {
    const rules = formatSarif(mockResult()).runs[0].tool.driver.rules;
    const withSev = rules.filter((r) => r.properties && r.properties['security-severity']);
    expect(withSev.length).toBeGreaterThan(0);
    for (const r of withSev) {
      expect(Number(r.properties['security-severity'])).toBeGreaterThan(0);
    }
  });
});
