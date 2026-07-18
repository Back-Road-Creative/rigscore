import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROADMAP_PATH = path.join(__dirname, '..', 'docs', 'ROADMAP.md');

describe('docs/ROADMAP.md — de-vendored + agnosticism entries', () => {
  const roadmap = fs.readFileSync(ROADMAP_PATH, 'utf8');
  const lower = roadmap.toLowerCase();

  it('names no competitor vendor as evidence for a roadmap item', () => {
    const vendors = [
      'cisco',
      'snyk',
      'semgrep',
      'agentauditkit',
      'trail of bits',
      'trailofbits',
      'splx',
      'virustotal',
    ];
    for (const vendor of vendors) {
      expect(lower, `ROADMAP still cites competitor "${vendor}"`).not.toContain(vendor);
    }
  });

  it('cites no competitor product/tool name', () => {
    const products = [
      'mcp-scanner',
      'skill-scanner',
      'a2a-scanner',
      'agent-scan',
      'mcp-context-protector',
      'agentic radar',
      'claude-code-security-review',
    ];
    for (const product of products) {
      expect(lower, `ROADMAP still cites competitor product "${product}"`).not.toContain(product);
    }
  });

  it('adds a CI agent-capability-beyond-GitHub-Actions entry (GitLab CI)', () => {
    expect(lower).toContain('gitlab ci');
    expect(lower).toContain('ci-agent-caps');
  });

  it('adds a scored per-client settings-safety family entry', () => {
    expect(lower).toContain('settings-safety');
    expect(lower).toContain('claude-settings');
  });

  it('adds a registry-driven env-exposure entry', () => {
    expect(lower).toContain('env-exposure');
    expect(roadmap).toContain('src/clients.js');
  });

  it('adds a cross-vendor memory-hygiene conventions entry', () => {
    expect(lower).toContain('cross-vendor');
    expect(lower).toContain('memory-hygiene');
  });
});
