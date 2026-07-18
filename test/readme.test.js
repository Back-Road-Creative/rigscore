import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', 'README.md');

describe('README positioning content', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('T4.1 — positions rigscore in its own terms, names no third-party tool/vendor', () => {
    // rigscore describes what it does, not how it stacks up against named
    // competitors. This gate stops competitor names from creeping back in.
    //
    // Allowlisted substrings are stripped first so they cannot false-trigger a
    // ban match:
    //  - `codeql-action` — the GitHub Action reference is fine; only the bare
    //    `codeql` product name is banned.
    //  - AI-client names rigscore actually scans (claude, cursor, gemini, codex,
    //    opencode, copilot) and the governance filenames CLAUDE.md / AGENTS.md
    //    are subject matter, not competitors — none collide with a banned term.
    //  - the secret-pattern vendor list (Anthropic, OpenAI, GitHub, AWS, …) names
    //    the API-key TYPES rigscore detects; those names don't collide with any
    //    banned term either, so they pass without a carve-out.
    const scrubbed = readme.toLowerCase().replaceAll('codeql-action', '');

    const banned = [
      'snyk',
      'semgrep',
      'agentauditkit',
      'cisco',
      'socket.dev',
      'gitleaks',
      'trufflehog',
      'shellcheck',
      'trivy',
      'osv-scanner',
      'prisma airs',
      'modelscan',
      'codeql',
    ];
    for (const name of banned) {
      expect(scrubbed, `README must not name third-party tool "${name}"`).not.toContain(name);
    }

    // The competitor-comparison section is gone entirely.
    expect(readme).not.toMatch(/^## How rigscore compares/m);
  });

  it('T4.2 — Limitations section leads with semantic reversal', () => {
    const match = readme.match(/^## Limitations[\s\S]*?(?=^## )/m);
    expect(match).toBeTruthy();
    const section = match[0];
    // The first bullet in Limitations must reference semantic reversal / keyword gaming
    const lines = section.split('\n').filter(l => l.trim().startsWith('-'));
    expect(lines.length).toBeGreaterThan(0);
    const firstBullet = lines[0].toLowerCase();
    expect(firstBullet).toMatch(/semantic|keyword/);
    // Links to keyword-gaming.test.js for the authoritative known-limitation list
    expect(section).toContain('test/keyword-gaming.test.js');
  });

  it('T4.3 — "Why this exists" leads with differentiation', () => {
    const match = readme.match(/^## Why this exists[\s\S]*?(?=^## )/m);
    expect(match).toBeTruthy();
    const section = match[0].toLowerCase();
    // Should NOT lead with generic "AI coding tools are powerful"
    const firstPara = section.split('\n\n')[1] || '';
    expect(firstPara).not.toMatch(/^ai coding tools are powerful/);
    // Should surface differentiators
    expect(section).toMatch(/coherence|contradictions/);
    expect(section).toMatch(/single.?score|ci gate|fail.?under/);
    expect(section).toMatch(/local|no account|no api token|no token/);
  });
});
