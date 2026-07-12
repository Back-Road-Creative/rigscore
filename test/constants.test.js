import { describe, it, expect } from 'vitest';
import { WEIGHTS, SEVERITY, SEVERITY_DEDUCTIONS, INFO_ONLY_FLOOR, COVERAGE_PENALTY_THRESHOLD, KEY_PATTERNS, OWASP_AGENTIC_MAP, FRAMEWORKS } from '../src/constants.js';

describe('constants', () => {
  it('weights sum to 100', () => {
    const total = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBe(100);
  });

  it('every severity has a deduction', () => {
    for (const sev of Object.values(SEVERITY)) {
      expect(sev in SEVERITY_DEDUCTIONS).toBe(true);
    }
  });

  it('CRITICAL deduction is null (zeros the check)', () => {
    expect(SEVERITY_DEDUCTIONS[SEVERITY.CRITICAL]).toBeNull();
  });

  it('WARNING deduction is -15', () => {
    expect(SEVERITY_DEDUCTIONS[SEVERITY.WARNING]).toBe(-15);
  });

  it('INFO deduction is -2', () => {
    expect(SEVERITY_DEDUCTIONS[SEVERITY.INFO]).toBe(-2);
  });

  it('PASS deduction is 0', () => {
    expect(SEVERITY_DEDUCTIONS[SEVERITY.PASS]).toBe(0);
  });

  it('SKIPPED deduction is 0', () => {
    expect(SEVERITY_DEDUCTIONS[SEVERITY.SKIPPED]).toBe(0);
  });

  it('INFO_ONLY_FLOOR is 50', () => {
    expect(INFO_ONLY_FLOOR).toBe(50);
  });

  it('COVERAGE_PENALTY_THRESHOLD is 50', () => {
    expect(COVERAGE_PENALTY_THRESHOLD).toBe(50);
  });

  it('KEY_PATTERNS must not use the global /g flag', () => {
    for (const pattern of KEY_PATTERNS) {
      expect(pattern.flags, `Pattern ${pattern.source} has /g flag`).not.toContain('g');
    }
  });

  it('every weighted check has an OWASP mapping', () => {
    for (const checkId of Object.keys(WEIGHTS)) {
      if (WEIGHTS[checkId] > 0) {
        expect(OWASP_AGENTIC_MAP[checkId], `${checkId} missing OWASP mapping`).toBeDefined();
        expect(OWASP_AGENTIC_MAP[checkId]).toMatch(/^ASI\d{2}$/);
      }
    }
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
