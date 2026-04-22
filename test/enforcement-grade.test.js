/**
 * Enforcement-grade labels — RED tests (Phase 1B).
 *
 * Encodes the acceptance criteria for the "transparency labels" feature
 * described in `.data/plans/rigscore-enforcement-grade-labels.md` and
 * the Phase 0 validation report at
 * `.data/plans/enforcement-grade-phase0-validation.md`.
 *
 * All tests in this file are expected to FAIL until Phase 2 lands. They
 * are the TDD target for:
 *   - every `src/checks/*.js` module exporting `enforcementGrade`
 *   - reporter output carrying `[mechanical]` / `[pattern]` / `[keyword]`
 *     tokens on per-check lines (scored, advisory, and N/A branches)
 *   - reporter legend line present in terminal output, suppressed in
 *     `--json` / `--sarif` modes
 *   - SARIF results each carrying `properties.enforcementGrade`
 *
 * Scope decisions (from Phase 0 patched spec):
 *   - Per-check assertion is scoped to `src/checks/*.js` only — NOT
 *     discovered plugins. Phase 2 will add a defensive default for
 *     plugin-authored checks so this scoping does not regress them.
 *   - JSON output DOES carry `enforcementGrade` per check entry. Only
 *     the human-facing legend string is suppressed in JSON/SARIF.
 *   - Advisory (weight-0) and N/A (score === NOT_APPLICABLE_SCORE)
 *     reporter branches must both show the grade column.
 *
 * The Phase 1A authoritative classification lives at
 * `.data/plans/enforcement-grade-classification.md`. The EXPECTED_GRADES
 * map below is synced to that table (Phase 2 reconciliation); update it
 * here and in every `src/checks/*.js` module if a grade is reclassified.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scanner.js';
import { formatTerminal, formatJson, stripAnsi } from '../src/reporter.js';
import { formatSarif } from '../src/sarif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = path.resolve(__dirname, '..', 'src', 'checks');
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-full');

const VALID_GRADES = ['mechanical', 'pattern', 'keyword'];

// Authoritative mapping synced with Phase 1A classification at
// `.data/plans/enforcement-grade-classification.md`.
const EXPECTED_GRADES = {
  'mcp-config': 'mechanical',
  'claude-settings': 'mechanical',
  'docker-security': 'mechanical',
  'permissions-hygiene': 'mechanical',
  'env-exposure': 'mechanical',
  'git-hooks': 'mechanical',
  'credential-storage': 'mechanical',
  'infrastructure-security': 'mechanical',
  'documentation': 'mechanical',
  'network-exposure': 'mechanical',
  'site-security': 'mechanical',
  'windows-security': 'mechanical',
  'deep-secrets': 'pattern',
  'unicode-steganography': 'pattern',
  'claude-md': 'pattern',
  'skill-files': 'pattern',
  'coherence': 'keyword',
  'instruction-effectiveness': 'keyword',
  'skill-coherence': 'keyword',
  'workflow-maturity': 'keyword',
};

const LEGEND_SUBSTRING = 'mechanical = deterministic config check';

// -----------------------------------------------------------------------
// 1. Per-check module export test
// -----------------------------------------------------------------------
describe('enforcement-grade: per-check module export', () => {
  // Enumerate check files synchronously at suite-definition time so each
  // module can have its own `it(...)` block and failures name the offender.
  const checkFiles = fs
    .readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js');

  it('discovers at least one check module', () => {
    expect(checkFiles.length).toBeGreaterThan(0);
  });

  for (const file of checkFiles) {
    it(`${file} exports enforcementGrade as a valid grade string`, async () => {
      const mod = await import(path.join(CHECKS_DIR, file));
      const exp = mod.default;
      expect(exp, `${file} has no default export`).toBeTruthy();
      expect(
        typeof exp.enforcementGrade,
        `${file} must declare enforcementGrade: string`,
      ).toBe('string');
      expect(
        VALID_GRADES,
        `${file} enforcementGrade="${exp.enforcementGrade}" is not one of ${VALID_GRADES.join('|')}`,
      ).toContain(exp.enforcementGrade);
    });
  }

  it(`classification matches Phase 1A authoritative table`, async () => {
    for (const file of checkFiles) {
      const mod = await import(path.join(CHECKS_DIR, file));
      const id = mod.default && mod.default.id;
      if (!id || !(id in EXPECTED_GRADES)) continue;
      expect(
        mod.default.enforcementGrade,
        `check id="${id}" expected grade "${EXPECTED_GRADES[id]}"`,
      ).toBe(EXPECTED_GRADES[id]);
    }
  });
});

// -----------------------------------------------------------------------
// Shared scan helper (used by reporter, SARIF, and legend tests)
// -----------------------------------------------------------------------
async function scanFixture() {
  // Empty homedir keeps home-skills discovery from polluting the result.
  const emptyHome = fs.mkdtempSync(path.join(__dirname, '.tmp-home-'));
  try {
    return await scan({ cwd: FIXTURE, homedir: emptyHome });
  } finally {
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// -----------------------------------------------------------------------
// 2. Reporter output — grade tokens on per-check lines
// -----------------------------------------------------------------------
describe('enforcement-grade: reporter output tokens', () => {
  it('fixture exists', () => {
    expect(fs.existsSync(FIXTURE), `missing fixture: ${FIXTURE}`).toBe(true);
  });

  it('terminal output renders a grade token on scored check lines', async () => {
    const result = await scanFixture();
    const plain = stripAnsi(formatTerminal(result, FIXTURE));

    // At least one token of each kind should appear, assuming the fixture
    // activates a mix of check types. The fixture has governance, secret,
    // and coherence surfaces — Phase 0 confirmed it's canonical.
    // Accept both full words and short forms (mech/patt/kwd) per plan §2.
    const hasMech = /\[mech(anical)?\]/.test(plain);
    const hasPatt = /\[patt(ern)?\]/.test(plain);
    const hasKwd = /\[k(eyword|wd)\]/.test(plain);

    expect(hasMech, 'no [mechanical] token found in reporter output').toBe(true);
    expect(hasPatt, 'no [pattern] token found in reporter output').toBe(true);
    expect(hasKwd, 'no [keyword] token found in reporter output').toBe(true);
  });

  it('every per-check line carries a grade token (scored + advisory + N/A)', async () => {
    const result = await scanFixture();
    const plain = stripAnsi(formatTerminal(result, FIXTURE));
    const tokenRe = /\[(mechanical|pattern|keyword|mech|patt|kwd)\]/;

    // Identify per-check lines by the name pad (30 dots ending in a
    // character other than a dot), and assert each contains a grade token.
    // Reporter pads the name with dots; check names contain letters + spaces
    // so lines with ".. " pattern are score lines.
    const scoreLines = plain.split('\n').filter((l) => /\.{5,}/.test(l));
    expect(
      scoreLines.length,
      'expected reporter to emit padded per-check lines',
    ).toBeGreaterThan(0);
    for (const line of scoreLines) {
      expect(
        tokenRe.test(line),
        `reporter line missing grade token: "${line.trim()}"`,
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------
// 3. SARIF per-result property
// -----------------------------------------------------------------------
describe('enforcement-grade: SARIF property', () => {
  it('every SARIF result carries properties.enforcementGrade with a valid value', async () => {
    const result = await scanFixture();
    const sarif = formatSarif(result);
    const results = sarif.runs[0].results;
    expect(results.length, 'SARIF run has no results to assert on').toBeGreaterThan(0);
    for (const r of results) {
      expect(
        r.properties,
        `SARIF result ${r.ruleId} has no properties object`,
      ).toBeTruthy();
      expect(
        VALID_GRADES,
        `SARIF result ${r.ruleId} has invalid enforcementGrade="${r.properties && r.properties.enforcementGrade}"`,
      ).toContain(r.properties.enforcementGrade);
    }
  });
});

// -----------------------------------------------------------------------
// 4. Legend line — present in terminal, suppressed in JSON/SARIF
// -----------------------------------------------------------------------
describe('enforcement-grade: legend line', () => {
  it('terminal output contains the legend line below the score box', async () => {
    const result = await scanFixture();
    const plain = stripAnsi(formatTerminal(result, FIXTURE));
    expect(
      plain.includes(LEGEND_SUBSTRING),
      'reporter terminal output missing enforcement-grade legend',
    ).toBe(true);
  });

  it('JSON output does NOT contain the legend string', async () => {
    const result = await scanFixture();
    const json = formatJson(result);
    expect(json.includes(LEGEND_SUBSTRING)).toBe(false);
  });

  it('JSON output DOES carry enforcementGrade on each check entry (Phase 0 patch)', async () => {
    const result = await scanFixture();
    const parsed = JSON.parse(formatJson(result));
    expect(Array.isArray(parsed.results)).toBe(true);
    for (const r of parsed.results) {
      expect(
        VALID_GRADES,
        `JSON result id=${r.id} enforcementGrade="${r.enforcementGrade}" invalid`,
      ).toContain(r.enforcementGrade);
    }
  });

  it('SARIF output does NOT contain the legend string', async () => {
    const result = await scanFixture();
    const sarif = formatSarif(result);
    const serialized = JSON.stringify(sarif);
    expect(serialized.includes(LEGEND_SUBSTRING)).toBe(false);
  });
});

// -----------------------------------------------------------------------
// 5. Advisory + N/A reporter branches also render the grade column
// -----------------------------------------------------------------------
describe('enforcement-grade: advisory and N/A branches', () => {
  it('advisory (weight-0) reporter branch renders a grade token', () => {
    const mock = {
      score: 80,
      results: [
        {
          id: 'workflow-maturity',
          name: 'Workflow maturity',
          weight: 0,
          score: 85,
          enforcementGrade: 'keyword',
          findings: [{ severity: 'pass', title: 'looks fine' }],
        },
      ],
    };
    const plain = stripAnsi(formatTerminal(mock, '/x'));
    expect(
      /\[(keyword|kwd)\]/.test(plain),
      'advisory branch missing [keyword] grade token',
    ).toBe(true);
    // Advisory marker must still appear alongside the grade.
    expect(plain).toContain('advisory');
  });

  it('N/A reporter branch renders a grade token', () => {
    // NOT_APPLICABLE_SCORE is -1 (per src/constants.js) — avoid importing
    // to keep the test independent; assert on the "N/A" marker instead.
    const mock = {
      score: 80,
      results: [
        {
          id: 'claude-md',
          name: 'CLAUDE.md governance',
          weight: 10,
          score: -1,
          enforcementGrade: 'pattern',
          findings: [],
        },
      ],
    };
    const plain = stripAnsi(formatTerminal(mock, '/x'));
    expect(plain).toContain('N/A');
    expect(
      /\[(pattern|patt)\]/.test(plain),
      'N/A branch missing [pattern] grade token',
    ).toBe(true);
  });

  it('scored branch renders a grade token', () => {
    const mock = {
      score: 80,
      results: [
        {
          id: 'mcp-config',
          name: 'MCP server configuration',
          weight: 14,
          score: 80,
          enforcementGrade: 'mechanical',
          findings: [{ severity: 'pass', title: 'ok' }],
        },
      ],
    };
    const plain = stripAnsi(formatTerminal(mock, '/x'));
    expect(
      /\[(mechanical|mech)\]/.test(plain),
      'scored branch missing [mechanical] grade token',
    ).toBe(true);
  });
});
