import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withTmpDir } from './helpers.js';
import { runInit } from '../src/cli/init-subcommand.js';

describe('rigscore init', () => {
  let originalCwd;
  let exitSpy;
  let origExit;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (origExit) process.exit = origExit;
    originalCwd = undefined;
    origExit = undefined;
  });

  it('writes a starter .rigscorerc.json', async () => {
    await withTmpDir((dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      runInit([]);
      const target = path.join(dir, '.rigscorerc.json');
      expect(fs.existsSync(target)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(parsed).toHaveProperty('profile');
      expect(parsed).toHaveProperty('failUnder');
    });
  });

  it('refuses to overwrite an existing .rigscorerc.json without --force', async () => {
    await withTmpDir((dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      fs.writeFileSync(path.join(dir, '.rigscorerc.json'), '{"keep":true}\n');

      const exits = [];
      origExit = process.exit;
      process.exit = (code) => {
        exits.push(code);
        throw new Error('EXIT');
      };
      try {
        runInit([]);
      } catch (_err) {
        /* expected */
      }
      expect(exits).toContain(1);
      const content = fs.readFileSync(path.join(dir, '.rigscorerc.json'), 'utf-8');
      expect(content).toContain('"keep":true');
    });
  });

  it('--example scaffolds a demo project with intentional issues', async () => {
    await withTmpDir((dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      runInit(['--example']);

      // All the headline demo files exist
      expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.claude/settings.local.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.claude/skills/demo-skill/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.rigscorerc.json'))).toBe(true);

      // MCP config has the intentional "/" filesystem server
      const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.filesystem.args).toContain('/');

      // Skill file carries the injection phrase
      const skill = fs.readFileSync(
        path.join(dir, '.claude/skills/demo-skill/SKILL.md'),
        'utf-8'
      );
      expect(skill).toMatch(/ignore previous instructions/i);
    });
  });

  it('--example is idempotent without --force (skips pre-existing files)', async () => {
    await withTmpDir((dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Keep me\n');

      runInit(['--example']);

      const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Keep me\n');
      // The rest of the scaffold is still written
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    });
  });
});
