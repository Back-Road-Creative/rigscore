import { describe, it, expect } from 'vitest';
import { runChecks } from '../src/scanner.js';
import { loadChecks } from '../src/checks/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

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
      expect(check).toHaveProperty('weight');
      expect(check).toHaveProperty('run');
      expect(typeof check.id).toBe('string');
      expect(typeof check.name).toBe('string');
      expect(typeof check.run).toBe('function');
      expect(typeof check.weight).toBe('number');
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

  it('filters checks by id', async () => {
    const checkA = { id: 'alpha', name: 'A', category: 't', weight: 5, async run() { return { score: 100, findings: [] }; } };
    const checkB = { id: 'beta', name: 'B', category: 't', weight: 5, async run() { return { score: 100, findings: [] }; } };
    const context = { cwd: '/tmp', homedir: '/tmp' };
    const results = await runChecks([checkA, checkB], context, { checkFilter: 'alpha' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('alpha');
  });
});

describe('scan with invalid --check filter', () => {
  it('returns error with available check IDs for unknown filter', async () => {
    const { scan } = await import('../src/scanner.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-scan-'));
    try {
      const result = await scan({ cwd: tmpDir, checkFilter: 'nonexistent' });
      expect(result.error).toBeDefined();
      expect(result.error).toContain('nonexistent');
      expect(result.error).toContain('Available');
      expect(result.error).toContain('claude-md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
