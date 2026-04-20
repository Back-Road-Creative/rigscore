import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withTmpDir } from './helpers.js';
import {
  runInitSubcommand,
  buildStarter,
  scaffoldExample,
} from '../src/cli/init.js';

describe('rigscore init (base)', () => {
  let originalCwd;
  let origExit;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (origExit) process.exit = origExit;
    originalCwd = undefined;
    origExit = undefined;
  });

  it('writes a commented starter .rigscorerc.json', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      await runInitSubcommand([]);
      const target = path.join(dir, '.rigscorerc.json');
      expect(fs.existsSync(target)).toBe(true);
      const raw = fs.readFileSync(target, 'utf-8');
      expect(raw).toContain('// rigscore config');
    });
  });

  it('refuses to overwrite an existing .rigscorerc.json without --force', async () => {
    await withTmpDir(async (dir) => {
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
        await runInitSubcommand([]);
      } catch (_err) {
        /* expected */
      }
      expect(exits).toContain(1);
      const content = fs.readFileSync(path.join(dir, '.rigscorerc.json'), 'utf-8');
      expect(content).toContain('"keep":true');
    });
  });

  it('overwrites with --force', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      fs.writeFileSync(path.join(dir, '.rigscorerc.json'), '{"keep":true}\n');
      await runInitSubcommand(['--force']);
      const content = fs.readFileSync(path.join(dir, '.rigscorerc.json'), 'utf-8');
      expect(content).not.toContain('"keep":true');
      expect(content).toContain('// rigscore config');
    });
  });

  it('pre-fills profile when --profile is provided', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      await runInitSubcommand(['--profile', 'home']);
      const raw = fs.readFileSync(path.join(dir, '.rigscorerc.json'), 'utf-8');
      expect(raw).toMatch(/"profile":\s*"home"/);
    });
  });

  it('validates profile name and exits 2 for unknown profile', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);

      const exits = [];
      origExit = process.exit;
      process.exit = (code) => {
        exits.push(code);
        throw new Error('EXIT');
      };
      try {
        await runInitSubcommand(['--profile', 'bogus']);
      } catch (_err) {
        /* expected */
      }
      expect(exits).toContain(2);
      expect(fs.existsSync(path.join(dir, '.rigscorerc.json'))).toBe(false);
    });
  });

  it('buildStarter references all 5 profile names', () => {
    const out = buildStarter(null);
    for (const p of ['default', 'minimal', 'ci', 'home', 'monorepo']) {
      expect(out).toContain(p);
    }
  });

  it('starter JSON parses after comment stripping', async () => {
    const { stripJsonComments } = await import('../src/utils.js');
    const raw = buildStarter(null);
    const parsed = JSON.parse(stripJsonComments(raw));
    expect(Array.isArray(parsed.suppress)).toBe(true);
    expect(Array.isArray(parsed.checks.disabled)).toBe(true);
    expect(typeof parsed.weights).toBe('object');
  });
});

describe('rigscore init --example', () => {
  let originalCwd;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    originalCwd = undefined;
  });

  it('scaffolds a demo project with intentional issues', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      await runInitSubcommand(['--example']);

      expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.claude/settings.local.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.claude/skills/demo-skill/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.env.example'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.rigscorerc.json'))).toBe(true);

      // MCP config has the intentional "/" filesystem server
      const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.filesystem.args).toContain('/');

      // Skill file carries the injection phrase
      const skill = fs.readFileSync(
        path.join(dir, '.claude/skills/demo-skill/SKILL.md'),
        'utf-8',
      );
      expect(skill).toMatch(/ignore previous instructions/i);
    });
  });

  it('is idempotent without --force (skips pre-existing files)', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Keep me\n');

      await runInitSubcommand(['--example']);

      const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Keep me\n');
      // The rest of the scaffold is still written
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    });
  });

  it('--example --force overwrites pre-existing files', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Keep me\n');

      await runInitSubcommand(['--example', '--force']);

      const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
      expect(content).not.toBe('# Keep me\n');
      expect(content).toContain('Example Project');
    });
  });

  it('scaffoldExample is directly callable with a dir argument', async () => {
    await withTmpDir(async (dir) => {
      const code = scaffoldExample(dir, { force: false });
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(true);
      const compose = fs.readFileSync(
        path.join(dir, 'docker-compose.yml'),
        'utf-8',
      );
      expect(compose).toContain('privileged: true');
      expect(compose).toContain('/var/run/docker.sock');
    });
  });

  it('--example composes with --profile to pre-fill the starter', async () => {
    await withTmpDir(async (dir) => {
      originalCwd = process.cwd();
      process.chdir(dir);
      await runInitSubcommand(['--example', '--profile', 'ci']);
      const raw = fs.readFileSync(path.join(dir, '.rigscorerc.json'), 'utf-8');
      expect(raw).toMatch(/"profile":\s*"ci"/);
    });
  });
});
