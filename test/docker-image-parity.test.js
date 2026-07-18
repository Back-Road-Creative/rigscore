import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guard: the published image must actually contain the directories the
// shipped code reads at runtime. Nothing else asserts this, which is how
// `templates/` and `docs/checks/` drifted out of the image while every test
// stayed green (the repo checkout has them; the image does not).
//
// Deliberately Docker-daemon-free — CI runners may not have one. We parse the
// Dockerfile's COPY instructions and the .dockerignore rules and reason about
// the resulting layout.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** COPY <src>... <dest> — collect the srcs (last token is the dest). */
export function parseCopySources(dockerfile) {
  const srcs = [];
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^\s*COPY\s+(.+?)\s*$/i);
    if (!m || /^--/.test(m[1])) continue; // no --from/--chown forms in this image
    const parts = m[1].split(/\s+/);
    if (parts.length < 2) continue;
    for (const s of parts.slice(0, -1)) srcs.push(s.replace(/\/+$/, ''));
  }
  return srcs;
}

/** .dockerignore → ordered rules. Blank lines and `#` comments are skipped. */
export function parseIgnoreRules(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!')
      ? { pattern: l.slice(1).replace(/^\/+|\/+$/g, ''), negated: true }
      : { pattern: l.replace(/^\/+|\/+$/g, ''), negated: false }));
}

const toRegExp = (pattern) => new RegExp(`^${pattern
  .split('/')
  .map((seg) => (seg === '**'
    ? '.*'
    : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')))
  .join('/')
  .replace(/\.\*\//g, '(?:.*/)?')}$`);

/**
 * Ports docker's MatchesUsingParentResults (moby/patternmatcher): walk the path
 * one segment at a time, carrying each rule's parent match forward, last
 * matching rule wins. Two behaviours here are load-bearing and were verified
 * against a real `docker build`, not reasoned about:
 *
 *  1. A rule that matched a parent dir keeps matching everything beneath it —
 *     that is how `docs` takes its whole subtree, and how `!docs/checks` hands
 *     the rescue down to the .md files inside it.
 *  2. A rule is SKIPPED (and records no parent match) when it cannot change the
 *     outcome: a negation while the path is not currently excluded, or a plain
 *     exclude while it already is. This is the subtle one — nothing excludes the
 *     templates/ dir itself, so a bare `!templates` is never evaluated there and
 *     can NOT rescue templates/docs/CLAUDE.md from `**\/*.md`. Only a rule that
 *     matches the file path itself (`!templates/**`) does.
 */
export function isIgnored(relPath, rules) {
  const segs = relPath.split('/');
  let parentMatched = rules.map(() => false);
  let ignored = false;
  for (let i = 0; i < segs.length; i++) {
    const current = segs.slice(0, i + 1).join('/');
    const nextMatched = rules.map(() => false);
    ignored = false;
    rules.forEach((rule, r) => {
      let match = parentMatched[r];
      if (!match) {
        if (rule.negated !== ignored) return; // cannot change the outcome — skip, record nothing
        match = toRegExp(rule.pattern).test(current);
      }
      nextMatched[r] = match;
      if (match) ignored = !rule.negated;
    });
    parentMatched = nextMatched;
  }
  return ignored;
}

const copySources = parseCopySources(read('Dockerfile'));
const ignoreRules = parseIgnoreRules(read('.dockerignore'));

/** Is `relPath` inside some COPY src (the path itself or a directory above it)? */
const isCopied = (relPath) => copySources.some((s) => relPath === s || relPath.startsWith(`${s}/`));

/** The file lands in the image iff it is COPYed and no ignore rule kills it. */
const survives = (relPath) => isCopied(relPath) && !isIgnored(relPath, ignoreRules);

const packNames = fs.readdirSync(path.join(REPO_ROOT, 'templates'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'templates', e.name, 'pack.json')))
  .map((e) => e.name).sort();

const checkDocs = fs.readdirSync(path.join(REPO_ROOT, 'docs', 'checks'))
  .filter((f) => f.endsWith('.md')).sort();

