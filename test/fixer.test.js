import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findApplicableFixes, applyFixes } from '../src/fixer.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-fixer-'));
}

describe('fixer', () => {
  it('finds env-not-gitignored fix', () => {
    const results = [{
      id: 'env-exposure',
      findings: [{
        severity: 'critical',
        title: '.env file found but NOT in .gitignore',
      }],
    }];
    const fixes = findApplicableFixes(results);
    expect(fixes.length).toBe(1);
    expect(fixes[0].id).toBe('env-not-gitignored');
  });

  it('returns empty when no fixable issues', () => {
    const results = [{
      id: 'claude-md',
      findings: [{
        severity: 'critical',
        title: 'No governance file found',
      }],
    }];
    const fixes = findApplicableFixes(results);
    expect(fixes.length).toBe(0);
  });

  it('applies env-not-gitignored fix', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
      const fixes = [{ id: 'env-not-gitignored', description: 'Add .env to .gitignore' }];
      const { applied } = await applyFixes(fixes, tmpDir, tmpDir);
      expect(applied.length).toBe(1);
      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.env');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('finds gitignore-sensitive-patterns fix for missing *.pem', () => {
    const results = [{
      id: 'permissions-hygiene',
      findings: [{
        severity: 'warning',
        title: 'Sensitive file server.pem is world-readable',
      }],
    }];
    const fixes = findApplicableFixes(results);
    const gitignoreFix = fixes.find(f => f.id === 'gitignore-sensitive-patterns');
    expect(gitignoreFix).toBeDefined();
  });

  it('applies gitignore-sensitive-patterns fix', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
      const fixes = [{ id: 'gitignore-sensitive-patterns', description: 'Add *.pem, *.key to .gitignore' }];
      const { applied } = await applyFixes(fixes, tmpDir, tmpDir);
      expect(applied.length).toBe(1);
      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('*.pem');
      expect(gitignore).toContain('*.key');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('skips env-not-gitignored if already present', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\nnode_modules\n');
      const fixes = [{ id: 'env-not-gitignored', description: 'Add .env to .gitignore' }];
      const { applied, skipped } = await applyFixes(fixes, tmpDir, tmpDir);
      expect(applied.length).toBe(0);
      expect(skipped.length).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
