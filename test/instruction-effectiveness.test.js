import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/instruction-effectiveness.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-ie-'));
}

const defaultConfig = { paths: { claudeMd: [] }, network: {} };

describe('instruction-effectiveness check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('instruction-effectiveness');
    expect(check.name).toBe('Instruction effectiveness');
    expect(check.category).toBe('governance');
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('returns N/A when no instruction files exist', async () => {
    const result = await check.run({
      cwd: fixture('instruction-none'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings[0].severity).toBe('skipped');
    expect(result.data.filesDiscovered).toBe(0);
  });

  it('passes cleanly on minimal well-structured file', async () => {
    const result = await check.run({
      cwd: fixture('instruction-minimal'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    expect(result.score).toBeGreaterThanOrEqual(50);
    const criticals = result.findings.filter(f => f.severity === 'critical');
    const warnings = result.findings.filter(f => f.severity === 'warning');
    expect(criticals).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(result.data.filesDiscovered).toBe(1);
    expect(result.data.totalEstimatedTokens).toBeGreaterThan(0);
  });

  it('detects contradictions within same file', async () => {
    const result = await check.run({
      cwd: fixture('instruction-contradictions'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    const contradictions = result.findings.filter(f =>
      f.title?.includes('contradiction') || f.title?.includes('Contradiction'),
    );
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].severity).toBe('info');
  });

  it('detects dead file references', async () => {
    const result = await check.run({
      cwd: fixture('instruction-dead-refs'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    const deadRefs = result.findings.filter(f =>
      f.title?.includes('Dead file reference'),
    );
    expect(deadRefs.length).toBeGreaterThanOrEqual(2);
    expect(deadRefs[0].severity).toBe('warning');
  });

  it('detects redundant instructions across files', async () => {
    const result = await check.run({
      cwd: fixture('instruction-redundant'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    const redundant = result.findings.filter(f =>
      f.title?.includes('Redundant instruction') || f.title?.includes('redundant'),
    );
    expect(redundant.length).toBeGreaterThanOrEqual(1);
    expect(redundant[0].severity).toBe('info');
  });

  it('WARNING on bloated file (>500 lines)', async () => {
    const tmpDir = makeTmpDir();
    const content = Array(601).fill('').map((_, i) =>
      `Rule ${i}: This is a governance rule that agents must follow carefully.`,
    ).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const bloat = result.findings.filter(f => f.title?.includes('Bloated'));
      expect(bloat.length).toBeGreaterThanOrEqual(1);
      expect(bloat[0].severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('INFO on approaching-bloat file (300-500 lines)', async () => {
    const tmpDir = makeTmpDir();
    const content = Array(350).fill('').map((_, i) =>
      `Rule ${i}: This is a governance rule for the project.`,
    ).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const bloat = result.findings.filter(f => f.title?.includes('Large instruction file') && f.title?.includes('lines'));
      expect(bloat.length).toBeGreaterThanOrEqual(1);
      expect(bloat[0].severity).toBe('info');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING on single large file exceeding token threshold', async () => {
    const tmpDir = makeTmpDir();
    // 5000 tokens ≈ 20000 chars
    const content = 'x'.repeat(22000);
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const large = result.findings.filter(f => f.title?.includes('Large instruction file') && !f.title?.includes('lines'));
      expect(large.length).toBeGreaterThanOrEqual(1);
      expect(large[0].severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING on total context budget >20%', async () => {
    const tmpDir = makeTmpDir();
    // 20% of 200K = 40K tokens = ~160K chars
    const content = 'Important rule: '.repeat(11000); // ~176K chars
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const budget = result.findings.filter(f => f.title?.includes('context window'));
      expect(budget.length).toBeGreaterThanOrEqual(1);
      expect(budget[0].severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('INFO on total context budget >10% but <=20%', async () => {
    const tmpDir = makeTmpDir();
    // 15% of 200K = 30K tokens = ~120K chars
    const content = 'Important rule: '.repeat(7500); // ~120K chars
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const budget = result.findings.filter(f => f.title?.includes('context window'));
      expect(budget.length).toBeGreaterThanOrEqual(1);
      expect(budget[0].severity).toBe('info');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects vague instructions without criteria', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Use your judgment when naming variables.',
      'Format code as appropriate.',
      'Figure out the best approach for error handling.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const vague = result.findings.filter(f => f.title?.includes('Vague instruction'));
      expect(vague.length).toBeGreaterThanOrEqual(1);
      expect(vague[0].severity).toBe('info');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag vague instruction followed by criteria', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Use your judgment when naming variables: follow the existing snake_case convention.',
      'Format code as appropriate.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const vague = result.findings.filter(f =>
        f.title?.includes('Vague instruction') && f.detail?.includes('naming variables'),
      );
      // The one with criteria should NOT be flagged
      expect(vague).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('discovers skill files in .claude/commands/', async () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'commands', 'test-cmd.md'), '# Test Command\nRun all tests.\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nFollow the code style guide.\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      expect(result.data.filesDiscovered).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('populates data object with breakdown', async () => {
    const result = await check.run({
      cwd: fixture('instruction-minimal'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    expect(result.data).toBeDefined();
    expect(result.data.totalEstimatedTokens).toBeGreaterThan(0);
    expect(result.data.contextPct).toBeGreaterThan(0);
    expect(result.data.breakdown).toBeInstanceOf(Array);
    expect(result.data.breakdown.length).toBe(1);
    expect(result.data.breakdown[0]).toHaveProperty('relPath');
    expect(result.data.breakdown[0]).toHaveProperty('lineCount');
    expect(result.data.breakdown[0]).toHaveProperty('charCount');
    expect(result.data.breakdown[0]).toHaveProperty('estimatedTokens');
    expect(typeof result.data.redundantLineCount).toBe('number');
  });

  it('skips code blocks for contradiction detection', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Always use semicolons.',
      '',
      '```',
      'Never use semicolons in Python.',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const contradictions = result.findings.filter(f =>
        f.title?.includes('contradiction') || f.title?.includes('Contradiction'),
      );
      expect(contradictions).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag URLs as dead file references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'See [docs](https://example.com/docs) for more info.',
      'Check `http://localhost:3000` for the dev server.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag placeholder paths as dead references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Replace `path/to/your/config.json` with the actual path.',
      'See `example/foo.js` for a sample.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
