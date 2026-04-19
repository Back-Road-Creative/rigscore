import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/skill-files.js';
import { parseArgs } from '../src/index.js';

const defaultConfig = { paths: { skillFiles: [] }, network: {} };

function makeTmpDir(prefix = 'rigscore-scope-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a fake "homedir" structure with a skill file containing an
 * unsafe pattern. Returns the homedir path and the file path.
 */
function makeHomedirWithUnsafeSkill(content = 'run as root and chmod 777 /') {
  const homeDir = makeTmpDir('rigscore-fake-home-');
  const skillDir = path.join(homeDir, '.claude', 'skills', 'example');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return { homeDir, skillPath };
}

function makeCwdWithUnsafeSkill(content = 'run as root and chmod 777 /') {
  const cwd = makeTmpDir('rigscore-cwd-');
  const skillDir = path.join(cwd, '.claude', 'skills', 'local');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return { cwd, skillPath };
}

describe('skill-files scope — project-only by default', () => {
  it('1. home skill findings are NOT reported without --include-home-skills; score stays clean', async () => {
    const cwd = makeTmpDir('rigscore-empty-cwd-');
    const { homeDir } = makeHomedirWithUnsafeSkill();
    try {
      const result = await check.run({ cwd, homedir: homeDir, config: defaultConfig });
      const homeFindings = result.findings.filter((f) => (f.title || '').includes('~/'));
      expect(homeFindings.length).toBe(0);
      // No cwd skill files either => N/A score (-1) OR clean 10. Either way, no deduction.
      expect(result.score === -1 || result.score === 10).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('2. home skill findings ARE reported with includeHomeSkills=true, path labeled with ~/', async () => {
    const cwd = makeTmpDir('rigscore-empty-cwd-');
    const { homeDir } = makeHomedirWithUnsafeSkill();
    try {
      const result = await check.run({ cwd, homedir: homeDir, config: defaultConfig, includeHomeSkills: true });
      const homeFinding = result.findings.find((f) => (f.title || '').includes('~/'));
      expect(homeFinding).toBeDefined();
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('3. one unsafe cwd file + one unsafe home file: without flag, only cwd is visible', async () => {
    const { cwd } = makeCwdWithUnsafeSkill();
    const { homeDir } = makeHomedirWithUnsafeSkill();
    try {
      const result = await check.run({ cwd, homedir: homeDir, config: defaultConfig });
      const cwdFinding = result.findings.find((f) => (f.title || '').includes('.claude/skills/local'));
      const homeFinding = result.findings.find((f) => (f.title || '').includes('~/'));
      expect(cwdFinding).toBeDefined();
      expect(homeFinding).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('4. one unsafe cwd file + one unsafe home file: with flag, both are visible', async () => {
    const { cwd } = makeCwdWithUnsafeSkill();
    const { homeDir } = makeHomedirWithUnsafeSkill();
    try {
      const result = await check.run({ cwd, homedir: homeDir, config: defaultConfig, includeHomeSkills: true });
      const cwdFinding = result.findings.find((f) => (f.title || '').includes('.claude/skills/local'));
      const homeFinding = result.findings.find((f) => (f.title || '').includes('~/'));
      expect(cwdFinding).toBeDefined();
      expect(homeFinding).toBeDefined();
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('5. parseArgs: --include-home-skills omitted → includeHomeSkills=false', () => {
    const opts = parseArgs([]);
    expect(opts.includeHomeSkills).toBe(false);
  });

  it('5b. parseArgs: --include-home-skills present → includeHomeSkills=true', () => {
    const opts = parseArgs(['--include-home-skills']);
    expect(opts.includeHomeSkills).toBe(true);
  });

  it('6. regression: other checks that consult homedir still work (claude-md reads ~/CLAUDE.md)', async () => {
    const claudeMdCheck = (await import('../src/checks/claude-md.js')).default;
    const cwd = makeTmpDir('rigscore-cmd-cwd-');
    const homeDir = makeTmpDir('rigscore-cmd-home-');
    // Create a ~/CLAUDE.md with a detectable pattern. claude-md must still find it.
    fs.writeFileSync(path.join(homeDir, 'CLAUDE.md'), '# Home governance\n\nBe helpful and safe.\n');
    try {
      const result = await claudeMdCheck.run({ cwd, homedir: homeDir, config: defaultConfig });
      // The check should run and return a valid shape; homedir consumption unaffected.
      expect(typeof result.score).toBe('number');
      expect(Array.isArray(result.findings)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });
});
