import { describe, it, expect } from 'vitest';
import { WEIGHTS, SEVERITY, CATEGORY, SEVERITY_DEDUCTIONS, INFO_ONLY_FLOOR, COVERAGE_PENALTY_THRESHOLD, NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { loadChecks } from '../src/checks/index.js';

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

  it('COVERAGE_PENALTY_THRESHOLD is 60', () => {
    expect(COVERAGE_PENALTY_THRESHOLD).toBe(60);
  });

  it('NOT_APPLICABLE_SCORE is -1', () => {
    expect(NOT_APPLICABLE_SCORE).toBe(-1);
  });
});

describe('CATEGORY string values', () => {
  it('GOVERNANCE === "governance"', () => {
    expect(CATEGORY.GOVERNANCE).toBe('governance');
  });

  it('SUPPLY_CHAIN === "supply-chain"', () => {
    expect(CATEGORY.SUPPLY_CHAIN).toBe('supply-chain');
  });

  it('SECRETS === "secrets"', () => {
    expect(CATEGORY.SECRETS).toBe('secrets');
  });

  it('ISOLATION === "isolation"', () => {
    expect(CATEGORY.ISOLATION).toBe('isolation');
  });

  it('PROCESS === "process"', () => {
    expect(CATEGORY.PROCESS).toBe('process');
  });
});

describe('check categories match CATEGORY constants', () => {
  it('every check.category is a valid CATEGORY value', async () => {
    const checks = await loadChecks();
    const validCategories = Object.values(CATEGORY);
    for (const check of checks) {
      expect(validCategories).toContain(check.category);
    }
  });

  it('every check.id has a matching WEIGHTS entry', async () => {
    const checks = await loadChecks();
    for (const check of checks) {
      expect(WEIGHTS[check.id]).toBeDefined();
      expect(WEIGHTS[check.id]).toBe(check.weight);
    }
  });
});
