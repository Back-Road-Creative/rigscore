#!/usr/bin/env node
/**
 * Assemble CHANGELOG.md from one-file-per-change fragments in changelog.d/.
 *
 * Contributors add changelog.d/<id>.<type>.md and never touch CHANGELOG.md, so two
 * PRs in flight cannot conflict on the same lines. Folded into the log at release.
 *
 *   node scripts/assemble-changelog.js            # preview the Unreleased section
 *   node scripts/assemble-changelog.js --check    # validate fragment names/bodies
 *   node scripts/assemble-changelog.js --release 2.1.0 [--date YYYY-MM-DD]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep a Changelog sections, in the order they render.
export const FRAGMENT_TYPES = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security', 'docs'];

const HEADINGS = {
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  fixed: 'Fixed',
  security: 'Security',
  docs: 'Docs',
};

const UNRELEASED = '## [Unreleased]';

export function parseFragmentName(name) {
  const m = /^(.+)\.([a-z]+)\.md$/.exec(name);
  if (!m) throw new Error(`${name}: expected <id>.<type>.md (e.g. 282.fixed.md)`);
  const [, rawId, type] = m;
  if (!FRAGMENT_TYPES.includes(type)) {
    throw new Error(`${name}: unknown type "${type}" — expected one of ${FRAGMENT_TYPES.join(', ')}`);
  }
  const id = Number(rawId);
  return { id: Number.isInteger(id) ? id : rawId, type };
}

export function readFragments(dir) {
  return readdirSync(dir)
    .filter((f) => f !== 'README.md')
    .map((f) => ({ ...parseFragmentName(f), body: readFileSync(join(dir, f), 'utf8').trim(), file: join(dir, f) }));
}

/** Split "### Foo\n<body>" blocks out of an Unreleased section body. */
function splitSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const h = /^### (.+)$/.exec(line);
    if (h) {
      current = h[1].trim().toLowerCase();
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  for (const [k, lines] of sections) sections.set(k, lines.join('\n').trim());
  return sections;
}

function byId(a, b) {
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
  return String(a.id).localeCompare(String(b.id));
}

/** Fold fragments into the Unreleased section of `changelog`, returning the full file. */
export function assembleUnreleased(changelog, fragments) {
  const start = changelog.indexOf(UNRELEASED);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const bodyStart = start + UNRELEASED.length;
  const nextRelease = changelog.indexOf('\n## ', bodyStart);
  const end = nextRelease === -1 ? changelog.length : nextRelease;

  const sections = splitSections(changelog.slice(bodyStart, end));
  for (const frag of [...fragments].sort(byId)) {
    const key = HEADINGS[frag.type].toLowerCase();
    const existing = sections.get(key);
    sections.set(key, existing ? `${existing}\n${frag.body}` : frag.body);
  }

  const rendered = FRAGMENT_TYPES.filter((t) => sections.get(HEADINGS[t].toLowerCase()))
    .map((t) => `### ${HEADINGS[t]}\n${sections.get(HEADINGS[t].toLowerCase())}`)
    .join('\n\n');

  const body = rendered ? `\n\n${rendered}\n` : '\n';
  return changelog.slice(0, bodyStart) + body + changelog.slice(end);
}

/** Stamp the assembled Unreleased section as `version`, and open a fresh empty one. */
export function renderRelease(changelog, fragments, version, date) {
  const assembled = assembleUnreleased(changelog, fragments);
  return assembled.replace(UNRELEASED, `## [${version}] - ${date}`).replace(`## [${version}]`, `${UNRELEASED}\n\n## [${version}]`);
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = join(repoRoot, 'changelog.d');
  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  const args = process.argv.slice(2);

  let fragments;
  try {
    fragments = readFragments(dir);
  } catch (err) {
    console.error(`changelog: ${err.message}`);
    process.exit(1);
  }

  if (args.includes('--check')) {
    console.log(`changelog: ${fragments.length} fragment(s) OK`);
    return;
  }

  const changelog = readFileSync(changelogPath, 'utf8');
  const relIdx = args.indexOf('--release');
  if (relIdx === -1) {
    const out = assembleUnreleased(changelog, fragments);
    const start = out.indexOf(UNRELEASED);
    const next = out.indexOf('\n## ', start + UNRELEASED.length);
    console.log(out.slice(start, next === -1 ? undefined : next));
    return;
  }

  const version = args[relIdx + 1];
  if (!version || version.startsWith('--')) {
    console.error('changelog: --release needs a version (e.g. --release 2.1.0)');
    process.exit(1);
  }
  const dateIdx = args.indexOf('--date');
  const date = dateIdx === -1 ? new Date().toISOString().slice(0, 10) : args[dateIdx + 1];

  writeFileSync(changelogPath, renderRelease(changelog, fragments, version, date));
  for (const f of fragments) rmSync(f.file);
  console.log(`changelog: released ${version} (${fragments.length} fragment(s) folded in and removed)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
