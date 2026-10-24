import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPack } from '../src/cli/packs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-symlink-'));
const BASE = { name: 'sym', description: 'symlink pack', checks: ['claude-settings'] };

/** Drop a pack with the given files: [{ src, dest, body }]. */
function dropPack(templates, files) {
  const dir = path.join(templates, 'sym');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    ...BASE, files: files.map(({ src, dest }) => ({ src, dest })),
  }));
  for (const f of files) fs.writeFileSync(path.join(dir, f.src), f.body);
}

// Creating symlinks on Windows needs privileges the CI runner may not have.
describe.skipIf(process.platform === 'win32')('installPack refuses symlinked destinations', () => {
  it('refuses a dangling symlink dest and creates nothing at its target', () => {
    const templates = tmp(); const repo = tmp(); const outside = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'CLAUDE.md', body: 'x' }]);
    const victim = path.join(outside, 'x');
    fs.symlinkSync(victim, path.join(repo, 'CLAUDE.md'));
    expect(() => installPack('sym', repo, { templatesDir: templates })).toThrow(/symlink.*CLAUDE\.md/);
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('refuses a dangling symlink dest even with force', () => {
    const templates = tmp(); const repo = tmp(); const outside = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'CLAUDE.md', body: 'x' }]);
    const victim = path.join(outside, 'x');
    fs.symlinkSync(victim, path.join(repo, 'CLAUDE.md'));
    expect(() => installPack('sym', repo, { force: true, templatesDir: templates })).toThrow(/symlink/);
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('refuses a symlinked parent directory that resolves outside the repo', () => {
    const templates = tmp(); const repo = tmp(); const outside = tmp();
    dropPack(templates, [{ src: 'e.sh', dest: '.devcontainer/egress/e.sh', body: '#!/bin/sh\n' }]);
    fs.symlinkSync(outside, path.join(repo, '.devcontainer'));
    expect(() => installPack('sym', repo, { templatesDir: templates })).toThrow(/outside.*\.devcontainer\/egress\/e\.sh/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('merge mode refuses an existing symlink dest and leaves the outside file untouched', () => {
    const templates = tmp(); const repo = tmp(); const outside = tmp();
    dropPack(templates, [{ src: 's.json', dest: '.claude/settings.json', body: '{"permissions":{"deny":["x"]}}' }]);
    const target = path.join(outside, 's.json');
    const original = '{"mine":1}';
    fs.writeFileSync(target, original);
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.symlinkSync(target, path.join(repo, '.claude', 'settings.json'));
    expect(() => installPack('sym', repo, { merge: true, templatesDir: templates })).toThrow(/symlink/);
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
  });

  it('writes nothing at all when any later dest is a symlink (checked before the first write)', () => {
    const templates = tmp(); const repo = tmp(); const outside = tmp();
    dropPack(templates, [
      { src: 'a.md', dest: 'AGENTS.md', body: 'a' },
      { src: 'c.md', dest: 'CLAUDE.md', body: 'c' },
    ]);
    fs.symlinkSync(path.join(outside, 'x'), path.join(repo, 'CLAUDE.md'));
    expect(() => installPack('sym', repo, { templatesDir: templates })).toThrow(/symlink/);
    expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
  });

  it('still installs normally when the target repo path itself is reached through a symlink', () => {
    const templates = tmp(); const real = tmp(); const holder = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'sub/CLAUDE.md', body: 'x' }]);
    const link = path.join(holder, 'repo-link');
    fs.symlinkSync(real, link);
    const res = installPack('sym', link, { templatesDir: templates });
    expect(res.results[0].status).toBe('written');
    expect(fs.readFileSync(path.join(real, 'sub', 'CLAUDE.md'), 'utf-8')).toBe('x');
  });

  it('allows a symlinked parent that stays inside the repo', () => {
    const templates = tmp(); const repo = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'link/CLAUDE.md', body: 'x' }]);
    fs.mkdirSync(path.join(repo, 'real'));
    fs.symlinkSync(path.join(repo, 'real'), path.join(repo, 'link'));
    const res = installPack('sym', repo, { templatesDir: templates });
    expect(res.results[0].status).toBe('written');
    expect(fs.readFileSync(path.join(repo, 'real', 'CLAUDE.md'), 'utf-8')).toBe('x');
  });

  it('installs into a target directory that does not exist yet', () => {
    const templates = tmp(); const base = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'CLAUDE.md', body: 'x' }]);
    const repo = path.join(base, 'new', 'sub');
    const res = installPack('sym', repo, { templatesDir: templates });
    expect(res.results[0].status).toBe('written');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toBe('x');
  });

  it('installs into a missing target nested under a symlinked ancestor', () => {
    const templates = tmp(); const real = tmp(); const holder = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'CLAUDE.md', body: 'x' }]);
    const link = path.join(holder, 'link');
    fs.symlinkSync(real, link);
    const res = installPack('sym', path.join(link, 'new'), { templatesDir: templates });
    expect(res.results[0].status).toBe('written');
    expect(fs.readFileSync(path.join(real, 'new', 'CLAUDE.md'), 'utf-8')).toBe('x');
  });

  it('refuses a dest symlink even when it points inside the repo (deliberate: never write through a link)', () => {
    const templates = tmp(); const repo = tmp();
    dropPack(templates, [{ src: 'c.md', dest: 'CLAUDE.md', body: 'x' }]);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'orig');
    fs.symlinkSync(path.join(repo, 'AGENTS.md'), path.join(repo, 'CLAUDE.md'));
    expect(() => installPack('sym', repo, { force: true, templatesDir: templates })).toThrow(/symlink.*CLAUDE\.md/);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe('orig');
  });
});