describe('docker image parity — the image contains what the shipped code reads', () => {
  it('the matcher itself models docker semantics (self-test)', () => {
    const rules = parseIgnoreRules('docs\n**/*.md\n!README.md\n!docs/checks\n');
    expect(isIgnored('docs/init-packs.md', rules)).toBe(true);   // dir rule takes the subtree
    expect(isIgnored('src/x.md', rules)).toBe(true);             // **/*.md is repo-wide
    expect(isIgnored('README.md', rules)).toBe(false);           // negation below it wins
    expect(isIgnored('docs/checks/governance-docs.md', rules)).toBe(false);
    expect(isIgnored('src/index.js', rules)).toBe(false);
    // Order is load-bearing: the same negation ABOVE the rule is inert.
    expect(isIgnored('docs/checks/governance-docs.md', parseIgnoreRules('!docs/checks\ndocs\n'))).toBe(true);

    // The one a naive matcher gets wrong. Both were confirmed against a real
    // `docker build`: nothing excludes the templates/ DIR, so a bare
    // `!templates` is never evaluated there and cannot rescue the .md files
    // under it — the image really does ship pack.json with no payload.
    const bare = parseIgnoreRules('**/*.md\n!templates\n');
    expect(isIgnored('templates/docs/CLAUDE.md', bare)).toBe(true);
    const glob = parseIgnoreRules('**/*.md\n!templates/**\n');
    expect(isIgnored('templates/docs/CLAUDE.md', glob)).toBe(false);
  });

  it('sanity: the repo really does have packs and check docs to ship', () => {
    expect(packNames).toContain('docs');
    expect(checkDocs.length).toBeGreaterThan(20);
  });

  // Derived, not hardcoded: whatever each pack.json declares as its payload is
  // what the image must carry. listPacks() readdirs templates/ and swallows a
  // missing dir (returns []), and findApplicablePacks() swallows a pack whose
  // src files are absent — so every failure mode here is SILENT at runtime.
  describe.each(packNames)('pack "%s"', (name) => {
    const manifest = JSON.parse(read(path.join('templates', name, 'pack.json')));

    it('its pack.json survives into the image', () => {
      expect(survives(`templates/${name}/pack.json`)).toBe(true);
    });

    it.each(manifest.files.map((f) => f.src))('its payload "%s" survives into the image', (src) => {
      expect(survives(`templates/${name}/${src}`)).toBe(true);
    });
  });

  // The trap, spelled out: the docs pack's payload is entirely .md, and
  // .dockerignore blankets `**/*.md` with a `!README.md` that only rescues the
  // ROOT readme. `COPY templates/` alone ships a pack whose declared files are
  // missing — loadPack throws and findApplicablePacks silently skips it.
  it('.md payloads inside templates/ survive the **/*.md blanket', () => {
    expect(isIgnored('templates/docs/CLAUDE.md', ignoreRules)).toBe(false);
    expect(isIgnored('templates/docs/AGENTS.md', ignoreRules)).toBe(false);
    expect(survives('templates/docs/CLAUDE.md')).toBe(true);
    expect(survives('templates/docs/AGENTS.md')).toBe(true);
  });

  // `rigscore explain <check>` reads REPO_ROOT/docs/checks/<id>.md.
  it.each(checkDocs)('docs/checks/%s survives into the image (rigscore explain)', (file) => {
    expect(survives(`docs/checks/${file}`)).toBe(true);
  });

  // Slim by intent: only docs/checks is read at runtime. Everything else under
  // docs/ is human-facing and stays out of the image.
  it('keeps the image slim — docs/ beyond checks/ is not shipped', () => {
    expect(survives('docs/examples/rigscorerc.json')).toBe(false);
    expect(survives('docs/init-packs.md')).toBe(false);
    expect(survives('test/packs.test.js')).toBe(false);
    expect(survives('node_modules/vitest/package.json')).toBe(false);
  });

  // The matcher above is a MODEL of docker, and a model that quietly disagrees
  // with the real builder is worse than none. This block makes it falsifiable:
  //   docker build -t rigscore:t . && docker create --name c rigscore:t
  //   docker cp c:/app /tmp/app && RIGSCORE_IMAGE_APP=/tmp/app npx vitest run \
  //     test/docker-image-parity.test.js
  // Skipped by default — CI runners have no docker daemon.
  const imageApp = process.env.RIGSCORE_IMAGE_APP;
  describe.skipIf(!imageApp)('cross-check: predictions vs a really-built image', () => {
    const inImage = (rel) => fs.existsSync(path.join(imageApp, rel));
    const paths = [
      ...packNames.flatMap((n) => [
        `templates/${n}/pack.json`,
        ...JSON.parse(read(path.join('templates', n, 'pack.json'))).files.map((f) => `templates/${n}/${f.src}`),
      ]),
      ...checkDocs.map((f) => `docs/checks/${f}`),
      'src/cli/packs.js', 'bin/rigscore.js', 'package.json',
      'docs/init-packs.md', 'docs/examples/rigscorerc.json', 'test/packs.test.js', 'README.md',
    ];
    it.each(paths)('%s — model agrees with the image', (rel) => {
      expect(inImage(rel)).toBe(survives(rel));
    });
  });
});
