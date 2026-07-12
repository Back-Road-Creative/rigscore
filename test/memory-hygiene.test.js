import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/memory-hygiene.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

// Home scanning is opt-in (same gate as instruction-effectiveness / skill-files),
// so the default context leaves includeHomeSkills off.
const run = (cwd, opts = {}) =>
  check.run({ cwd, homedir: os.tmpdir(), config: {}, includeHomeSkills: false, ...opts });

function tmpMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mem-'));
  fs.mkdirSync(path.join(dir, '.claude', 'memory'), { recursive: true });
  return dir;
}

describe('memory-hygiene', () => {
  it('passes a clean indexed memory set', async () => {
    const r = await run(fixture('memory-clean'));
    expect(r.data.memoryFiles).toBe(2);
    expect(r.findings.map((f) => f.severity)).toEqual(['pass']);
    expect(r.score).toBe(100);
  });

  it('flags an empty file (warning) and a frontmatter-only stub (info)', async () => {
    const r = await run(fixture('memory-messy'));
    const stale = r.findings.filter((f) => f.findingId === 'memory-hygiene/stale-memory-file');
    expect(stale.map((f) => f.severity).sort()).toEqual(['info', 'warning']);
    expect(r.data.emptyFiles).toBe(1);
    expect(r.data.stubFiles).toBe(1);
    expect(r.score).toBe(83); // 100 − 15 (warning) − 2 (info)
  });

  it('flags a memory bundle over the byte budget', async () => {
    // Padding is generated at runtime — committing a >40 KB fixture would bloat the repo.
    const dir = tmpMemoryDir();
    const para = 'Long-lived operational note about the deploy pipeline and its rollback. ';
    fs.writeFileSync(path.join(dir, '.claude/memory/MEMORY.md'), '# Index\n- [Big](big.md)\n');
    fs.writeFileSync(path.join(dir, '.claude/memory/big.md'), `# Big\n\n${para.repeat(700)}\n`);
    try {
      const r = await run(dir);
      const over = r.findings.find((f) => f.findingId === 'memory-hygiene/bundle-over-budget');
      expect(over).toBeDefined();
      expect(over.severity).toBe('warning');
      expect(r.data.totalBytes).toBeGreaterThan(r.data.budgetBytes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the unindexed-memory signal to workflow-maturity (no duplicate finding)', async () => {
    const r = await run(fixture('memory-unindexed'));
    expect(r.score).not.toBe(NOT_APPLICABLE_SCORE);
    const ids = r.findings.map((f) => f.findingId || f.severity);
    expect(ids.some((id) => /orphan|index/i.test(id))).toBe(false);
  });

  it('is N/A with no memory surface, and ignores home memory unless opted in', async () => {
    const home = tmpMemoryDir();
    const note = '# Note\n\nA home memory file the project scan must not reach by default.\n';
    fs.writeFileSync(path.join(home, '.claude/memory/note.md'), note);
    try {
      const off = await run(fixture('claude-none'), { homedir: home });
      expect(off.score).toBe(NOT_APPLICABLE_SCORE);
      expect(off.data.memoryFiles).toBe(0);
      expect(off.data.homeScanned).toBe(false);
      const on = await run(fixture('claude-none'), { homedir: home, includeHomeSkills: true });
      expect(on.data.memoryFiles).toBe(1);
      expect(on.data.homeScanned).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
