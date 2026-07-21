import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import check from '../src/checks/staged-copy-drift.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-scd-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    try { fs.rmSync(tmpdirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function write(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const ROWS = [{ tracked: 'staged/skills', deployed: '.claude/skills' }];
const ctx = (cwd, homedir, over = {}) => ({
  cwd, homedir, includeHomeSkills: true, config: { stagedCopies: ROWS }, ...over,
});
const drifted = (findings) => findings.filter((f) => f.findingId === 'staged-copy-drift/content-drift');

describe('staged-copy-drift check', () => {
  it('has the required module shape and is advisory', () => {
    expect(check.id).toBe('staged-copy-drift');
    expect(check.category).toBe('process');
    expect(typeof check.run).toBe('function');
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('is N/A without --include-home-skills, and reads nothing from home', async () => {
    const cwd = tmp();
    const home = tmp();
    write(cwd, 'staged/skills/a/SKILL.md', 'tracked\n');
    write(home, '.claude/skills/a/SKILL.md', 'deployed — DIFFERENT\n');

    const result = await check.run(ctx(cwd, home, { includeHomeSkills: false }));
    // The drifting twin above is invisible: the home read never happened.
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toEqual([]);
  });

  it('passes when every tracked file matches its deployed twin', async () => {
    const cwd = tmp();
    const home = tmp();
    write(cwd, 'staged/skills/a/SKILL.md', 'same bytes\n');
    write(home, '.claude/skills/a/SKILL.md', 'same bytes\n');

    const result = await check.run(ctx(cwd, home));
    expect(result.score).not.toBe(NOT_APPLICABLE_SCORE);
    expect(drifted(result.findings)).toHaveLength(0);
    expect(result.findings.some((f) => f.severity === 'pass')).toBe(true);
  });

  it('warns once per file whose deployed twin has different bytes', async () => {
    const cwd = tmp();
    const home = tmp();
    write(cwd, 'staged/skills/a/SKILL.md', 'tracked copy\n');
    write(home, '.claude/skills/a/SKILL.md', 'deployed copy — redeployed, never committed\n');

    const result = await check.run(ctx(cwd, home));
    const hits = drifted(result.findings);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warning');
    expect(hits[0].title).toContain('a/SKILL.md');
    expect(hits[0].evidence).toMatch(/[0-9a-f]{8}/);
    expect(hits[0].evidence.length).toBeLessThanOrEqual(120);
  });

  it('ignores a tracked file with no deployed twin (deployment coverage is not this check)', async () => {
    const cwd = tmp();
    const home = tmp();
    write(cwd, 'staged/skills/install.sh', '#!/usr/bin/env bash\n');
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });

    const result = await check.run(ctx(cwd, home));
    expect(drifted(result.findings)).toHaveLength(0);
  });

  it('skips noise dirs and per-row exclude globs', async () => {
    const cwd = tmp();
    const home = tmp();
    write(cwd, 'staged/skills/node_modules/x.md', 'tracked\n');
    write(home, '.claude/skills/node_modules/x.md', 'deployed\n');
    write(cwd, 'staged/skills/build/out.md', 'tracked\n');
    write(home, '.claude/skills/build/out.md', 'deployed\n');

    const rows = [{ ...ROWS[0], exclude: ['build/**'] }];
    const result = await check.run(ctx(cwd, home, { config: { stagedCopies: rows } }));
    expect(drifted(result.findings)).toHaveLength(0);
  });

  it('passes when no stagedCopies rows are configured', async () => {
    const result = await check.run(ctx(tmp(), tmp(), { config: { stagedCopies: [] } }));
    expect(result.score).not.toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings.some((f) => f.severity === 'pass')).toBe(true);
  });
});
