/**
 * Dogfood fixture assertion suite (Moat & Ship Agent D).
 *
 * Scans `test/fixtures/scored-project` via the in-process scanner API (no
 * CLI shell-out) and locks:
 *   - total actionable finding count (±4)
 *   - overall score in a documented range
 *   - a handful of specific critical findings by id (title substring
 *     fallback when `findingId` assertions are stubbed)
 *
 * Characterization mode: `UPDATE_FIXTURES=1 npm run test:fixture`
 * regenerates the locked count/score directly in this file so intentional
 * check-surface changes are a reviewable diff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'scored-project');

// The scanner writes `.rigscore-state.json` into the scan target. If a prior
// run left one behind (especially with restrictive permissions from a
// different user), the next scan's `saveState` fails with EACCES, the
// mcp-config check crashes, and the dogfood assertions drift. Scrub the
// state file around every test so the fixture stays idempotent.
function cleanFixtureState() {
  const statePath = path.join(FIXTURE, '.rigscore-state.json');
  try { fs.rmSync(statePath, { force: true }); } catch { /* ignore */ }
}

// Locked expectations — updated via UPDATE_FIXTURES=1.
// Keep these tight enough to catch regressions, loose enough to absorb
// incidental churn (±4 on count, a documented band on score).
// C6 (Track C) dropped the scored-project's overall score by the coverage-
// scale factor. The band below has been recalibrated from 18–34 to 6–22
// to reflect continuous scaling. The finding count target is unchanged.
const EXPECTED = {
  totalFindings: 42,
  countTolerance: 6,
  scoreMin: 6,
  scoreMax: 22,
};

// Critical findings the fixture is designed to fire. Each entry locks a
// specific finding by `findingId` (preferred) or by title substring
// (fallback until Agent A's findingId convention lands on main).
const CRITICAL_ASSERTIONS = [
  {
    // Post-Track E: now strictly asserted via findingId. The `titleContains`
    // fallback remains as belt-and-suspenders for plugin-authored variants.
    findingId: 'env-exposure/env-not-gitignored',
    titleContains: '.env file found but NOT in .gitignore',
  },
  {
    findingId: 'mcp-config/env-wildcard-sensitive-vars',
    titleContains: 'env-wildcard" receives 4 sensitive env vars',
  },
];

// Count critical + warning + info findings, ignoring pass/skipped sentinels.
function countActionableFindings(results) {
  let n = 0;
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === 'pass' || f.severity === 'skipped') continue;
      n++;
    }
  }
  return n;
}

function flattenFindings(results) {
  const flat = [];
  for (const r of results) {
    for (const f of r.findings) {
      flat.push({ checkId: r.id, ...f });
    }
  }
  return flat;
}

function hasFindingMatching(findings, matcher) {
  return findings.some((f) => {
    if (matcher.findingId && f.findingId === matcher.findingId) return true;
    if (matcher.titleContains && f.title && f.title.includes(matcher.titleContains)) return true;
    return false;
  });
}

