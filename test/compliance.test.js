import { describe, it, expect } from 'vitest';
import { formatCompliance } from '../src/compliance.js';
import { NOT_APPLICABLE_SCORE, WEIGHTS, FRAMEWORKS } from '../src/constants.js';

const text = formatCompliance({
  score: 72,
  results: [
    { id: 'deep-secrets', score: 40, findings: [
      { severity: 'critical', title: 'AWS key committed in src/app.js' },
      { severity: 'info', title: 'Consider enabling deep scan' },
    ] },
    { id: 'docker-security', score: 85, findings: [{ severity: 'warning', title: 'Container runs as root' }] },
    { id: 'claude-md', score: 100, findings: [] },
    { id: 'mcp-config', score: NOT_APPLICABLE_SCORE, findings: [] },
    { id: 'site-security', score: 90, findings: [] }, // evidences no control anywhere
  ],
});
// The rendered line for a check, e.g. "[WARN    ] docker-security  score  85".
const lineFor = (id) => text.split('\n').find((l) => l.includes(`] ${id.padEnd(26)}`));
describe('formatCompliance', () => {
  it('groups evidencing checks under the control they evidence', () => {
    expect(text).toContain('ASI03 — Identity & Privilege Abuse');
    expect(text).toContain('MEASURE 2.7');
    expect(text).toContain('Article 15');
  });

  it('rolls each check up to a verdict; N/A is never a free PASS', () => {
    expect(lineFor('deep-secrets')).toContain('CRITICAL');
    expect(lineFor('docker-security')).toContain('WARN');
    expect(lineFor('claude-md')).toContain('PASS');
    expect(lineFor('mcp-config')).toContain('N/A');
    // blocking findings shown; info-level noise is not compliance evidence
    expect(text).toContain('AWS key committed in src/app.js');
    expect(text).not.toContain('Consider enabling deep scan');
  });

  it('prints each framework status, primary source and the EU dates verbatim', () => {
    expect(text).toMatch(/Status: final/);
    expect(text).toContain('https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf');
    expect(text).toContain('2026-08-02');
    expect(text).toMatch(/Digital Omnibus/);
  });

  it('surfaces honest gaps rather than hiding them', () => {
    // Art. 50: rigscore produces no end-user-disclosure evidence, and says so.
    expect(text).toContain('NOT EVIDENCED');
    expect(text).toMatch(/UNMAPPED here \(\d+\):.*site-security/);
    // eslint-disable-next-line no-control-regex
    expect(text, 'must stay plain text for CI/auditors').not.toMatch(/\x1b\[/);
  });
});


// Compliance mapping invariants — so the standards tables cannot silently rot: a
// renamed/removed check must break the build, never ship a dangling citation.
describe('compliance frameworks', () => {
  const scored = Object.keys(WEIGHTS).filter((id) => WEIGHTS[id] > 0);
  const ID_SHAPE = {
    'owasp-agentic': /^ASI\d{2}$/,
    'nist-ai-rmf': /^(GOVERN|MAP|MEASURE|MANAGE) \d+\.\d+$/,
    'eu-ai-act': /^Article \d+$/,
  };

  it.each(Object.entries(FRAMEWORKS))('%s cites provenance and only real checks/controls', (key, fw) => {
    expect(fw.name).toBeTruthy();
    expect(fw.status, 'upstream status — a beta list must never read as final').toBeTruthy();
    expect(fw.url, 'primary-source URL').toMatch(/^https:\/\//);
    expect(['full', 'partial']).toContain(fw.coverage);
    for (const [id, control] of Object.entries(fw.map)) {
      expect(WEIGHTS, `"${id}" is not a real check id`).toHaveProperty(id);
      expect(control, `malformed control id "${control}"`).toMatch(ID_SHAPE[key]);
      expect(fw.controls, `control "${control}" cited with no title`).toHaveProperty(control);
    }
  });

  it.each(Object.entries(FRAMEWORKS))('%s honors its coverage claim', (_key, fw) => {
    const missing = scored.filter((id) => !fw.map[id]);
    if (fw.coverage === 'full') {
      expect(missing, 'claims full coverage but misses scored checks').toEqual([]);
    } else {
      expect(missing.length, 'claims partial but maps every scored check').toBeGreaterThan(0);
    }
  });
});
