import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withTmpDir } from './helpers.js';
import { parseArgs, run } from '../src/index.js';

describe('--init-hook', () => {
  it('parseArgs recognizes --init-hook', () => {
    const opts = parseArgs(['--init-hook']);
    expect(opts.initHook).toBe(true);
  });

  it('installs pre-commit hook in .git/hooks', async () => {
    await withTmpDir(async (dir) => {
      // Create .git directory
      fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });

      // Mock process.exit and process.stderr
      const exits = [];
      const origExit = process.exit;
      const origCwd = process.cwd;
      process.exit = (code) => { exits.push(code); throw new Error('EXIT'); };

      try {
        await run(['--init-hook', dir]).catch(() => {});
      } finally {
        process.exit = origExit;
      }

      const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('rigscore');
      expect(content).toContain('--fail-under 70');

      // Check executable
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o111).not.toBe(0);
    });
  });

  it('skips if rigscore already in hook', async () => {
    await withTmpDir(async (dir) => {
      const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
      fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(hookPath, '#!/bin/sh\nnpx rigscore --fail-under 70\n');

      const output = [];
      const origWrite = process.stderr.write;
      process.stderr.write = (msg) => { output.push(msg); return true; };
      const origExit = process.exit;
      process.exit = (code) => { throw new Error('EXIT_' + code); };

      try {
        await run(['--init-hook', dir]).catch(() => {});
      } finally {
        process.stderr.write = origWrite;
        process.exit = origExit;
      }

      expect(output.some(m => m.includes('already installed'))).toBe(true);
    });
  });

  it('appends to existing hook without rigscore', async () => {
    await withTmpDir(async (dir) => {
      const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
      fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n');

      const origExit = process.exit;
      process.exit = () => { throw new Error('EXIT'); };

      try {
        await run(['--init-hook', dir]).catch(() => {});
      } finally {
        process.exit = origExit;
      }

      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('existing hook');
      expect(content).toContain('rigscore');
    });
  });

  it('fails if no .git directory', async () => {
    await withTmpDir(async (dir) => {
      const output = [];
      const origWrite = process.stderr.write;
      process.stderr.write = (msg) => { output.push(msg); return true; };
      const origExit = process.exit;
      let exitCode;
      process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };

      try {
        await run(['--init-hook', dir]).catch(() => {});
      } finally {
        process.stderr.write = origWrite;
        process.exit = origExit;
      }

      expect(exitCode).toBe(1);
      expect(output.some(m => m.includes('No .git directory'))).toBe(true);
    });
  });
});
