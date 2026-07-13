/**
 * `--fix` offers pack installs as a second remediation source.
 *
 * A RED finding (critical/warning) on check <id> makes every pack whose
 * pack.json `checks` array names <id> an available remediation. The fixer's
 * standing contract still holds: dry-run writes nothing, and an install never
 * clobbers an existing governance file (installPack is called without `force`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findApplicablePacks, installPacks } from '../src/fixer.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-fixpacks-'));
const red = (id, severity = 'critical') => [{ id, findings: [{ severity, title: `${id} is red` }] }];

/** Drop a pack into a templates/ dir — same shape as templates/<name>/pack.json. */
function dropPack(templates, name, manifest, files = { 'AGENTS.md': '# {{PROJECT_NAME}}\n' }) {
  const dir = path.join(templates, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
}

const DEMO = {
  name: 'demo',
  description: 'demo pack',
  checks: ['claude-md'],
  files: [{ src: 'AGENTS.md', dest: 'AGENTS.md' }],
};

describe('findApplicablePacks', () => {
  it('offers a pack whose checks name a red finding\'s check id', () => {
    const templates = tmp();
    dropPack(templates, 'demo', DEMO);
    const packs = findApplicablePacks(red('claude-md'), templates);
    expect(packs.map((p) => p.name)).toEqual(['demo']);
    expect(packs[0].targets).toEqual(['claude-md']);
    expect(packs[0].description).toBe('demo pack');
  });

  it('offers a real shipped pack for a real red check id', () => {
    // Default templatesDir — templates/docs claims the claude-md check.
    const packs = findApplicablePacks(red('claude-md'));
    expect(packs.some((p) => p.name === 'docs')).toBe(true);
  });

  it('offers nothing for a check no pack claims', () => {
    const templates = tmp();
    dropPack(templates, 'demo', DEMO);
    expect(findApplicablePacks(red('deep-secrets'), templates)).toEqual([]);
  });

  it('ignores info/pass findings — only critical and warning are red', () => {
    const templates = tmp();
    dropPack(templates, 'demo', DEMO);
    expect(findApplicablePacks(red('claude-md', 'info'), templates)).toEqual([]);
    expect(findApplicablePacks(red('claude-md', 'pass'), templates)).toEqual([]);
    expect(findApplicablePacks(red('claude-md', 'warning'), templates).length).toBe(1);
  });

  it('is inert (writes nothing) — the dry run is just this call', () => {
    const templates = tmp();
    const cwd = tmp();
    dropPack(templates, 'demo', DEMO);
    const packs = findApplicablePacks(red('claude-md'), templates);
    expect(packs.length).toBe(1);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});

describe('installPacks', () => {
  it('installs the pack files under --yes', () => {
    const templates = tmp();
    const cwd = tmp();
    dropPack(templates, 'demo', DEMO);
    const packs = findApplicablePacks(red('claude-md'), templates);
    const { installed, skipped } = installPacks(packs, cwd, templates);
    expect(skipped).toEqual([]);
    expect(installed.length).toBe(1);
    expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8')).toBe(`# ${path.basename(cwd)}\n`);
  });

  it('never clobbers an existing file — governance content is left byte-for-byte', () => {
    const templates = tmp();
    const cwd = tmp();
    dropPack(templates, 'demo', DEMO);
    const mine = '# my hand-written contract\n';
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), mine);
    const packs = findApplicablePacks(red('claude-md'), templates);
    const { installed } = installPacks(packs, cwd, templates);
    expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8')).toBe(mine);
    expect(installed.join('\n')).toContain('skipped (exists)');
  });

  it('a malformed pack is reported, not thrown', () => {
    const templates = tmp();
    const cwd = tmp();
    dropPack(templates, 'demo', DEMO);
    // Corrupt the manifest AFTER discovery would have accepted it.
    fs.writeFileSync(path.join(templates, 'demo', 'pack.json'), '{ not json');
    const { installed, skipped } = installPacks([{ name: 'demo' }], cwd, templates);
    expect(installed).toEqual([]);
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain('demo');
  });
});
