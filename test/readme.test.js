import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', 'README.md');

describe('README positioning content', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('T4.1 — names Snyk Agent Scan and Semgrep as comparables in a dedicated section', () => {
    expect(readme).toMatch(/^## How rigscore compares/m);
    const lower = readme.toLowerCase();
    expect(lower).toContain('snyk agent scan');
    expect(lower).toContain('semgrep');
  });

  it('T4.1 — comparables section notes when to use which tool', () => {
    // Extract the "How rigscore compares" section
    const match = readme.match(/^## How rigscore compares[\s\S]*?(?=^## )/m);
    expect(match).toBeTruthy();
    const section = match[0].toLowerCase();
    // Honest framing: differentiators + gaps
    expect(section).toContain('coherence');
    // Mentions rigscore's "no account / no API token" differentiator OR the opposite gap
    expect(section).toMatch(/no account|no api token|no token|local/);
    // Mentions rug-pull / tool pinning gap (honest disclosure)
    expect(section).toMatch(/rug.?pull|tool pinning/);
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
