import { describe, it, expect } from 'vitest';
import { formatCompliance } from '../src/compliance.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

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
