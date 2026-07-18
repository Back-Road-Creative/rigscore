/**
 * RS-41 (checks part) — workflow-maturity must derive its skill/command dirs
 * from the client registry (skillDirsForBase) rather than a hardcoded
 * `.claude/skills`+`.claude/commands` pair, so it isn't blind to codex / gemini /
 * opencode command dirs (and picks up `.claude/agents` for free once the registry
 * lists it). agent-output-schemas' home walk gating is covered in home-scope.test.js.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/workflow-maturity.js';

const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-rs41-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
const cfg = { paths: {}, network: {}, limits: {} };

function skill(cwd, relDir, name) {
  const p = path.join(cwd, relDir, name, 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: x\n---\n# ${name}\n`);
}

describe('workflow-maturity RS-41 registry-derived skill dirs', () => {
  it('discovers a skill under a non-Claude command dir (.opencode/commands)', async () => {
    const cwd = tmp();
    const home = tmp();
    skill(cwd, path.join('.opencode', 'commands'), 'oc-skill');
    const r = await check.run({ cwd, homedir: home, config: cfg });
    expect(r.data.skillsChecked).toBeGreaterThanOrEqual(1);
    expect(r.findings.some(f => f.context?.skill === 'oc-skill')).toBe(true);
  });

  it('discovers a skill under .gemini/commands', async () => {
    const cwd = tmp();
    const home = tmp();
    skill(cwd, path.join('.gemini', 'commands'), 'gem-skill');
    const r = await check.run({ cwd, homedir: home, config: cfg });
    expect(r.findings.some(f => f.context?.skill === 'gem-skill')).toBe(true);
  });

  it('still discovers the classic .claude/skills dir', async () => {
    const cwd = tmp();
    const home = tmp();
    skill(cwd, path.join('.claude', 'skills'), 'claude-skill');
    const r = await check.run({ cwd, homedir: home, config: cfg });
    expect(r.findings.some(f => f.context?.skill === 'claude-skill')).toBe(true);
  });
});
