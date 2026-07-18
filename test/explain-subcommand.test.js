import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFindingSection } from '../src/cli/explain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

describe('rigscore explain — section resolver', () => {
  const doc = `# claude-md

## Purpose
Overall purpose.

## Findings

### missing-claude-md
This specific finding describes a missing governance file.
Remediation: create one.

### conflicting-rules
Another finding.

## Weight rationale
Ten points.
`;

  it('returns the section matching a finding slug at H3', () => {
    const section = findFindingSection(doc, 'missing-claude-md');
    expect(section).toMatch(/^### missing-claude-md/);
    expect(section).toContain('governance file');
    // Stops at the next H3 (same level) or H2
    expect(section).not.toContain('conflicting-rules');
  });

  it('returns null when the slug does not match any heading', () => {
    expect(findFindingSection(doc, 'nonexistent-slug')).toBeNull();
  });

  it('partial slug match still resolves', () => {
    // "conflicting" is a subset of the "conflicting-rules" heading
    const section = findFindingSection(doc, 'conflicting');
    expect(section).toMatch(/^### conflicting-rules/);
  });
});

describe('rigscore explain — CLI dispatch', () => {
  it('routes `explain <findingId>` to the subcommand and prints docs', () => {
    const res = spawnSync('node', [BIN, 'explain', 'governance-docs/missing-claude-md'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  it('exits non-zero with a helpful message when the check id is unknown', () => {
    const res = spawnSync('node', [BIN, 'explain', 'no-such-check/whatever'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/no docs found/i);
  });
});
