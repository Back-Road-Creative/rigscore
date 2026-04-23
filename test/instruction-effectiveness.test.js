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

  it('does not flag YAML frontmatter keys as redundant across skill files', async () => {
    const result = await check.run({
      cwd: fixture('instruction-frontmatter-dupes'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    const redundant = result.findings.filter(f =>
      f.title?.includes('Redundant instruction') || f.title?.includes('redundant'),
    );
    // Three skill files share `status: graduated-code`, `version: 1.0.0`,
    // etc. in their frontmatter. Before the fix these would each surface as
    // redundant-instruction findings. With frontmatter stripping, zero.
    expect(redundant).toHaveLength(0);
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

  it('does not flag numeric literals or semver strings as dead references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Use `1.0.0` as the initial version.',
      'Threshold is `-1.5` (negative float).',
      'Release `2.4.1` ships next week.',
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

  it('does not flag method-call syntax as dead references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Call `.get()` to fetch the value.',
      'Use `path.mkdir(parents=True)` for nested creation.',
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

  it('does not flag strings with angle-bracket placeholders mid-path', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Report lives at `.data/health-reports/<project-slug>/YYYY-MM-DD-build.md`.',
      'Stage path is `.data/skill-staging/<skill-name>/SKILL.md`.',
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

  it('does not flag config-assignment strings as dead references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Set `best_moments_percentile=75.0` in the config.',
      'Override with `color.force_adaptive=True`.',
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

  it('does not flag shell-command fragments as dead references', async () => {
    const tmpDir = makeTmpDir();
    const content = [
      '# Rules',
      'Run `git -C _active/pkg log --oneline HEAD` to inspect.',
      'Count with `find ~/.claude/skills -name SKILL.md | wc -l`.',
      'Use `grep -E pattern` for extended regex.',
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

  it('still flags real dead references (tightening does not regress)', async () => {
    const tmpDir = makeTmpDir();
    // A clearly-path-shaped ref that legitimately does not exist.
    const content = [
      '# Rules',
      'See `docs/nonexistent-reference.md` for details.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('strips file-line-range suffix (foo.py:123) before existence check', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'real.py'), 'print(1)\n');
      const content = [
        '# Rules',
        'See `real.py:42` for the implementation.',
        'Range: `real.py:10-20`.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('still flags missing file even with :line suffix', async () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '# Rules',
        'See `missing.py:42` for the implementation.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('honours instructionEffectiveness.crossRepoRefs glob exemption', async () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '# Rules',
        'See `lib-skill-utils/foo.sh` for the helper.',
        'And `_active/other/bar.py` for cross-repo code.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const cfg = {
        ...defaultConfig,
        instructionEffectiveness: {
          crossRepoRefs: ['lib-skill-utils/**', '_active/**'],
        },
      };
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: cfg });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag bare file extensions (.md, .sh) as dead refs', async () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '# Rules',
        'Files ending in `.md` are governance.',
        'Scripts use `.sh` extensions.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag JS property-access strings (data.filesDiscovered) as dead refs', async () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '# Rules',
        'Parse `data.filesDiscovered` from the JSON result.',
        'Read `r.findings` for the per-check list.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not flag python3/pip-with-version shell fragments', async () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '# Rules',
        'Run `python3 -c "print(1)"` to test.',
        'Use `pip3 install foo.py` to install.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('skips dead-ref check for .claude/commands/ and skill evals/', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'foo', 'evals'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.claude', 'commands', 'test.md'),
        'Check `pyproject.toml` then `package.json`.',
      );
      fs.writeFileSync(
        path.join(tmpDir, '.claude', 'skills', 'foo', 'evals', 'acceptance-criteria.md'),
        'Read `lib-skill-utils/get-slug.sh` and `lib-skill-utils/scan.py`.',
      );
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nFollow conventions.\n');
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent-home-ie', config: defaultConfig });
      const deadRefs = result.findings.filter(f => f.title?.includes('Dead file reference'));
      expect(deadRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('dead-ref finding includes findingId, evidence, remediation, context', async () => {
    const result = await check.run({
      cwd: fixture('instruction-dead-refs'),
      homedir: '/tmp/nonexistent-home-ie',
      config: defaultConfig,
    });
    const dead = result.findings.find(f => f.title?.includes('Dead file reference'));
    expect(dead).toBeDefined();
    expect(dead.findingId).toBe('instruction-effectiveness/dead-file-reference');
    expect(typeof dead.evidence).toBe('string');
    expect(dead.evidence.length).toBeLessThanOrEqual(120);
    expect(dead.remediation).toContain('crossRepoRefs');
    expect(dead.context).toBeDefined();
    expect(dead.context.file).toBeDefined();
  });

  it('T4.4 — no finding references the author-only /instruction-audit slash command', async () => {
    // Build a workspace that triggers every code path with remediation strings:
    // - large single file (token threshold)
    // - 500+ lines (bloat)
    // - contradictions (always vs never)
    // - vague instructions
    // - redundant lines across multiple files
    const tmpDir = makeTmpDir();
    try {
      // Main file: triggers contradictions + vagueness + bloat + token threshold
      const baseLines = [
        '# Rules',
        'Always validate input data.',
        'Never validate input data lazily.',
        'Always restrict path access.',
        'Never allow unrestricted path access.',
        'Always check authentication.',
        'Never skip authentication.',
        'Always run tests.',
        'Never skip tests.',
        'Always use secure defaults.',
        'Never use insecure defaults.',
        'Use your judgment when naming variables.',
        'Figure it out as appropriate.',
        'Be smart about error handling.',
        'When it makes sense, use caching.',
        'Where applicable, cache responses.',
      ];
      // pad for bloat + token threshold
      const padded = Array(600).fill('This is a redundant governance rule with enough characters to trigger deduplication.');
      fs.writeFileSync(
        path.join(tmpDir, 'CLAUDE.md'),
        baseLines.concat(padded).join('\n'),
      );
      // Second file: duplicates the padded line across files to trigger redundancy
      fs.writeFileSync(
        path.join(tmpDir, 'AGENTS.md'),
        padded.join('\n'),
      );

      const result = await check.run({
        cwd: tmpDir,
        homedir: '/tmp/nonexistent-home-ie',
        config: defaultConfig,
      });

      for (const f of result.findings) {
        const combined = [f.title, f.detail, f.remediation].filter(Boolean).join(' ');
        expect(combined).not.toContain('/instruction-audit');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
