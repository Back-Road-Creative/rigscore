import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FILES = {
  'docs/known-limits.md': fs.readFileSync(path.join(ROOT, 'docs', 'known-limits.md'), 'utf8'),
  'THREAT-MODEL.md': fs.readFileSync(path.join(ROOT, 'THREAT-MODEL.md'), 'utf8'),
};

// Named third-party products must not appear anywhere in these two disclosure
// docs — neither as "reach for X" pointers nor as substance-keyword examples.
// The honest "rigscore won't catch Y" statements stay; only the named tools
// become generic capability categories.
const FORBIDDEN_NAMES = [
  'snyk',
  'semgrep',
  'codeql',
  'trivy',
  'osv-scanner',
  'socket.dev',
  'shellcheck',
  'cisco',
  'prisma',
  'protect ai',
  'protectai',
  'palo alto',
  'modelscan',
  'gitleaks',
  'trufflehog',
  'detect-secrets',
  'claude-code-security-review',
];

// Vendor URLs / domains whose links must be stripped.
const FORBIDDEN_URLS = [
  'semgrep.dev',
  'codeql.github.com',
  'trivy.dev',
  'osv.dev',
  'shellcheck.net',
  'paloaltonetworks.com',
  'github.com/snyk',
  'github.com/gitleaks',
  'github.com/trufflesecurity',
  'github.com/cisco-ai-defense',
  'github.com/protectai',
  'github.com/anthropics/claude-code-security-review',
];

describe('known-limits + threat-model neutralize named third-party tools', () => {
  for (const [label, content] of Object.entries(FILES)) {
    const lower = content.toLowerCase();

    for (const name of FORBIDDEN_NAMES) {
      it(`${label} names no third-party product: ${name}`, () => {
        expect(lower.includes(name), `"${name}" still appears in ${label}`).toBe(false);
      });
    }

    for (const url of FORBIDDEN_URLS) {
      it(`${label} links to no vendor URL: ${url}`, () => {
        expect(lower.includes(url), `"${url}" still appears in ${label}`).toBe(false);
      });
    }
  }

  it('docs/known-limits.md keeps the honest gaps, stated as generic categories', () => {
    const lower = FILES['docs/known-limits.md'].toLowerCase();
    // Honesty preserved — the "rigscore does NOT catch X" statements stay.
    expect(lower).toContain('rigscore does not do sast');
    expect(lower).toContain('rigscore scans the working tree');
    // Generic capability categories replace the named tools.
    expect(lower).toContain('live mcp introspection scanner');
    expect(lower).toContain('source-level sast');
    expect(lower).toContain('git-history secret scanner');
    expect(lower).toContain('container/dependency vulnerability scanner');
    expect(lower).toContain('llm-judge advisory pass');
    expect(lower).toContain('shell linter');
    expect(lower).toContain('model-artifact scanner');
  });

  it('THREAT-MODEL.md section 5 keeps the honest gaps, stated as generic categories', () => {
    const section = FILES['THREAT-MODEL.md'].match(
      /^## 5\. If you need coverage[\s\S]*?(?=^---)/m,
    );
    expect(section, 'section 5 not found').toBeTruthy();
    const lower = section[0].toLowerCase();
    expect(lower).toContain('live mcp introspection scanner');
    expect(lower).toContain('adversarial llm-judge pass');
    expect(lower).toContain('source-level sast');
    expect(lower).toContain('git-history secret scanner');
    expect(lower).toContain('dependency vulnerability scanner');
    // Honesty preserved.
    expect(lower).toContain('rigscore does not reason about source-code');
    expect(lower).toContain('not git history');
  });
});
