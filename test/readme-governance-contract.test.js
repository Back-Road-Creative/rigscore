/**
 * This repo's own README states who owns it and when it should be archived.
 *
 * WHY IT LIVES HERE, not in the workspace that consumes this repo as a
 * submodule. The Back Road Creative workspace runs a governance suite that
 * requires Purpose / Owner / Status / Exit Condition in every project README.
 * It cannot enforce that here: no workflow passes `submodules:` to
 * actions/checkout, so in that repo's CI this directory is empty and the check
 * is skipped. The gap went unnoticed for a month — an exemption for this repo
 * expired 2026-06-30 and nothing said so until an unrelated change made the
 * scanners honest.
 *
 * The alternative was giving that repo's CI a cross-repo credential so it could
 * clone this one. A README is a property of THIS project, so the check belongs
 * in THIS repo's test suite, where a violation cannot merge at all rather than
 * being noticed later somewhere else. That is worth four duplicated strings.
 *
 * Deliberately not a rigscore check: rigscore's checks run against a user's
 * repo, and this contract is Back Road Creative's, not every user's.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README = path.join(__dirname, '..', 'README.md');

const REQUIRED_SECTIONS = ['Purpose', 'Owner', 'Status', 'Exit Condition'];

/** Heading text at `#` or `##`, matching the workspace suite's own parser. */
function headings(markdown) {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.match(/^#{1,2}\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].trim().toLowerCase());
}

describe('README governance contract', () => {
  it('README.md exists and is not a stub', () => {
    expect(fs.existsSync(README)).toBe(true);
    expect(fs.readFileSync(README, 'utf-8').trim().length).toBeGreaterThan(50);
  });

  it.each(REQUIRED_SECTIONS)('states its %s', (section) => {
    const found = headings(fs.readFileSync(README, 'utf-8'));
    expect(found).toContain(section.toLowerCase());
  });

  it('each required section has a body, not just a heading', () => {
    const lines = fs.readFileSync(README, 'utf-8').replace(/\r\n/g, '\n').split('\n');
    const empty = [];

    for (const section of REQUIRED_SECTIONS) {
      const start = lines.findIndex((l) => {
        const m = l.match(/^#{1,2}\s+(.+)$/);
        return m && m[1].trim().toLowerCase() === section.toLowerCase();
      });
      if (start === -1) continue; // absence is the previous test's job

      // Everything up to the next heading of any level.
      const body = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^#{1,6}\s+/.test(lines[i])) break;
        body.push(lines[i]);
      }
      if (body.join('').trim() === '') empty.push(section);
    }

    expect(empty).toEqual([]);
  });
});
