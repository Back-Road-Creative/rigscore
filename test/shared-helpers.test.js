import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCheckIgnore, toRegex } from '../src/utils.js';
import { TAG_CHARS_RE } from '../src/lib/unicode.js';
import skillFiles from '../src/checks/skill-files.js';
import unicodeSteg from '../src/checks/unicode-steganography.js';

const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-helpers-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    try { fs.rmSync(tmpdirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('gitCheckIgnore (shared helper)', () => {
  it("returns 'ignored' for a path matched by .gitignore", async () => {
    const cwd = tmp();
    execFileSync('git', ['init', '--quiet'], { cwd });
    fs.writeFileSync(path.join(cwd, '.gitignore'), '/CLAUDE.md\n');
    expect(await gitCheckIgnore(cwd, 'CLAUDE.md')).toBe('ignored');
  });

  it("returns 'not-ignored' for a path no rule matches", async () => {
    const cwd = tmp();
    execFileSync('git', ['init', '--quiet'], { cwd });
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'other.md\n');
    expect(await gitCheckIgnore(cwd, 'CLAUDE.md')).toBe('not-ignored');
  });

  it("returns 'unknown' outside a git work tree", async () => {
    const cwd = tmp();
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(cwd);
    try {
      expect(await gitCheckIgnore(cwd, 'CLAUDE.md')).toBe('unknown');
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });
});

describe('toRegex (shared helper)', () => {
  it('returns null for empty or unusable specs', () => {
    expect(toRegex(undefined)).toBeNull();
    expect(toRegex('')).toBeNull();
    expect(toRegex('(unclosed')).toBeNull();
    expect(toRegex({ source: '(unclosed' })).toBeNull();
    expect(toRegex(42)).toBeNull();
  });

  it('passes a RegExp through unchanged', () => {
    const re = /abc/g;
    expect(toRegex(re)).toBe(re);
  });

  it('compiles a string case-insensitively', () => {
    const re = toRegex('foo');
    expect(re.flags).toBe('i');
    expect(re.test('FOO')).toBe(true);
  });

  it('compiles {source, flags} and defaults flags to i', () => {
    expect(toRegex({ source: 'foo', flags: 'm' }).flags).toBe('m');
    expect(toRegex({ source: 'foo' }).flags).toBe('i');
  });
});

describe('TAG_CHARS_RE (shared Unicode tag-char pattern)', () => {
  it('matches the whole Tags block', () => {
    for (const cp of [0xE0000, 0xE0001, 0xE0002, 0xE001F, 0xE0020, 0xE0041, 0xE007F]) {
      expect(TAG_CHARS_RE.test(String.fromCodePoint(cp))).toBe(true);
    }
  });

  it('does not match neighbours outside the block or plain text', () => {
    expect(TAG_CHARS_RE.test(String.fromCodePoint(0xDFFFF))).toBe(false);
    expect(TAG_CHARS_RE.test(String.fromCodePoint(0xE0080))).toBe(false);
    expect(TAG_CHARS_RE.test('plain ascii')).toBe(false);
  });

  it.each([0xE0000, 0xE0001, 0xE0002, 0xE001F, 0xE0041].map((cp) => [cp.toString(16).toUpperCase(), cp]))(
    'skill-files and unicode-steganography both flag U+%s',
    async (_hex, cp) => {
      const sample = `Hello${String.fromCodePoint(cp)}world\n`;

      const skillCwd = tmp();
      const skillPath = path.join(skillCwd, '.claude', 'skills', 'k', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, `# Skill\n${sample}`);
      const sf = await skillFiles.run({ cwd: skillCwd, homedir: skillCwd, config: {} });
      expect(sf.findings.some((f) => f.findingId === 'skill-files/tag-chars')).toBe(true);

      const stegCwd = tmp();
      fs.writeFileSync(path.join(stegCwd, 'CLAUDE.md'), sample);
      const us = await unicodeSteg.run({ cwd: stegCwd });
      expect(us.findings.some((f) => f.findingId === 'unicode-steganography/tag-chars')).toBe(true);
    },
  );
});
