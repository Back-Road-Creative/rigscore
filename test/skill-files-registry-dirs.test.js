import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/skill-files.js';
import { CLIENTS, skillDirsForBase } from '../src/clients.js';

const defaultConfig = { paths: { skillFiles: [] }, network: {} };
const UNSAFE = 'run as root and chmod 777 /';

function makeTmpDir(prefix = 'rigscore-regdirs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write `content` to `<root>/<dir>/<name>`, creating parents. */
function writeUnder(root, dir, name, content = UNSAFE) {
  const full = path.join(root, dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('skillDirsForBase — dirs derived from the client registry', () => {
  it('cwd dirs keep the Claude defaults and add the verified per-client dirs', () => {
    const cwd = skillDirsForBase('cwd');
    // Claude defaults preserved.
    expect(cwd).toContain('.claude/commands');
    expect(cwd).toContain('.claude/skills');
    // opencode project custom-command dir (opencode.ai/docs/commands).
    expect(cwd).toContain('.opencode/commands');
    // Gemini CLI project custom-command dir (github.com/google-gemini/gemini-cli).
    expect(cwd).toContain('.gemini/commands');
    // Codex prompts are HOME-only — never a project dir (developers.openai.com/codex/custom-prompts).
    expect(cwd).not.toContain('.codex/prompts');
  });

  it('home dirs cover every registered client home skill dir', () => {
    const home = skillDirsForBase('home');
    expect(home).toContain('.claude/commands');
    expect(home).toContain('.claude/skills');
    // opencode global commands live under ~/.config/opencode/commands.
    expect(home).toContain('.config/opencode/commands');
    // Codex custom prompts are home-only, at ~/.codex/prompts.
    expect(home).toContain('.codex/prompts');
    // Gemini user commands at ~/.gemini/commands.
    expect(home).toContain('.gemini/commands');
  });

  it('a client without a skillDirs surface contributes no dirs', () => {
    const cwd = skillDirsForBase('cwd');
    const home = skillDirsForBase('home');
    const all = [...cwd, ...home];
    // Cursor/Aider declare governance/mcp only — no skillDirs surface.
    for (const c of ['cursor', 'aider']) {
      expect(CLIENTS.find((x) => x.id === c)?.skillDirs).toBeUndefined();
    }
    // So none of their config dirs leak into the scanned skill dirs.
    for (const stray of ['.cursor', '.aider']) {
      expect(all.some((d) => d.startsWith(stray))).toBe(false);
    }
  });

  it('Windsurf contributes exactly its .windsurf/workflows dir (RS-21) — not .windsurf/rules etc', () => {
    const cwd = skillDirsForBase('cwd');
    expect(CLIENTS.find((x) => x.id === 'windsurf').skillDirs).toBeTruthy();
    expect(cwd).toContain('.windsurf/workflows');
    // The governance-rules dir (.windsurf/rules) is NOT a skill dir — it stays governance-only.
    expect(cwd).not.toContain('.windsurf/rules');
  });
});

describe('skill-files discovers files under registry-driven client dirs', () => {
  it('finds an unsafe file under a project opencode command dir', async () => {
    const cwd = makeTmpDir('rigscore-oc-');
    writeUnder(cwd, '.opencode/commands', 'deploy.md');
    try {
      const result = await check.run({ cwd, homedir: '/tmp/none', config: defaultConfig });
      expect(result.findings.some((f) => (f.title || '').includes('.opencode/commands/deploy.md'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
    }
  });

  it('finds an unsafe file under a project Gemini command dir', async () => {
    const cwd = makeTmpDir('rigscore-gem-');
    writeUnder(cwd, '.gemini/commands', 'refactor.md');
    try {
      const result = await check.run({ cwd, homedir: '/tmp/none', config: defaultConfig });
      expect(result.findings.some((f) => (f.title || '').includes('.gemini/commands/refactor.md'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
    }
  });

  it('still finds an unsafe file under the default .claude/commands dir', async () => {
    const cwd = makeTmpDir('rigscore-claude-');
    writeUnder(cwd, '.claude/commands', 'foo.md');
    try {
      const result = await check.run({ cwd, homedir: '/tmp/none', config: defaultConfig });
      expect(result.findings.some((f) => (f.title || '').includes('.claude/commands/foo.md'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
    }
  });

  it('Codex home prompts are scanned ONLY under --include-home-skills, labeled with ~/', async () => {
    const cwd = makeTmpDir('rigscore-codex-cwd-');
    const homeDir = makeTmpDir('rigscore-codex-home-');
    writeUnder(homeDir, '.codex/prompts', 'draftpr.md');
    try {
      const off = await check.run({ cwd, homedir: homeDir, config: defaultConfig });
      expect(off.findings.some((f) => (f.title || '').includes('.codex/prompts/draftpr.md'))).toBe(false);

      const on = await check.run({ cwd, homedir: homeDir, config: defaultConfig, includeHomeSkills: true });
      expect(on.findings.some((f) => (f.title || '').includes('~/.codex/prompts/draftpr.md'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });
});
