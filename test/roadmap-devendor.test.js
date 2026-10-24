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

/** Text of "### N. ..." up to the next heading or rule. */
function itemSection(text, n) {
  const m = text.match(new RegExp(`^### ${n}\\. [\\s\\S]*?(?=^### |^---$|^## )`, 'm'));
  if (!m) throw new Error(`ROADMAP item ${n} not found`);
  return m[0];
}

describe('docs/ROADMAP.md — items reworded after the capability shipped', () => {
  const roadmap = fs.readFileSync(ROADMAP_PATH, 'utf8');

  it('item 5 credits the shipped non-text sniff and leaves only the online lookup open', () => {
    const item = itemSection(roadmap, 5).toLowerCase();
    expect(item).toContain('skill-files');
    expect(item).toContain('non-text');
    expect(item).toContain('--online');
    expect(item).not.toContain('regex-scanned as mojibake');
    expect(item).not.toContain('there is no non-text sniff');
  });

  it('item 11 names the shipped GitLab CI and CircleCI scan and the remaining gap', () => {
    const item = itemSection(roadmap, 11).toLowerCase();
    expect(item).toContain('gitlab ci');
    expect(item).toContain('circleci');
    expect(item).toContain('other ci systems');
    expect(item).not.toContain('parses `.github/workflows` exclusively');
  });

  it('item 13 credits the registry-driven MCP env scan and names the remaining hardcoded list', () => {
    const item = itemSection(roadmap, 13);
    expect(item).toContain('repoMcpEnvValues');
    expect(item).toContain('AI_CONFIG_FILES');
    expect(item).not.toContain('only client-settings entry');
  });

  it('item 17 records Homebrew and prebuilt archives as shipped', () => {
    const lower = roadmap.toLowerCase();
    expect(lower).not.toContain('excludes part of the security audience');
    expect(roadmap).toContain('Formula/rigscore.rb');
    expect(roadmap).toContain('prebuilt-binaries.yml');
  });
});

describe('docs/checks/ci-agent-caps.md — scope matches the check', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'checks', 'ci-agent-caps.md'), 'utf8');

  it('no longer claims .github/workflows is the only surface', () => {
    expect(doc).not.toContain('`.github/workflows/*.yml|yaml` only');
  });

  it('documents the GitLab CI and CircleCI config files and what they are not graded on', () => {
    expect(doc).toContain('.gitlab-ci.yml');
    expect(doc).toContain('.circleci/config.yml');
    expect(doc.toLowerCase()).toContain('timeout');
  });
});

describe('docs/known-limits.md — spend limits', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'known-limits.md'), 'utf8');

  it('has a row saying account-level spend limits are not repo-checkable', () => {
    expect(doc.toLowerCase()).toContain('spend limit');
  });
});