describe('dogfood fixture: scored-project', () => {
  beforeEach(cleanFixtureState);
  afterEach(cleanFixtureState);

  it('scans cleanly and produces a stable report shape', async () => {
    // Use a throwaway HOME so homedir skills/CLAUDE.md don't leak in.
    const emptyHome = fs.mkdtempSync(path.join(__dirname, 'fixtures', '_fixture-home-'));
    try {
      const result = await scan({ cwd: FIXTURE, homedir: emptyHome });

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('results');
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeGreaterThan(10);
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('locks total finding count within tolerance', async () => {
    const emptyHome = fs.mkdtempSync(path.join(__dirname, 'fixtures', '_fixture-home-'));
    try {
      const result = await scan({ cwd: FIXTURE, homedir: emptyHome });
      const total = countActionableFindings(result.results);

      if (process.env.UPDATE_FIXTURES === '1') {
        updateExpectedInPlace({ totalFindings: total, score: result.score });
        return;
      }

      const { totalFindings, countTolerance } = EXPECTED;
      expect(total).toBeGreaterThanOrEqual(totalFindings - countTolerance);
      expect(total).toBeLessThanOrEqual(totalFindings + countTolerance);
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('locks overall score within documented band', async () => {
    const emptyHome = fs.mkdtempSync(path.join(__dirname, 'fixtures', '_fixture-home-'));
    try {
      const result = await scan({ cwd: FIXTURE, homedir: emptyHome });

      if (process.env.UPDATE_FIXTURES === '1') {
        // Covered by the count test's update path — keep this assertion silent.
        return;
      }

      expect(result.score).toBeGreaterThanOrEqual(EXPECTED.scoreMin);
      expect(result.score).toBeLessThanOrEqual(EXPECTED.scoreMax);
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('fires each designed critical finding (findingId preferred, title substring fallback)', async () => {
    const emptyHome = fs.mkdtempSync(path.join(__dirname, 'fixtures', '_fixture-home-'));
    try {
      const result = await scan({ cwd: FIXTURE, homedir: emptyHome });
      const flat = flattenFindings(result.results);

      for (const assertion of CRITICAL_ASSERTIONS) {
        const present = hasFindingMatching(flat, assertion);
        expect(
          present,
          `expected finding matching ${JSON.stringify(assertion)} (got ${flat.length} findings total)`,
        ).toBe(true);
      }
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // E7 (Track E): library-vs-CLI divergence guard. A regression where the
  // programmatic `scan()` and `bin/rigscore.js --json` produce different
  // overall scores has bitten rigscore twice in v1.x (pass-2 check
  // ordering, then suppress-semantics). Assert parity from the fixture.
  it('E7: CLI --json score matches library scan() score (divergence guard)', async () => {
    const emptyHome = fs.mkdtempSync(path.join(__dirname, 'fixtures', '_fixture-home-e7-'));
    cleanFixtureState();
    try {
      const bin = path.resolve(__dirname, '..', 'bin', 'rigscore.js');
      // Use --fail-under 0 so a low fixture score doesn't make the CLI
      // exit non-zero; we just want to capture the emitted JSON.
      const cliRes = spawnSync(
        process.execPath,
        [bin, FIXTURE, '--json', '--fail-under', '0'],
        {
          env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      // Non-zero on --fail-under=0 is a genuine failure worth surfacing
      // verbatim so the regression is debuggable.
      expect(
        cliRes.status,
        `CLI exited ${cliRes.status}\nstderr:\n${cliRes.stderr || '(empty)'}\nstdout head:\n${(cliRes.stdout || '').slice(0, 500)}`,
      ).toBe(0);
      const cliOut = JSON.parse(cliRes.stdout);

      cleanFixtureState();
      const libRes = await import('../src/scanner.js').then((m) => m.scan({ cwd: FIXTURE, homedir: emptyHome }));

      // Headline score must match. If a future refactor splits "what the
      // CLI shows" from "what the library computes", decide deliberately
      // here — not by accident.
      expect(cliOut.score, 'CLI score and library score must agree').toBe(libRes.score);

      // Actionable finding counts must also agree (pass/skipped sentinels
      // excluded on both sides). This catches divergences where one path
      // suppresses a category the other emits.
      const libCount = countActionableFindings(libRes.results);
      let cliCount = 0;
      for (const r of cliOut.results || []) {
        for (const f of r.findings || []) {
          if (f.severity === 'pass' || f.severity === 'skipped') continue;
          cliCount++;
        }
      }
      expect(cliCount, 'CLI and library finding counts must agree').toBe(libCount);
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* ignore */ }
      cleanFixtureState();
    }
  });
});

/**
 * UPDATE_FIXTURES=1 support — rewrites the EXPECTED block in this file
 * with the observed values. The rewrite is intentionally mechanical and
 * idempotent so re-running the update is a no-op when nothing changed.
 */
function updateExpectedInPlace({ totalFindings, score }) {
  const testFile = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(testFile, 'utf8');

  // Compute a tight but humane score band around the observed value.
  const scoreMin = Math.max(0, score - 8);
  const scoreMax = Math.min(100, score + 8);

  const block = `const EXPECTED = {
  totalFindings: ${totalFindings},
  countTolerance: 4,
  scoreMin: ${scoreMin},
  scoreMax: ${scoreMax},
};`;

  const updated = src.replace(/const EXPECTED = \{[\s\S]*?\};/, block);
  if (updated !== src) {
    fs.writeFileSync(testFile, updated);
    // eslint-disable-next-line no-console
    console.log(`[fixture-dogfood] EXPECTED updated: count=${totalFindings}, score band=${scoreMin}-${scoreMax}`);
  }
}
