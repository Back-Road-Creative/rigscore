import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPack, formatInstallReport } from '../src/cli/packs.js';
import { runInitSubcommand } from '../src/cli/init.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-merge-'));
const pair = () => [tmp(), tmp()];
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf-8');
const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const BASE = { name: 'hard', description: 'hardening pack', checks: ['claude-settings'] };

/** Drop a pack whose single file maps `src` → `dest` with the given body. */
function dropPack(templates, files, dest = '.claude/settings.json', src = 'settings.json') {
  const dir = path.join(templates, 'hard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ ...BASE, files: [{ src, dest }] }));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
}

describe('installPack --merge (harden in place)', () => {
  it('ADDS the pack keys while PRESERVING the user\'s existing unrelated keys', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"permissions":{"deny":["Bash(rm -rf:*)"]},"$schema":"x"}' });
    write(target, '.claude/settings.json', '{"permissions":{"allow":["Read(./src/**)"]},"mine":42}');
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res.results[0].status).toBe('merged');
    const merged = JSON.parse(read(target, '.claude/settings.json'));
    expect(merged.mine).toBe(42); // user key untouched
    expect(merged.permissions.allow).toEqual(['Read(./src/**)']); // user subtree untouched
    expect(merged.permissions.deny).toEqual(['Bash(rm -rf:*)']); // pack key added
    expect(merged.$schema).toBe('x');
  });

  it('KEEPS a user value that conflicts with a pack key, reporting it as a conflict', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"permissions":{"defaultMode":"acceptEdits"}}' });
    write(target, '.claude/settings.json', '{"permissions":{"defaultMode":"plan"}}');
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(JSON.parse(read(target, '.claude/settings.json')).permissions.defaultMode).toBe('plan');
    expect(res.results[0].conflicts).toEqual([
      { path: 'permissions.defaultMode', existing: 'plan', incoming: 'acceptEdits' },
    ]);
    expect(formatInstallReport(res, target)).toMatch(/kept your existing permissions\.defaultMode/);
  });

  it('preserves comments and existing keys when merging a YAML dest', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'c.yaml': 'added: 1\n' }, 'config.yaml', 'c.yaml');
    write(target, 'config.yaml', '# keep me\nexisting: true\n');
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res.results[0].status).toBe('merged');
    const out = read(target, 'config.yaml');
    expect(out).toContain('# keep me');
    expect(out).toContain('existing: true');
    expect(out).toContain('added: 1');
  });

  it('is idempotent: a second merge reports "merged (no change)" and rewrites nothing', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"b":2}' });
    write(target, '.claude/settings.json', '{"a":1}');
    installPack('hard', target, { merge: true, templatesDir: templates });
    const after = read(target, '.claude/settings.json');
    const res2 = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res2.results[0].status).toBe('merged (no change)');
    expect(read(target, '.claude/settings.json')).toBe(after); // byte-for-byte
  });

  it('writes the file when --merge has no existing dest (same as a normal install)', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"b":2}' });
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res.results[0].status).toBe('written');
    expect(JSON.parse(read(target, '.claude/settings.json'))).toEqual({ b: 2 });
  });

  it('skips a non-mergeable dest (.sh) under --merge, leaving it byte-for-byte', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'run.sh': '#!/bin/sh\necho fresh\n' }, 'run.sh', 'run.sh');
    write(target, 'run.sh', '#!/bin/sh\necho mine\n');
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res.results[0].status).toBe('skipped');
    expect(read(target, 'run.sh')).toBe('#!/bin/sh\necho mine\n');
  });

  it('falls back to skip (never clobbers) when the existing dest is corrupt', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"b":2}' });
    write(target, '.claude/settings.json', '{ not valid json');
    const res = installPack('hard', target, { merge: true, templatesDir: templates });
    expect(res.results[0].status).toBe('skipped');
    expect(read(target, '.claude/settings.json')).toBe('{ not valid json');
  });

  it('merge wins over force (mutually exclusive): the user\'s value survives', () => {
    const [templates, target] = pair();
    dropPack(templates, { 'settings.json': '{"a":9}' });
    write(target, '.claude/settings.json', '{"a":1,"mine":true}');
    const res = installPack('hard', target, { merge: true, force: true, templatesDir: templates });
    const merged = JSON.parse(read(target, '.claude/settings.json'));
    expect(merged.a).toBe(1); // not clobbered to 9
    expect(merged.mine).toBe(true);
    expect(res.results[0].status).toBe('merged (no change)');
  });

  it('threads --merge (alias --harden) through the CLI into an existing config', async () => {
    // Real templates: guards installs a mergeable .claude/settings.json.
    const target = tmp();
    write(target, '.claude/settings.json', '{"permissions":{"allow":["Read(./mine/**)"]}}');
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => (chunks.push(s), true);
    try {
      await runInitSubcommand(['--guards', target, '--harden']);
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    expect(out).toContain('merged');
    const merged = JSON.parse(read(target, '.claude/settings.json'));
    expect(merged.permissions.allow).toContain('Read(./mine/**)'); // user grant preserved
    expect(merged.permissions.deny).toContain('Bash(rm -rf:*)'); // pack hardening added
  });
});
