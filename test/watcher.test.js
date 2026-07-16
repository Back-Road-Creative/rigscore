import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

// Partial mocks: replace only scan() and formatTerminal() so buildRescan is
// deterministic; suppressFindings/scoreScan/resolveWeights stay real so the
// suppress-on-rescan wiring is exercised end-to-end.
vi.mock('../src/scanner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, scan: vi.fn() };
});
vi.mock('../src/reporter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, formatTerminal: vi.fn(() => '') };
});

import { scan } from '../src/scanner.js';
import {
  createDebouncer, shouldTrigger, buildRescan, buildScanOptions, setupWatchers,
} from '../src/watcher.js';

function capture(stream) {
  const chunks = [];
  const orig = process[stream].write;
  process[stream].write = (c) => { chunks.push(String(c)); return true; };
  return { text: () => chunks.join(''), restore: () => { process[stream].write = orig; } };
}

describe('watcher', () => {
  describe('shouldTrigger', () => {
    it('triggers on CLAUDE.md', () => {
      expect(shouldTrigger('CLAUDE.md')).toBe(true);
    });

    it('triggers on .env files', () => {
      expect(shouldTrigger('.env')).toBe(true);
      expect(shouldTrigger('.env.local')).toBe(true);
    });

    it('triggers on docker-compose files', () => {
      expect(shouldTrigger('docker-compose.yml')).toBe(true);
      expect(shouldTrigger('compose.yaml')).toBe(true);
    });

    it('triggers on Dockerfile', () => {
      expect(shouldTrigger('Dockerfile')).toBe(true);
      expect(shouldTrigger('Dockerfile.dev')).toBe(true);
    });

    it('triggers on .mcp.json', () => {
      expect(shouldTrigger('.mcp.json')).toBe(true);
    });

    it('triggers on git hooks', () => {
      expect(shouldTrigger('.git/hooks/pre-commit')).toBe(true);
    });

    it('triggers on .rigscorerc.json', () => {
      expect(shouldTrigger('.rigscorerc.json')).toBe(true);
    });

    it('triggers on governance files', () => {
      expect(shouldTrigger('.cursorrules')).toBe(true);
      expect(shouldTrigger('.windsurfrules')).toBe(true);
      expect(shouldTrigger('AGENTS.md')).toBe(true);
    });

    it('does not trigger on random JS files', () => {
      expect(shouldTrigger('index.js')).toBe(false);
      expect(shouldTrigger('src/app.ts')).toBe(false);
    });

    it('does not trigger on random YAML files', () => {
      expect(shouldTrigger('config.yaml')).toBe(false);
    });

    it('triggers on null filename (platform compat)', () => {
      expect(shouldTrigger(null)).toBe(true);
      expect(shouldTrigger(undefined)).toBe(true);
    });
  });

  describe('buildRescan (failUnder warn-only)', () => {
    it('writes a below-threshold warning to stderr on rescan', async () => {
      scan.mockResolvedValue({ score: 10, notApplicable: false, config: {}, results: [] });
      const stderr = capture('stderr');
      const stdout = capture('stdout');
      try {
        const rescan = buildRescan({ cwd: '/x', scanOptions: {}, options: { failUnder: 70 } });
        const result = await rescan();
        expect(result.score).toBe(10);
        expect(stderr.text()).toMatch(/below --fail-under 70/);
      } finally {
        stderr.restore();
        stdout.restore();
      }
    });

    it('applies suppress:/--ignore on rescan (muted findings do not resurface)', async () => {
      const result = {
        score: 0,
        notApplicable: false,
        config: {},
        results: [{
          id: 'env-exposure',
          score: 0,
          weight: 8,
          findings: [{
            severity: 'critical',
            title: '.env file found but NOT in .gitignore',
            findingId: 'env-exposure/env-file-found-but-not-in-gitignore',
          }],
        }],
      };
      scan.mockResolvedValue(result);
      const stderr = capture('stderr');
      const stdout = capture('stdout');
      try {
        const rescan = buildRescan({
          cwd: '/x',
          scanOptions: {},
          options: { ignore: ['env-exposure/env-file-found-but-not-in-gitignore'] },
        });
        const out = await rescan();
        expect(out.suppressed.count).toBe(1);
        expect(out.results[0].findings).toHaveLength(0);
      } finally {
        stderr.restore();
        stdout.restore();
      }
    });
  });

  describe('shouldTrigger — 2.1.0 governance surfaces', () => {
    it('triggers on newer single-file governance surfaces', () => {
      for (const f of ['.roorules', '.goosehints', 'QWEN.md', 'CRUSH.md', 'GEMINI.md']) {
        expect(shouldTrigger(f)).toBe(true);
      }
    });

    it('triggers on path-form governance files', () => {
      expect(shouldTrigger('.junie/guidelines.md')).toBe(true);
      expect(shouldTrigger('.github/copilot-instructions.md')).toBe(true);
    });

    it('triggers on directory-form rule sets (default-scanned in 2.1.0)', () => {
      expect(shouldTrigger('.cursor/rules/style.mdc')).toBe(true);
      expect(shouldTrigger('.github/instructions/x.instructions.md')).toBe(true);
      expect(shouldTrigger('.amazonq/rules/y.md')).toBe(true);
      expect(shouldTrigger('.kiro/steering/z.md')).toBe(true);
      expect(shouldTrigger('.windsurf/rules/w.md')).toBe(true);
    });
  });

  describe('buildScanOptions (flag pass-through parity with the one-shot path)', () => {
    it('writeState defaults on and honors --no-state-write', () => {
      expect(buildScanOptions('/p', {}).writeState).toBe(true);
      expect(buildScanOptions('/p', { noStateWrite: true }).writeState).toBe(false);
    });

    it('passes semantic / includeHomeSkills / refreshMcpRegistry / profile through', () => {
      const o = buildScanOptions('/p', {
        semantic: true, includeHomeSkills: true, refreshMcpRegistry: true,
        deep: true, online: true, profile: 'monorepo', checkFilter: 'mcp-config',
      });
      expect(o).toMatchObject({
        cwd: '/p', semantic: true, includeHomeSkills: true, refreshMcpRegistry: true,
        deep: true, online: true, profile: 'monorepo', checkFilter: 'mcp-config',
      });
    });
  });

  describe('setupWatchers (recursive with Node<19.1 Linux fallback)', () => {
    it('uses a single recursive watcher when the platform supports it', () => {
      const fake = { close: vi.fn() };
      const spy = vi.spyOn(fs, 'watch').mockReturnValue(fake);
      try {
        const watchers = setupWatchers('/proj', () => {});
        expect(watchers).toEqual([fake]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('/proj');
        expect(spy.mock.calls[0][1]).toEqual({ recursive: true });
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to non-recursive watchers + a clear note when recursive is unsupported', () => {
      const err = new Error('recursive not supported');
      err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      const fake = { close: vi.fn() };
      const spy = vi.spyOn(fs, 'watch').mockImplementation((p, a) => {
        if (a && a.recursive) throw err;
        return fake;
      });
      const stderr = capture('stderr');
      try {
        const watchers = setupWatchers('/proj-does-not-exist', () => {});
        expect(watchers[0]).toBe(fake);
        expect(stderr.text()).toMatch(/Node >= 19\.1/);
        // The root re-watch is non-recursive (no {recursive:true}).
        const rootRewatch = spy.mock.calls.find(
          (c) => c[0] === '/proj-does-not-exist' && !(c[1] && c[1].recursive),
        );
        expect(rootRewatch).toBeTruthy();
      } finally {
        spy.mockRestore();
        stderr.restore();
      }
    });

    it('rethrows watch errors that are not the platform-unsupported case', () => {
      const err = new Error('boom');
      err.code = 'EACCES';
      const spy = vi.spyOn(fs, 'watch').mockImplementation(() => { throw err; });
      try {
        expect(() => setupWatchers('/proj', () => {})).toThrow(/boom/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('createDebouncer', () => {
    it('debounces rapid calls', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 50);

      debounced();
      debounced();
      debounced();

      // Should not have fired yet
      expect(callCount).toBe(0);

      // Wait for debounce
      await new Promise(r => setTimeout(r, 100));
      expect(callCount).toBe(1);
    });

    it('fires after delay with no subsequent calls', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 50);

      debounced();
      await new Promise(r => setTimeout(r, 100));
      expect(callCount).toBe(1);
    });

    it('resets timer on each call', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 100);

      debounced();
      await new Promise(r => setTimeout(r, 60));
      debounced(); // reset timer
      await new Promise(r => setTimeout(r, 60));
      expect(callCount).toBe(0); // still hasn't fired

      await new Promise(r => setTimeout(r, 60));
      expect(callCount).toBe(1);
    });
  });
});
