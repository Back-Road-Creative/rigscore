import { describe, it, expect } from 'vitest';
import { findFindingSection } from '../src/cli/explain.js';

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
