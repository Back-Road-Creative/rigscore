import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { toPosix, relPosix } from '../src/utils.js';

// Rendered paths are part of rigscore's output contract: findings are compared as
// strings, SARIF artifact locations are URI-style, and baseline keys are matched
// across machines. `path.relative()`/`path.join()` hand back NATIVE separators, so
// on win32 the same repo used to render `apps\api\.env` — unequal to the
// `apps/api/.env` every other platform (and every test) produces.
describe('win32 path separators', () => {
  describe('toPosix', () => {
    it('rewrites a Windows-style path to forward slashes', () => {
      expect(toPosix('a\\b\\c.js')).toBe('a/b/c.js');
    });

    it('leaves an already-POSIX path untouched', () => {
      expect(toPosix('.specify/memory/constitution.md')).toBe('.specify/memory/constitution.md');
    });

    it('normalizes what path.win32 would emit on a real Windows runner', () => {
      const nativeRel = path.win32.relative('C:\\repo', 'C:\\repo\\apps\\api\\.env');
      expect(nativeRel).toBe('apps\\api\\.env'); // what win32 actually hands back
      expect(toPosix(nativeRel)).toBe('apps/api/.env');
      expect(toPosix(path.win32.join('.specify', 'memory', 'constitution.md')))
        .toBe('.specify/memory/constitution.md');
    });

    it('handles the `~`-substituted home paths labels are built from', () => {
      expect(toPosix('C:\\Users\\dev'.replace('C:\\Users\\dev', '~'))).toBe('~');
      expect(toPosix('~\\.claude\\CLAUDE.md')).toBe('~/.claude/CLAUDE.md');
    });

    it('passes non-strings through untouched', () => {
      expect(toPosix(undefined)).toBe(undefined);
      expect(toPosix(null)).toBe(null);
    });
  });

  describe('relPosix', () => {
    it('never emits a backslash, on any platform', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-win32-'));
      try {
        const nested = path.join(root, 'apps', 'api');
        fs.mkdirSync(nested, { recursive: true });
        const file = path.join(nested, '.env');
        fs.writeFileSync(file, 'API_KEY=x\n');

        const rel = relPosix(root, file);
        expect(rel).not.toContain('\\');
        expect(rel).toBe('apps/api/.env');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('agrees with path.relative once separators are normalized', () => {
      const from = process.cwd();
      const to = path.join(process.cwd(), 'src', 'checks', 'deep-secrets.js');
      expect(relPosix(from, to)).toBe(toPosix(path.relative(from, to)));
      expect(relPosix(from, to)).toBe('src/checks/deep-secrets.js');
    });

    it('keeps a `..` escape recognizable (callers gate on it)', () => {
      const rel = relPosix(path.join(process.cwd(), 'src'), process.cwd());
      expect(rel).toBe('..');
      expect(rel.startsWith('..')).toBe(true);
    });
  });

  it('no src/ file rebuilds the private slash helper it replaced', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && full !== path.join(process.cwd(), 'src', 'utils.js')) {
          if (/const\s+slash\s*=/.test(fs.readFileSync(full, 'utf-8'))) offenders.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders, 'use toPosix/relPosix from src/utils.js instead').toEqual([]);
  });
});
