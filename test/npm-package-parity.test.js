import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * npm-package parity — does the tarball we publish actually contain the files
 * the shipped code reads at runtime?
 *
 * This exists because `package.json` `files` omitted `docs/`, while
 * `src/cli/explain.js` resolves `<pkgRoot>/docs/checks/<id>.md`. Every test for
 * `explain` spawns `bin/rigscore.js` from the *working tree*, where `docs/`
 * exists — so the suite was structurally blind to packaging and `rigscore
 * explain` was broken for every check in every installed copy (`npx rigscore`,
 * a global install, a dependency) while CI stayed green.
 *
 * The fix for that one bug is a single line in `files`. This test is the part
 * that makes the *class* of bug non-reintroducible: it asks npm itself what
 * would ship (`npm pack --dry-run --json` — no publish, no network) and asserts
 * the packed file list covers each runtime-read directory.
 *
 * The docs requirement is DERIVED, not hardcoded: for every check module in
 * `src/checks/`, the matching `docs/checks/<id>.md` must be packed. So a 28th
 * check inherits the guarantee automatically, and dropping `docs/` from `files`
 * fails 27+ assertions instead of silently shipping a dead subcommand.
 */

/** Ask npm exactly what it would publish. Dry-run: nothing is uploaded. */
function packedFilePaths() {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.status !== 0) {
    throw new Error(`npm pack --dry-run failed (status ${res.status}):\n${res.stderr}`);
  }

  // npm may interleave notices with the JSON payload; slice from the first `[`.
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`npm pack produced no JSON:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.slice(start));

  // Shape: [ { name, version, files: [ { path, size, mode }, ... ] } ]
  return parsed[0].files.map((f) => f.path);
}

/** The check ids the package actually implements — the 27-checks invariant. */
function checkIds() {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'src', 'checks'))
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

describe('npm package parity — the tarball contains what the shipped code reads', () => {
  let packed;
  let ids;

  beforeAll(() => {
    packed = packedFilePaths();
    ids = checkIds();
  });

  it('packs at least one docs/checks/*.md page (src/cli/explain.js reads this dir)', () => {
    const docPages = packed.filter((p) => /^docs\/checks\/.+\.md$/.test(p));
    expect(
      docPages.length,
      'package.json "files" does not ship docs/checks/, so `rigscore explain` ' +
        'cannot resolve a doc page in any installed copy of the package.',
    ).toBeGreaterThan(0);
  });

  // Derived from src/checks/, not a hardcoded list: a new check is covered for free.
  it('packs a docs/checks/<id>.md for every check module in src/checks/', () => {
    const missing = ids.filter((id) => !packed.includes(`docs/checks/${id}.md`));
    expect(
      missing,
      `These checks would ship with no explain doc: ${missing.join(', ')}. ` +
        'Add the missing docs/checks/<id>.md, or ensure package.json "files" ships docs/checks/.',
    ).toEqual([]);
  });

  it('packs templates/ (src/cli/packs.js reads this dir for `rigscore init`)', () => {
    const templates = packed.filter((p) => p.startsWith('templates/'));
    expect(templates.length, 'package.json "files" must ship templates/').toBeGreaterThan(0);
  });

  it('packs bin/ and src/ (the entry point and its modules)', () => {
    expect(packed).toContain('bin/rigscore.js');
    expect(packed.some((p) => p.startsWith('src/'))).toBe(true);
  });
});
