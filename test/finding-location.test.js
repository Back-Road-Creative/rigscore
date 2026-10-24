import { describe, it, expect } from 'vitest';
import { formatSarif } from '../src/sarif.js';
import { formatCodeClimate } from '../src/reporter.js';
import { findingLocation } from '../src/findings.js';

const DOC_BASE = 'https://github.com/Back-Road-Creative/rigscore/blob/main/docs/checks';

function run(finding, id = 'instruction-effectiveness') {
  return {
    score: 50,
    results: [{
      id, name: 'Check', category: 'governance', weight: 10, score: 50,
      findings: [{ severity: 'warning', title: 'Vague instruction', ...finding }],
    }],
  };
}

describe('findingLocation', () => {
  it('reads context.file and context.line', () => {
    expect(findingLocation({ context: { file: 'docs/a.md', line: 7 } })).toEqual({ file: 'docs/a.md', line: 7 });
  });
  it('returns the file alone when the line is absent or invalid', () => {
    expect(findingLocation({ context: { file: 'a.md' } })).toEqual({ file: 'a.md', line: null });
    expect(findingLocation({ context: { file: 'a.md', line: 0 } })).toEqual({ file: 'a.md', line: null });
    expect(findingLocation({ context: { file: 'a.md', line: 1.5 } })).toEqual({ file: 'a.md', line: null });
    expect(findingLocation({ context: { file: 'a.md', line: '3' } })).toEqual({ file: 'a.md', line: null });
  });
  it('normalizes backslashes and a leading ./', () => {
    expect(findingLocation({ context: { file: '.\\sub\\a.md', line: 2 } })).toEqual({ file: 'sub/a.md', line: 2 });
  });
  it('rejects absolute, traversing, empty and non-string files', () => {
    for (const file of ['/abs/secret.md', 'C:\\x\\a.md', '../a.md', 'a/../../b.md', '', '   ', 42, null]) {
      expect(findingLocation({ context: { file, line: 3 } })).toBeNull();
    }
  });
  it('ignores a file that is relative to a directory outside the repo (memDir)', () => {
    expect(findingLocation({ context: { file: 'note.md', memDir: 'elsewhere' } })).toBeNull();
  });
  it('returns null with no context', () => {
    expect(findingLocation({})).toBeNull();
    expect(findingLocation(null)).toBeNull();
  });
});

describe('SARIF region from finding context', () => {
  it('emits artifactLocation and region.startLine when context has file and line', () => {
    const sarif = formatSarif(run({ context: { file: 'CLAUDE.md', line: 12 } }));
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(loc.physicalLocation.region).toEqual({ startLine: 12 });
    expect(loc.logicalLocations).toBeDefined();
  });
  it('prefers context.file over a path guessed from the text', () => {
    const sarif = formatSarif(run({ title: 'Problem in other.md', context: { file: 'real.md', line: 3 } }));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('real.md');
  });
  it('emits a file without a region when there is no line', () => {
    const sarif = formatSarif(run({ context: { file: 'real.md' } }));
    const pl = sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(pl.artifactLocation.uri).toBe('real.md');
    expect('region' in pl).toBe(false);
  });
  it('never emits an absolute context path', () => {
    const sarif = formatSarif(run({ context: { file: '/abs/secret.md', line: 1 } }));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation).toBeUndefined();
  });
  it('keeps the text-derived path when context has none', () => {
    const sarif = formatSarif(run({ title: 'Problem in other.md' }));
    const pl = sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(pl.artifactLocation.uri).toBe('other.md');
    expect('region' in pl).toBe(false);
  });
});

describe('CodeClimate lines from finding context', () => {
  it('uses context.file and context.line for path and lines.begin', () => {
    const [issue] = JSON.parse(formatCodeClimate(run({ context: { file: 'CLAUDE.md', line: 12 } })));
    expect(issue.location).toEqual({ path: 'CLAUDE.md', lines: { begin: 12 } });
  });
  it('falls back to begin 1 with no line', () => {
    const [issue] = JSON.parse(formatCodeClimate(run({ context: { file: 'CLAUDE.md' } })));
    expect(issue.location).toEqual({ path: 'CLAUDE.md', lines: { begin: 1 } });
  });
  it('keeps the check id as path when nothing locates the finding', () => {
    const [issue] = JSON.parse(formatCodeClimate(run({})));
    expect(issue.location.path).toBe('instruction-effectiveness');
  });
});

describe('SARIF helpUri defaults to the check doc', () => {
  it('sets helpUri on rules of a check that has a doc when the finding has no learnMore', () => {
    const sarif = formatSarif(run({ findingId: 'instruction-effectiveness/vague-instruction' }));
    const rules = sarif.runs[0].tool.driver.rules;
    const expected = `${DOC_BASE}/instruction-effectiveness.md`;
    expect(rules.find((r) => r.id === 'instruction-effectiveness').helpUri).toBe(expected);
    const findingRule = rules.find((r) => r.id === 'instruction-effectiveness/vague-instruction');
    expect(findingRule.helpUri).toBe(expected);
    expect(findingRule.help.markdown).toContain(expected);
  });
  it('keeps an explicit learnMore over the default', () => {
    const sarif = formatSarif(run({ learnMore: 'https://example.com/x' }));
    const rule = sarif.runs[0].tool.driver.rules.find((r) => r.id.includes('/'));
    expect(rule.helpUri).toBe('https://example.com/x');
  });
  it('falls back to the doc when learnMore is not an http(s) URL', () => {
    const sarif = formatSarif(run({ learnMore: 'javascript:alert(1)' }));
    const rule = sarif.runs[0].tool.driver.rules.find((r) => r.id.includes('/'));
    expect(rule.helpUri).toBe(`${DOC_BASE}/instruction-effectiveness.md`);
  });
  it('omits helpUri for a check with no doc', () => {
    const sarif = formatSarif(run({}, 'third-party-check'));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect('helpUri' in rule).toBe(false);
    }
  });
  it('does not build a path from an id that is not a plain slug', () => {
    const sarif = formatSarif(run({}, '../README'));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect('helpUri' in rule).toBe(false);
    }
  });
});
