import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates the `guards` pack as pure data. It deliberately does NOT import the
// init pack framework (src/cli/packs.js) — the pack is inert data that the
// framework auto-discovers, and it must be verifiable on its own terms.
const PACK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'guards');
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf-8'));
const read = (f) => fs.readFileSync(path.join(PACK_DIR, f), 'utf-8');

describe('guards pack manifest', () => {
  it('has the required top-level keys', () => {
    for (const key of ['name', 'description', 'checks', 'files', 'vars']) {
      expect(manifest, `missing key: ${key}`).toHaveProperty(key);
    }
    expect(manifest.name).toBe('guards');
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('claims only checks it actually turns green', () => {
    // permissions-hygiene scores 100 on a bare repo already (it reads filesystem
    // modes, not settings.json), so this pack cannot improve it and must not claim it.
    expect(manifest.checks).toEqual(['claude-settings', 'git-hooks']);
  });

  it('ships every file it declares, to a safe relative dest', () => {
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const { src, dest } of manifest.files) {
      expect(fs.existsSync(path.join(PACK_DIR, src)), `missing src: ${src}`).toBe(true);
      expect(path.isAbsolute(dest), `dest must be relative: ${dest}`).toBe(false);
      expect(dest.includes('..'), `dest must not escape the repo: ${dest}`).toBe(false);
    }
  });
});

describe('guards pack templates', () => {
  it('settings.json denies destructive shell, credential reads, and network exfil', () => {
    const settings = JSON.parse(read('settings.json'));
    const deny = settings.permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(['Bash(rm -rf:*)', 'Bash(sudo:*)']));
    expect(deny.some((d) => d.startsWith('Read(./.env'))).toBe(true);
    expect(deny).toEqual(expect.arrayContaining(['Read(~/.ssh/**)', 'Bash(curl:*)', 'WebFetch']));
  });

  it('settings.json does not itself trip claude-settings', () => {
    const settings = JSON.parse(read('settings.json'));
    // A wildcard allow, or an allow entry granting sudo/docker-run/pip-install,
    // is a finding in src/checks/claude-settings.js — never ship one.
    const allow = settings.permissions.allow ?? [];
    expect(allow).not.toContain('*');
    for (const entry of allow) {
      expect(entry).not.toMatch(/sudo|docker\s+run|pip[23]?\s+install/i);
    }
    expect(settings.enableAllProjectMcpServers).toBeUndefined();
    expect(settings.permissions.defaultMode).not.toBe('bypassPermissions');
  });

  it('permissions.json expires loudly and records an audit trail', () => {
    const perms = JSON.parse(read('permissions.json'));
    expect(perms.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(perms.expires))).toBe(false);
    expect(perms.renewal.cadenceDays).toBeGreaterThan(0);
    expect(perms.enforcement.gate).toMatch(/exits? non-zero|fail/i);
    expect(perms.changelog.length).toBeGreaterThan(0);
    expect(perms.grants.length).toBeGreaterThan(0);
  });

  it('pre-commit really invokes a scanner and can block a commit', () => {
    const hook = read('pre-commit');
    expect(hook.startsWith('#!')).toBe(true);
    // Not a keyword-stuffed stub: the scanner names must appear as real invocations
    // guarded by `command -v`, not as words in a comment.
    expect(hook).toMatch(/command -v gitleaks/);
    expect(hook).toMatch(/gitleaks protect --staged/);
    // A dependency-free backstop must run even with no scanner installed, and must
    // be able to fail the commit.
    expect(hook).toMatch(/AKIA/);
    expect(hook).toMatch(/PRIVATE KEY/);
    expect(hook).toMatch(/exit \$fail/);
  });
});
