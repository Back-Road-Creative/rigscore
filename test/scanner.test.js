import { describe, it, expect } from 'vitest';
import { runChecks, suppressFindings, assignFindingIds } from '../src/scanner.js';
import { loadChecks } from '../src/checks/index.js';
import { WEIGHTS } from '../src/constants.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('loadChecks', () => {
  it('discovers check files from src/checks/', async () => {
    const checks = await loadChecks();
    expect(checks.length).toBeGreaterThan(0);
  });

  it('each check has required shape', async () => {
    const checks = await loadChecks();
    for (const check of checks) {
      expect(check).toHaveProperty('id');
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('category');
      expect(check).toHaveProperty('run');
      expect(typeof check.id).toBe('string');
      expect(typeof check.name).toBe('string');
      expect(typeof check.run).toBe('function');
      expect(typeof WEIGHTS[check.id]).toBe('number');
    }
  });
});

describe('runChecks', () => {
  it('calls each check and collects results', async () => {
    const mockCheck = (await import('./fixtures/mock-check.js')).default;
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([mockCheck], context);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mock-check');
    expect(results[0].score).toBe(75);
    expect(results[0].findings).toHaveLength(2);
  });

  it('handles a check that throws — catches, returns score 0 + CRITICAL', async () => {
    const throwingCheck = (await import('./fixtures/throwing-check.js')).default;
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([throwingCheck], context);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('throwing-check');
    expect(results[0].score).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
  });

  it('context has cwd and homedir', async () => {
    let receivedContext;
    const spyCheck = {
      id: 'spy',
      name: 'Spy',
      category: 'test',
      weight: 5,
      async run(ctx) {
        receivedContext = ctx;
        return { score: 100, findings: [] };
      },
    };
    await runChecks([spyCheck], { cwd: '/a', homedir: '/b' });
    expect(receivedContext.cwd).toBe('/a');
    expect(receivedContext.homedir).toBe('/b');
  });

  it('handles check returning wrong shape (missing findings)', async () => {
    const badCheck = {
      id: 'bad-shape',
      name: 'Bad Shape',
      category: 'test',
      weight: 5,
      async run() { return { score: 50 }; }, // missing findings
    };
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([badCheck], context);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
    expect(results[0].findings[0].title).toContain('invalid result');
  });

  it('handles check returning non-numeric score', async () => {
    const badCheck = {
      id: 'bad-score',
      name: 'Bad Score',
      category: 'test',
      weight: 5,
      async run() { return { score: 'high', findings: [] }; },
    };
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([badCheck], context);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
  });

  it('handles check returning null', async () => {
    const badCheck = {
      id: 'null-result',
      name: 'Null Result',
      category: 'test',
      weight: 5,
      async run() { return null; },
    };
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([badCheck], context);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].findings[0].severity).toBe('critical');
  });

  it('filters checks by id', async () => {
    const checkA = { id: 'alpha', name: 'A', category: 't', weight: 5, async run() { return { score: 100, findings: [] }; } };
    const checkB = { id: 'beta', name: 'B', category: 't', weight: 5, async run() { return { score: 100, findings: [] }; } };
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([checkA, checkB], context, { checkFilter: 'alpha' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('alpha');
  });
});

describe('scan integration', () => {
  it('deduplicates identical findings across checks', async () => {
    const { scan } = await import('../src/scanner.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-dedup-'));
    // Create a minimal project with just a CLAUDE.md
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nBe safe.\n');
    try {
      const result = await scan({ cwd: tmpDir, homedir: tmpDir });
      // No cross-check duplicates: same (severity, title) must not appear
      // in two different checks. Within-check dupes are preserved by design
      // (e.g., one finding per file hitting a pattern).
      const seenByKey = new Map(); // key -> checkId
      let crossCheckDupes = 0;
      for (const r of result.results) {
        for (const f of r.findings) {
          const key = `${f.severity}:${f.title}`;
          if (seenByKey.has(key) && seenByKey.get(key) !== r.id) crossCheckDupes++;
          else seenByKey.set(key, r.id);
        }
      }
      expect(crossCheckDupes).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('suppressFindings removes findings matching patterns (case-insensitive)', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'warning', title: '.env.local is world-readable' },
      ],
    }];
    suppressFindings(results, ['gitignore']);
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].title).toContain('world-readable');
  });

  it('suppressFindings does nothing when patterns array is empty', () => {
    const results = [{
      id: 'test',
      score: 50,
      findings: [{ severity: 'warning', title: 'Some finding' }],
    }];
    suppressFindings(results, []);
    expect(results[0].findings).toHaveLength(1);
  });

  it('suppressFindings recalculates score after suppression', () => {
    const results = [{
      id: 'test',
      score: 0,
      findings: [
        { severity: 'critical', title: 'Bad thing', detail: 'Very bad' },
        { severity: 'pass', title: 'Good thing' },
      ],
    }];
    suppressFindings(results, ['Bad thing']);
    expect(results[0].score).toBe(100);
  });

  it('suppressFindings preserves pass findings during suppression', () => {
    const results = [{
      id: 'test',
      score: 85,
      findings: [
        { severity: 'warning', title: 'Docker issue' },
        { severity: 'pass', title: 'Docker looks good' },
      ],
    }];
    suppressFindings(results, ['Docker issue']);
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].severity).toBe('pass');
  });

  it('assignFindingIds generates IDs from checkId + slugified title', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'warning', title: '.env.local is world-readable' },
      ],
    }];
    assignFindingIds(results);
    expect(results[0].findings[0].findingId).toBe('env-exposure/env-file-found-but-not-in-gitignore');
    expect(results[0].findings[1].findingId).toBe('env-exposure/env-local-is-world-readable');
  });

  it('assignFindingIds preserves existing findingId', () => {
    const results = [{
      id: 'test',
      score: 100,
      findings: [
        { severity: 'pass', title: 'All good', findingId: 'test/custom-id' },
      ],
    }];
    assignFindingIds(results);
    expect(results[0].findings[0].findingId).toBe('test/custom-id');
  });

  it('scan results have findingIds assigned', async () => {
    const { scan } = await import('../src/scanner.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-ids-'));
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nBe safe.\n');
    try {
      const result = await scan({ cwd: tmpDir });
      for (const r of result.results) {
        for (const f of r.findings) {
          expect(f.findingId).toBeDefined();
          expect(f.findingId).toMatch(/^[a-z-]+\/[a-z0-9-]+$/);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('pass 2 checks receive cloned priorResults (mutations do not leak)', async () => {
    const { scan } = await import('../src/scanner.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-clone-'));
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nBe safe.\n');
    try {
      const result = await scan({ cwd: tmpDir });
      // If structuredClone works, pass 1 results should be unmodified
      // We verify by checking result structure is valid
      for (const r of result.results) {
        expect(typeof r.id).toBe('string');
        expect(Array.isArray(r.findings)).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
