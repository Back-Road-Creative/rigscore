/** config-merge engine: idempotent, non-destructive JSON/YAML deep-merge (keystone). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig, writeMerged, summarizeMerge } from '../src/lib/config-merge.js';

const tmpFile = (name, body) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-merge-')), name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
};

describe('mergeConfig — JSON', () => {
  it('adds an absent deeply-nested key without touching siblings', () => {
    const existing = '{\n  "permissions": {\n    "allow": ["Bash(git status:*)"]\n  }\n}\n';
    const r = mergeConfig(existing, { permissions: { deny: ['Bash(rm -rf:*)'] } }, { format: 'json' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.additions.map((a) => a.path)).toContain('permissions.deny');
    const obj = JSON.parse(r.text);
    expect(obj.permissions.allow).toEqual(['Bash(git status:*)']); // sibling preserved
    expect(obj.permissions.deny).toEqual(['Bash(rm -rf:*)']);
  });
  it('never overwrites an existing key with a different value — records a conflict', () => {
    const existing = '{\n  "permissions": {\n    "defaultMode": "acceptEdits"\n  }\n}\n';
    const r = mergeConfig(existing, { permissions: { defaultMode: 'plan' } }, { format: 'json' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false); // nothing added — user's value stands
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ path: 'permissions.defaultMode', existing: 'acceptEdits', incoming: 'plan' });
    expect(JSON.parse(r.text).permissions.defaultMode).toBe('acceptEdits');
  });
  it('is idempotent — merging the same hardening twice yields no change', () => {
    const existing = '{\n  "permissions": {\n    "allow": ["Bash(git status:*)"]\n  }\n}\n';
    const h = { permissions: { deny: ['Bash(rm -rf:*)'] } };
    const first = mergeConfig(existing, h, { format: 'json' });
    const second = mergeConfig(first.text, h, { format: 'json' });
    expect(second.changed).toBe(false);
    expect(second.additions).toHaveLength(0);
    expect(second.text).toBe(first.text);
  });
  it('unions scalar arrays by value, never dropping user entries', () => {
    const r = mergeConfig('{\n  "list": ["a", "b"]\n}\n', { list: ['b', 'c'] }, { format: 'json' });
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text).list).toEqual(['a', 'b', 'c']);
    expect(mergeConfig(r.text, { list: ['b', 'c'] }, { format: 'json' }).changed).toBe(false); // idempotent
  });
  it('emits stable 2-space indent with a trailing newline', () => {
    const r = mergeConfig('', { a: 1 }, { format: 'json' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('{\n  "a": 1\n}\n');
  });
});

describe('mergeConfig — YAML round-trip', () => {
  it('preserves comments and key order while adding a key', () => {
    const existing = '# top comment\npermissions:\n  allow:\n    - Bash(git status:*) # keep me\n';
    const r = mergeConfig(existing, { permissions: { deny: ['Bash(rm -rf:*)'] } }, { format: 'yaml' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('# top comment');
    expect(r.text).toContain('# keep me');
    expect(r.text).toContain('deny:');
    expect(r.text).toContain('Bash(rm -rf:*)');
    expect(r.text.indexOf('allow:')).toBeLessThan(r.text.indexOf('deny:')); // order kept
  });
});

describe('mergeConfig — robust input handling', () => {
  it('returns an explicit failure (no throw) on malformed text', () => {
    const r = mergeConfig('{ not json', { a: 1 }, { format: 'json' });
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.text).toBeNull();
    expect(r.error).toBeTruthy();
  });
  it('treats an empty file as an empty config and adds everything', () => {
    const r = mergeConfig('   ', { a: 1 }, { format: 'json' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });
  it('rejects a non-object top-level parse explicitly', () => {
    const r = mergeConfig('[1, 2, 3]', { a: 1 }, { format: 'json' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('defers TOML — explicit failure, no fake merge', () => {
    const r = mergeConfig('x = 1', { a: 1 }, { format: 'toml' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/toml/i);
  });
});

describe('dry-run vs write', () => {
  it('mergeConfig is pure — writeMerged is the only thing that touches disk', () => {
    const p = tmpFile('.claude-settings.json', '{\n  "permissions": {}\n}\n');
    const before = fs.readFileSync(p, 'utf8');
    const preview = mergeConfig(before, { permissions: { deny: ['Bash(rm -rf:*)'] } }, { format: 'json' });
    expect(preview.changed).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe(before); // dry-run wrote nothing
    const w = writeMerged(p, { permissions: { deny: ['Bash(rm -rf:*)'] } }, { format: 'json' });
    expect(w.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).permissions.deny).toEqual(['Bash(rm -rf:*)']);
  });
  it('summarizeMerge renders a human-readable summary of additions and conflicts', () => {
    const s = summarizeMerge(mergeConfig('{\n  "mode": "a"\n}\n', { mode: 'b', added: 1 }, { format: 'json' }));
    expect(s).toContain('added');
    expect(s).toMatch(/conflict/i);
    expect(s).toContain('mode');
  });
});
