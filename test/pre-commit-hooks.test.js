import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as YAML from 'yaml';

// Resolve .pre-commit-hooks.yaml relative to this test file (repo root).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hooksPath = path.resolve(__dirname, '..', '.pre-commit-hooks.yaml');

describe('.pre-commit-hooks.yaml — pre-commit.com framework distribution', () => {
  it('exists at the repo root', () => {
    expect(
      existsSync(hooksPath),
      '.pre-commit-hooks.yaml is required so consumers can add rigscore to .pre-commit-config.yaml',
    ).toBe(true);
  });

  it('parses as a YAML list of hook definitions', () => {
    const parsed = YAML.parse(readFileSync(hooksPath, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
  });

  it('defines a hook with id "rigscore"', () => {
    const parsed = YAML.parse(readFileSync(hooksPath, 'utf8'));
    const hook = parsed.find((h) => h && h.id === 'rigscore');
    expect(hook, 'no hook with id "rigscore" found').toBeDefined();
  });

  describe('the rigscore hook', () => {
    const parsed = YAML.parse(readFileSync(hooksPath, 'utf8'));
    const hook = Array.isArray(parsed) ? parsed.find((h) => h && h.id === 'rigscore') : undefined;

    it('installs via the node language (uses package.json bin)', () => {
      expect(hook.language).toBe('node');
    });

    it('has an entry that invokes the rigscore executable', () => {
      expect(typeof hook.entry).toBe('string');
      expect(hook.entry).toMatch(/rigscore/);
    });

    it('does not pass filenames — rigscore scans the whole directory', () => {
      expect(hook.pass_filenames).toBe(false);
    });

    it('carries a human-readable name and description', () => {
      expect(typeof hook.name).toBe('string');
      expect(hook.name.length).toBeGreaterThan(0);
      expect(typeof hook.description).toBe('string');
      expect(hook.description.length).toBeGreaterThan(0);
    });
  });
});
