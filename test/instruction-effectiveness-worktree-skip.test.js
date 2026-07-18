import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ie from '../src/checks/instruction-effectiveness.js';

// RS-16 (plan Wave 7): a parallel-agent run leaves transient full-project copies
// under `.claude/worktrees/agent-*/` that the harness never auto-unlocks. Their
// stale/relative refs would storm the self-scan with dead-file-reference findings.
// discoverFiles must skip anything under `.claude/worktrees/**` no matter which
// discovery path reaches it.

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-wt-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('instruction-effectiveness skips .claude/worktrees/** (RS-16)', () => {
  it('does not scan or flag a governance file inside an agent worktree clone', async () => {
    const wtFile = path.join(tmpDir, '.claude', 'worktrees', 'agent-fake', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(wtFile), { recursive: true });
    fs.writeFileSync(wtFile, '# WT clone\nSee `test/fixtures/broken-nonexistent.md` for details.\n');

    // config.paths.claudeMd is a real discovery path that reaches an arbitrary
    // absolute file — exactly how a worktree copy leaks into the scan surface.
    const res = await ie.run({
      cwd: tmpDir,
      homedir: '/nonexistent-home',
      config: { paths: { claudeMd: [wtFile] } },
      includeHomeSkills: false,
    });

    const scannedPaths = res.data.breakdown.map((b) => b.relPath);
    expect(scannedPaths.some((p) => p.includes('worktrees'))).toBe(false);
    const deadRefs = res.findings.filter(
      (f) => f.findingId === 'instruction-effectiveness/dead-file-reference',
    );
    expect(deadRefs).toHaveLength(0);
  });

  it('still scans a real top-level governance file (skip is worktree-scoped)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Root\nRef `missing-real.md`.\n');
    const res = await ie.run({ cwd: tmpDir, homedir: '/nonexistent-home', config: {}, includeHomeSkills: false });
    expect(res.data.breakdown.some((b) => b.relPath === 'CLAUDE.md')).toBe(true);
  });
});
