import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragmentName, assembleUnreleased, renderRelease, extractReleaseNotes, FRAGMENT_TYPES } from '../scripts/assemble-changelog.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fragmentDir = join(repoRoot, 'changelog.d');
const scriptPath = join(repoRoot, 'scripts', 'assemble-changelog.js');

const BASE = `# Changelog

## [Unreleased]

### Fixed
- **existing**: an entry that already landed.

## [2.0.0] - 2026-04-20
- old release.
`;

describe('changelog fragment names', () => {
  it('parses <id>.<type>.md', () => {
    expect(parseFragmentName('282.fixed.md')).toEqual({ id: 282, type: 'fixed' });
  });

  it('rejects an unknown type, so a typo cannot silently vanish at release', () => {
    expect(() => parseFragmentName('282.bogus.md')).toThrow(/unknown type/i);
  });

  it('rejects a name with no type segment', () => {
    expect(() => parseFragmentName('282.md')).toThrow(/expected <id>\.<type>\.md/i);
  });
});

describe('changelog.d/ contents (repo gate)', () => {
  const files = readdirSync(fragmentDir).filter((f) => f !== 'README.md');

  it('every fragment is named <id>.<type>.md with a known type', () => {
    for (const f of files) expect(() => parseFragmentName(f)).not.toThrow();
  });

  it('every fragment is a non-empty markdown list item', () => {
    for (const f of files) {
      const body = readFileSync(join(fragmentDir, f), 'utf8').trim();
      expect(body.length, `${f} is empty`).toBeGreaterThan(0);
      expect(body.startsWith('- '), `${f} must start with "- "`).toBe(true);
    }
  });
});

describe('assembleUnreleased', () => {
  it('folds a fragment into its existing section without dropping what is there', () => {
    const out = assembleUnreleased(BASE, [{ id: 281, type: 'fixed', body: '- **B door**: fixed.' }]);
    expect(out).toContain('- **existing**: an entry that already landed.');
    expect(out).toContain('- **B door**: fixed.');
  });

  it('keeps BOTH sibling entries — the cascade regression this replaces', () => {
    const out = assembleUnreleased(BASE, [
      { id: 279, type: 'fixed', body: '- **A door**: fixed.' },
      { id: 281, type: 'fixed', body: '- **B door**: fixed.' },
    ]);
    expect(out).toContain('- **A door**: fixed.');
    expect(out).toContain('- **B door**: fixed.');
    // ordered by id, so the assembled log does not depend on merge order
    expect(out.indexOf('A door')).toBeLessThan(out.indexOf('B door'));
  });

  it('creates a section that does not exist yet, in canonical order', () => {
    const out = assembleUnreleased(BASE, [{ id: 283, type: 'added', body: '- **new**: thing.' }]);
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [2.0.0]'));
    expect(unreleased).toContain('### Added');
    expect(unreleased.indexOf('### Added')).toBeLessThan(unreleased.indexOf('### Fixed'));
  });

  it('is deterministic — same fragments, same output regardless of read order', () => {
    const frags = [
      { id: 281, type: 'fixed', body: '- b.' },
      { id: 279, type: 'added', body: '- a.' },
    ];
    expect(assembleUnreleased(BASE, [...frags].reverse())).toBe(assembleUnreleased(BASE, frags));
  });
});

describe('renderRelease', () => {
  const out = renderRelease(BASE, [{ id: 281, type: 'fixed', body: '- **B door**: fixed.' }], '2.1.0', '2026-07-13');

  it('stamps the version and date and folds the fragments in', () => {
    expect(out).toContain('## [2.1.0] - 2026-07-13');
    expect(out).toContain('- **B door**: fixed.');
  });

  it('leaves a fresh empty [Unreleased] on top', () => {
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [2.1.0]'));
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [2.1.0]'));
    expect(unreleased).not.toContain('- ');
  });

  it('preserves prior releases', () => {
    expect(out).toContain('## [2.0.0] - 2026-04-20');
  });
});

describe('extractReleaseNotes', () => {
  const RELEASED = `# Changelog

## [Unreleased]

## [2.1.0] - 2026-07-15

### Added
- **thing**: a released feature.

### Fixed
- **bug**: squashed.

## [2.0.0] - 2026-04-20

### Added
- **old**: a prior release.
`;

  it('returns the folded body for the matching version', () => {
    const notes = extractReleaseNotes(RELEASED, '2.1.0');
    expect(notes).toContain('### Added');
    expect(notes).toContain('- **thing**: a released feature.');
    expect(notes).toContain('- **bug**: squashed.');
  });

  it('matches the version regardless of the " - <date>" suffix', () => {
    expect(extractReleaseNotes(RELEASED, '2.1.0').startsWith('### Added')).toBe(true);
  });

  it('stops at the next release header — does not bleed the following section', () => {
    const notes = extractReleaseNotes(RELEASED, '2.1.0');
    expect(notes).not.toContain('- **old**: a prior release.');
    expect(notes).not.toContain('## [2.0.0]');
  });

  it('returns "" when the version has no section (so the workflow can fall back)', () => {
    expect(extractReleaseNotes(RELEASED, '9.9.9')).toBe('');
  });
});

describe('assemble-changelog --notes (CLI)', () => {
  it('prints the folded 2.1.0 section from the repo CHANGELOG', () => {
    const out = execFileSync('node', [scriptPath, '--notes', '2.1.0'], { encoding: 'utf8' });
    expect(out).toContain('### Added');
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('prints nothing for an absent version', () => {
    const out = execFileSync('node', [scriptPath, '--notes', '99.99.99'], { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});

describe('FRAGMENT_TYPES', () => {
  it('covers the Keep a Changelog sections the log actually uses', () => {
    for (const t of ['added', 'changed', 'fixed', 'security', 'docs']) expect(FRAGMENT_TYPES).toContain(t);
  });
});
