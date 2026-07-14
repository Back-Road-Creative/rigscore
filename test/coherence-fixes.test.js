import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findApplicableFixes, applyFixes } from '../src/fixer.js';
import { loadChecks, getRegisteredFixes } from '../src/checks/index.js';

const FIXER_ID = 'coherence-declare-mcp-server';
const FINDING_ID = 'coherence/undeclared-mcp-server';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-coherence-fix-'));
}

function undeclaredFinding(serverName) {
  return {
    findingId: FINDING_ID,
    severity: 'warning',
    serverName,
    title: `Undeclared MCP server: ${serverName}`,
  };
}

describe('coherence undeclared-mcp-server fixer', () => {
  beforeAll(async () => {
    await loadChecks();
  });

  it('coherence.js self-registers the declaration fixer', async () => {
    const mod = await import('../src/checks/coherence.js');
    expect(Array.isArray(mod.fixes)).toBe(true);
    const ids = mod.fixes.map((f) => f.id);
    expect(ids).toContain(FIXER_ID);

    const registered = getRegisteredFixes();
    expect(registered[FIXER_ID]).toBeDefined();
    expect(registered[FIXER_ID].findingIds).toContain(FINDING_ID);
  });

  it('matches the undeclared-mcp-server finding by findingId', () => {
    const results = [{
      id: 'coherence',
      findings: [undeclaredFinding('github')],
    }];
    const fixes = findApplicableFixes(results);
    expect(fixes.some((f) => f.id === FIXER_ID)).toBe(true);
  });

  it('appends a declaration stub for an undeclared server', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project rules\n\nNever push to main.\n');
      const fixer = getRegisteredFixes()[FIXER_ID];

      const applied = await fixer.apply(tmpDir, tmpDir, undeclaredFinding('github'));
      expect(applied).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      // The check's own "mentioned" test now passes for this server.
      expect(content.toLowerCase().includes('github')).toBe(true);
      expect(content).toContain('## MCP server: github');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('preserves existing governance content above the appended stub', async () => {
    const tmpDir = makeTmpDir();
    try {
      const original = '# Project rules\n\nNever push to main.\n';
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), original);
      const fixer = getRegisteredFixes()[FIXER_ID];

      await fixer.apply(tmpDir, tmpDir, undeclaredFinding('github'));

      const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(content.startsWith(original)).toBe(true);
      expect(content.indexOf('Never push to main.')).toBeLessThan(
        content.indexOf('## MCP server: github'),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('is idempotent — a second run appends nothing and returns false', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project rules\n\nNever push to main.\n');
      const fixer = getRegisteredFixes()[FIXER_ID];

      const first = await fixer.apply(tmpDir, tmpDir, undeclaredFinding('github'));
      expect(first).toBe(true);
      const afterFirst = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

      const second = await fixer.apply(tmpDir, tmpDir, undeclaredFinding('github'));
      expect(second).toBe(false);
      const afterSecond = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

      expect(afterSecond).toBe(afterFirst);
      // Exactly one declaration section, not two.
      const occurrences = afterSecond.split('## MCP server: github').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('declares each undeclared server end-to-end via applyFixes', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project rules\n\nNever push to main.\n');
      const results = [{
        id: 'coherence',
        findings: [undeclaredFinding('github'), undeclaredFinding('filesystem')],
      }];
      const fixes = findApplicableFixes(results);
      const { applied } = await applyFixes(fixes, tmpDir, tmpDir);
      expect(applied.length).toBe(2);

      const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('## MCP server: github');
      expect(content).toContain('## MCP server: filesystem');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns false and creates nothing when no governance file exists', async () => {
    const tmpDir = makeTmpDir();
    try {
      const fixer = getRegisteredFixes()[FIXER_ID];
      const applied = await fixer.apply(tmpDir, tmpDir, undeclaredFinding('github'));
      expect(applied).toBe(false);
      // No governance file was fabricated from nothing.
      expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
      expect(fs.readdirSync(tmpDir).length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns false when the finding carries no serverName', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project rules\n');
      const fixer = getRegisteredFixes()[FIXER_ID];
      const applied = await fixer.apply(tmpDir, tmpDir, { findingId: FINDING_ID });
      expect(applied).toBe(false);
      const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Project rules\n');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
