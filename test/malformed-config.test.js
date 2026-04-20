import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { ConfigParseError, readJsonStrict } from '../src/utils.js';
import { withTmpDir } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'rigscore.js');

describe('A3: malformed user config', () => {
  describe('readJsonStrict', () => {
    it('returns null for a missing file (not a parse error)', async () => {
      await withTmpDir(async (tmp) => {
        const result = await readJsonStrict(path.join(tmp, 'nope.json'));
        expect(result).toBeNull();
      });
    });

    it('parses a valid file', async () => {
      await withTmpDir(async (tmp) => {
        const p = path.join(tmp, 'good.json');
        fs.writeFileSync(p, JSON.stringify({ hello: 'world' }));
        const result = await readJsonStrict(p);
        expect(result).toEqual({ hello: 'world' });
      });
    });

    it('tolerates trailing commas (JSONC-style)', async () => {
      await withTmpDir(async (tmp) => {
        const p = path.join(tmp, 'jsonc.json');
        fs.writeFileSync(p, '{\n  "a": 1,\n  "b": 2,\n}\n');
        const result = await readJsonStrict(p);
        expect(result).toEqual({ a: 1, b: 2 });
      });
    });

    it('throws ConfigParseError on unbalanced braces', async () => {
      await withTmpDir(async (tmp) => {
        const p = path.join(tmp, 'bad.json');
        fs.writeFileSync(p, '{ "a": 1 ');
        await expect(readJsonStrict(p)).rejects.toThrow(ConfigParseError);
      });
    });

    it('throws ConfigParseError on complete garbage', async () => {
      await withTmpDir(async (tmp) => {
        const p = path.join(tmp, 'bad.json');
        fs.writeFileSync(p, 'not json at all {{{');
        await expect(readJsonStrict(p)).rejects.toThrow(ConfigParseError);
      });
    });

    it('ConfigParseError carries the file path, parse message, and a hint', async () => {
      await withTmpDir(async (tmp) => {
        const p = path.join(tmp, 'x.rigscorerc.json');
        fs.writeFileSync(p, '{ "a": }');
        try {
          await readJsonStrict(p);
          throw new Error('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigParseError);
          expect(err.filePath).toBe(p);
          expect(err.parseMessage).toMatch(/./);
          expect(err.hint).toMatch(/./);
          const msg = err.toUserMessage();
          expect(msg).toMatch(/^rigscore:/);
          expect(msg).toContain(p);
          expect(msg).toContain('is not valid JSON');
        }
      });
    });
  });

  describe('loadConfig', () => {
    it('propagates ConfigParseError from project .rigscorerc.json', async () => {
      await withTmpDir(async (tmp) => {
        fs.writeFileSync(
          path.join(tmp, '.rigscorerc.json'),
          '{ "profile": "minimal" ',  // missing closing brace
        );
        await expect(loadConfig(tmp, '/tmp/nonexistent'))
          .rejects.toThrow(ConfigParseError);
      });
    });

    it('propagates ConfigParseError from home .rigscorerc.json', async () => {
      await withTmpDir(async (cwdDir) => {
        await withTmpDir(async (homeDir) => {
          fs.writeFileSync(
            path.join(homeDir, '.rigscorerc.json'),
            '{{ not json',
          );
          await expect(loadConfig(cwdDir, homeDir))
            .rejects.toThrow(ConfigParseError);
        });
      });
    });
  });

  describe('CLI exit behavior', () => {
    it('exits 2 with a friendly message on malformed .rigscorerc.json', async () => {
      await withTmpDir(async (tmp) => {
        fs.writeFileSync(
          path.join(tmp, '.rigscorerc.json'),
          '{ "profile": "minimal", }',  // trailing comma is fine …
        );
        // … but add a genuinely malformed fixture too:
        fs.writeFileSync(
          path.join(tmp, '.rigscorerc.json'),
          '{ "profile": "minimal" "weights": 1 }',  // missing comma between fields
        );

        const result = spawnSync('node', [BIN, tmp, '--json'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: '/tmp/nonexistent-home-dir', NO_COLOR: '1' },
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('rigscore:');
        expect(result.stderr).toContain('is not valid JSON');
      });
    }, 20_000);
  });
});
