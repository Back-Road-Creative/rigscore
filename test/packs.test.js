import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listPacks, loadPack, installPack, formatInstallReport } from '../src/cli/packs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-packs-'));
const pair = () => [tmp(), tmp()];
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf-8');
const OK = { name: 'demo', description: 'demo pack', checks: ['claude-md'], files: [{ src: 'AGENTS.md', dest: 'AGENTS.md' }] };

/** Drop a pack into a templates/ dir — the same shape a sibling PR adds. */
function dropPack(templates, name, manifest, files = { 'AGENTS.md': '# {{PROJECT_NAME}}\n' }) {
  const dir = path.join(templates, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
}

describe('packs', () => {
  it('auto-discovers a pack dropped into templates/, with no code change', () => {
    const dir = tmp();
    expect(listPacks(dir)).toEqual([]);
    dropPack(dir, 'demo', OK);
    dropPack(dir, 'other', { ...OK, name: 'other' });
    fs.mkdirSync(path.join(dir, 'not-a-pack')); // no pack.json → not a pack
    expect(listPacks(dir)).toEqual(['demo', 'other']);
  });

  const bad = {
    'name mismatch': { ...OK, name: 'wrong' },
    'missing description': { ...OK, description: '' },
    'checks not an array': { ...OK, checks: 'claude-md' },
    'exec not a boolean': { ...OK, files: [{ src: 'AGENTS.md', dest: 'AGENTS.md', exec: 'yes' }] },
    'defaults not an object': { ...OK, defaults: 'x' },
    'defaults value not a string': { ...OK, defaults: { EGRESS_SUBNET: 5 } },
  };
  for (const [label, manifest] of Object.entries(bad)) {
    it(`rejects a malformed pack: ${label}`, () => {
      const dir = tmp();
      dropPack(dir, 'demo', manifest);
      expect(() => loadPack('demo', dir)).toThrow(/pack "demo"/);
    });
  }

  it('refuses a missing src, and a dest that escapes the target dir, writing nothing', () => {
    const dir = tmp();
    dropPack(dir, 'nosrc', { ...OK, name: 'nosrc' }, {});
    expect(() => loadPack('nosrc', dir)).toThrow(/src not found/);
    dropPack(dir, 'esc', { ...OK, name: 'esc', files: [{ src: 'AGENTS.md', dest: '../escaped.md' }] });
    expect(() => loadPack('esc', dir)).toThrow(/escapes the target directory/);
    expect(fs.existsSync(path.join(dir, 'escaped.md'))).toBe(false);
  });

  it('seeds vars from pack.defaults, resolving declared placeholders at install', () => {
    const [templates, target] = pair();
    dropPack(templates, 'demo',
      { ...OK, vars: { PROJECT_NAME: 'dir name', SUBNET: 'the egress subnet' }, defaults: { SUBNET: '172.30.0.0/16' } },
      { 'AGENTS.md': 'net={{SUBNET}} name={{PROJECT_NAME}}\n' });
    const res = installPack('demo', target, { templatesDir: templates });
    expect(read(target, 'AGENTS.md')).toBe(`net=172.30.0.0/16 name=${path.basename(target)}\n`);
    expect(res.unresolved).toEqual([]);
    expect(res.appliedDefaults).toEqual([{ key: 'SUBNET', value: '172.30.0.0/16' }]);
    // Reports the applied default (operator must review it) but does NOT warn it is unresolved.
    const report = formatInstallReport(res, target);
    expect(report).toMatch(/applied default \{\{SUBNET\}\} = 172\.30\.0\.0\/16/);
    expect(report).not.toMatch(/no value for \{\{SUBNET\}\}/);
  });

  it('still warns for a placeholder that has neither a default nor a runtime value', () => {
    const [templates, target] = pair();
    dropPack(templates, 'demo',
      { ...OK, vars: { PROJECT_NAME: 'dir name', TOKEN: 'a required secret' }, defaults: {} },
      { 'AGENTS.md': 'secret={{TOKEN}}\n' });
    const res = installPack('demo', target, { templatesDir: templates });
    expect(res.unresolved).toEqual(['TOKEN']);
    expect(res.appliedDefaults).toEqual([]);
    expect(read(target, 'AGENTS.md')).toBe('secret={{TOKEN}}\n'); // never written out blank
    expect(formatInstallReport(res, target)).toMatch(/no value for \{\{TOKEN\}\}/);
  });

  it('installs the container pack as a working fail-closed baseline (no inert egress placeholders)', () => {
    const target = tmp(); // real TEMPLATES_DIR — the shipped container pack
    const res = installPack('container', target);
    const tinyproxy = read(target, '.devcontainer/egress/tinyproxy.conf');
    const compose = read(target, '.devcontainer/egress/docker-compose.proxy.yml');
    const allowlist = read(target, '.devcontainer/egress/allowlist');
    // EGRESS_SUBNET resolves to the private range in both the ACL and the compose subnet.
    expect(tinyproxy).toContain('Allow 172.30.0.0/16');
    expect(tinyproxy).not.toContain('{{EGRESS_SUBNET}}');
    expect(compose).toContain('172.30.0.0/16');
    expect(compose).not.toContain('{{EGRESS_SUBNET}}');
    // ALLOWED_HOSTS resolves to a deny-all default: the substituted line is an inert comment,
    // so the installed allow-list adds NO extra reachable host until the operator edits it.
    expect(allowlist).not.toContain('{{ALLOWED_HOSTS}}');
    const substituted = allowlist.split('\n').at(-2); // last content line was {{ALLOWED_HOSTS}}
    expect(substituted.trim().startsWith('#')).toBe(true);
    // Neither ships unresolved, and the report no longer warns about them.
    expect(res.unresolved).not.toContain('EGRESS_SUBNET');
    expect(res.unresolved).not.toContain('ALLOWED_HOSTS');
    expect(res.appliedDefaults.map((d) => d.key)).toEqual(
      expect.arrayContaining(['EGRESS_SUBNET', 'ALLOWED_HOSTS']));
    expect(formatInstallReport(res, target))
      .not.toMatch(/no value for \{\{(EGRESS_SUBNET|ALLOWED_HOSTS)\}\}/);
  });

  it('installs the declared files, substituting vars', () => {
    const [templates, target] = pair();
    dropPack(templates, 'demo', OK);
    const res = installPack('demo', target, { templatesDir: templates });
    expect(res.results).toEqual([{ dest: 'AGENTS.md', status: 'written' }]);
    expect(res.pack.checks).toEqual(['claude-md']);
    expect(read(target, 'AGENTS.md')).toBe(`# ${path.basename(target)}\n`);
  });

  it('never clobbers an existing file without --force', () => {
    const [templates, target] = pair();
    dropPack(templates, 'demo', OK, { 'AGENTS.md': '# fresh\n' });
    fs.writeFileSync(path.join(target, 'AGENTS.md'), '# mine\n');
    const res = installPack('demo', target, { templatesDir: templates });
    expect(res.results).toEqual([{ dest: 'AGENTS.md', status: 'skipped' }]);
    expect(read(target, 'AGENTS.md')).toBe('# mine\n');
    const forced = installPack('demo', target, { force: true, templatesDir: templates });
    expect(forced.results).toEqual([{ dest: 'AGENTS.md', status: 'written' }]);
    expect(read(target, 'AGENTS.md')).toBe('# fresh\n');
  });
  // A hook without +x is inert, yet a presence-based check still scores it green.
  it('sets the exec bit on hook dests and on exec:true entries', () => {
    const [templates, target] = pair();
    const f = (dest, exec) => ({ src: 'AGENTS.md', dest, ...(exec ? { exec } : {}) });
    dropPack(templates, 'demo', { ...OK, files: [f('.git/hooks/pre-commit'), f('run.sh', true), f('AGENTS.md')] });
    installPack('demo', target, { templatesDir: templates });
    expect(fs.statSync(path.join(target, '.git/hooks/pre-commit')).mode & 0o111).toBeTruthy();
    expect(fs.statSync(path.join(target, 'run.sh')).mode & 0o111).toBeTruthy();
    expect(fs.statSync(path.join(target, 'AGENTS.md')).mode & 0o111).toBeFalsy();
  });

  // core.hooksPath elsewhere → git ignores .git/hooks silently: installed, green, inert.
  it('warns when core.hooksPath makes an installed hook unreachable', () => {
    const [templates, target] = pair();
    execFileSync('git', ['init', '-q'], { cwd: target });
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: target });
    dropPack(templates, 'demo', { ...OK, files: [{ src: 'AGENTS.md', dest: '.git/hooks/pre-commit' }] });
    const res = installPack('demo', target, { templatesDir: templates });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/core\.hooksPath is "\.githooks"/);
    expect(res.warnings[0]).toMatch(/NEVER run/);
  });
});
