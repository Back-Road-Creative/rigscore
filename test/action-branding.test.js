import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as YAML from 'yaml';

// Resolve action.yml + README relative to this test file (repo root).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const action = YAML.parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

// GitHub Marketplace branding rules (Metadata syntax for GitHub Actions).
// Colors are a fixed set; icons are Feather icons MINUS this documented
// omitted list. Encoding the exclusion set is how GitHub itself validates,
// so the allowed set == "a Feather-style name not in OMITTED_ICONS".
const ALLOWED_COLORS = ['white', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'];
const OMITTED_ICONS = new Set([
  'coffee', 'columns', 'divide-circle', 'divide-square', 'divide',
  'frown', 'hexagon', 'key', 'meh', 'mouse-pointer', 'smile', 'tool', 'x-octagon',
]);

describe('action.yml — GitHub Marketplace branding', () => {
  it('declares a top-level branding block', () => {
    expect(action.branding, 'action.yml must have a top-level `branding:` block to be Marketplace-listable').toBeDefined();
    expect(typeof action.branding).toBe('object');
  });

  it('branding.icon is a non-empty string in GitHub\'s allowed Feather set', () => {
    const icon = action.branding?.icon;
    expect(typeof icon, 'branding.icon must be a string').toBe('string');
    expect(icon.trim().length, 'branding.icon must be non-empty').toBeGreaterThan(0);
    // Feather-style name (lowercase, hyphen-separated) that GitHub renders.
    expect(icon).toMatch(/^[a-z][a-z-]*[a-z]$/);
    expect(
      OMITTED_ICONS.has(icon),
      `branding.icon "${icon}" is in GitHub's documented unsupported-icon list`,
    ).toBe(false);
  });

  it('branding.color is one of the eight allowed color words', () => {
    expect(ALLOWED_COLORS).toContain(action.branding?.color);
  });
});

describe('README — Marketplace-adoptable workflow example', () => {
  it('shows a copy-paste `uses: Back-Road-Creative/rigscore@v<X.Y.Z>` job', () => {
    expect(readme).toMatch(/uses:\s*Back-Road-Creative\/rigscore@v\d+\.\d+\.\d+/);
  });

  it('the example wires upload-sarif and a fail-under', () => {
    // Bound the slice to the Distribution section only (up to the next `## `
    // heading) so a match elsewhere in the README can't pass this spuriously.
    const start = readme.indexOf('## Distribution');
    const after = readme.indexOf('\n## ', start + 1);
    const dist = readme.slice(start, after === -1 ? undefined : after);
    expect(dist).toMatch(/upload-sarif:\s*true/);
    expect(dist).toMatch(/fail-under:/);
  });
});
