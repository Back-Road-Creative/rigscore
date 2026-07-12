import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import claudeMd from '../src/checks/claude-md.js';
import { listPacks, installPack } from '../src/cli/packs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docs-pack-'));

// The docs pack claims claude-md. Prove it against the real check: a watered-down or
// keyword-gamed template (a negated or reversed match) turns this red.
describe('docs pack', () => {
  it('is discovered in the real templates/ dir', () => {
    expect(listPacks()).toContain('docs');
  });

  it('turns claude-md green on a bare project', async () => {
    const homedir = tmp();
    const target = tmp();
    const before = await claudeMd.run({ cwd: target, homedir, config: {} });
    installPack('docs', target);
    const after = await claudeMd.run({ cwd: target, homedir, config: {} });
    expect(after.score).toBe(100);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.findings.filter((f) => f.severity !== 'pass')).toEqual([]);
    expect(after.data.matchedPatterns).toHaveLength(9);
  });
});
