import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

// Run the CLI with an ISOLATED HOME so the operator's own ~/.claude / ~/.rigscorerc
// cannot pollute a surface-free scan (rigscore reads several HOME paths).
function runIsolated(args, home) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', HOME: home },
  });
}

// ── RS-1: --check canonicalization / comma list / unknown-id diagnostic ──────
describe('RS-1: --check alias, comma list, unknown-id error', () => {
  it('canonicalizes a single deprecated id (claude-md -> governance-docs)', () => {
    expect(parseArgs(['--check', 'claude-md']).checkFilter).toBe('governance-docs');
  });

  it('accepts a comma list, canonicalizing each entry to an array', () => {
    expect(parseArgs(['--check', 'claude-md,docker-security']).checkFilter)
      .toEqual(['governance-docs', 'docker-security']);
  });

  it('a single id stays a string (scanner pass-2 filter compatibility)', () => {
    expect(parseArgs(['--check', 'coherence']).checkFilter).toBe('coherence');
  });

  it('CLI: `--check claude-md` runs governance-docs instead of erroring', async () => {
    await withTmpDir(async (home) => {
      const res = runIsolated(['.', '--check', 'claude-md', '--json', '--fail-under', '0'], home);
      expect(res.status).not.toBe(2);
      const ids = JSON.parse(res.stdout).results.map((r) => r.id);
      expect(ids).toContain('governance-docs');
    });
  });

  it('CLI: an unknown --check id exits 2 with a diagnostic naming valid ids', async () => {
    await withTmpDir(async (home) => {
      const res = runIsolated(['.', '--check', 'no-such-check'], home);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/unknown check id: no-such-check/);
      expect(res.stderr).toMatch(/valid ids:/);
    });
  });

  it('CLI: a pass-2 check inside a comma list warns instead of silently dropping', async () => {
    await withTmpDir(async (home) => {
      const res = runIsolated(['.', '--check', 'coherence,docker-security', '--json', '--fail-under', '0'], home);
      expect(res.status).not.toBe(2); // both ids valid
      expect(res.stderr).toMatch(/coherence cannot be combined in a --check list/);
    });
  });
});

// ── RS-13: CLI strictness ────────────────────────────────────────────────────
describe('RS-13: CLI strictness', () => {
  it('--fail-under <non-numeric> is a fatal argError (exit 2)', () => {
    expect(parseArgs(['--fail-under', 'abc']).argError).toMatch(/--fail-under requires a numeric value/);
  });

  it('--fail-under >100 warns (not a silent clamp) but still clamps the value', () => {
    const o = parseArgs(['--fail-under', '150']);
    expect(o.failUnder).toBe(100);
    expect(o.warnings.join('\n')).toMatch(/out of range/);
  });

  it('--depth <non-numeric> is fatal AND does NOT flip recursive on', () => {
    const o = parseArgs(['--depth', 'abc']);
    expect(o.argError).toMatch(/--depth requires a numeric value/);
    expect(o.recursive).toBe(false);
  });

  it('CLI: conflicting output formats warn, naming the winner', async () => {
    await withTmpDir(async (home) => {
      const res = runIsolated(['.', '--sarif', '--json'], home);
      expect(res.stderr).toMatch(/multiple output formats requested/);
      expect(res.stderr).toMatch(/emitting --sarif/);
    });
  });

  it('CLI: a dead PROJECT suppress warns; a dead HOME suppress does not', async () => {
    await withTmpDir(async (home) => {
      await withTmpDir(async (project) => {
        // Home rc carries a cross-project suppression that matches nothing here.
        fs.writeFileSync(path.join(home, '.rigscorerc.json'),
          JSON.stringify({ suppress: ['home-only/never-matches'] }));
        const homeScan = runIsolated([project], home);
        expect(homeScan.stderr).not.toMatch(/home-only\/never-matches/);

        // Project rc carries a dead suppression — THAT one is worth flagging.
        fs.writeFileSync(path.join(project, '.rigscorerc.json'),
          JSON.stringify({ suppress: ['proj-only/never-matches'] }));
        const projScan = runIsolated([project], home);
        expect(projScan.stderr).toMatch(/proj-only\/never-matches/);
      });
    });
  });
});

// ── RS-32: --quiet summary-only ──────────────────────────────────────────────
describe('RS-32: --quiet summary-only mode', () => {
  it('emits a compact summary, not the full per-check report', async () => {
    await withTmpDir(async (home) => {
      const full = runIsolated(['.', '--no-color'], home);
      const quiet = runIsolated(['.', '--no-color', '--quiet'], home);
      expect(quiet.stdout).toMatch(/rigscore \d+\/100 \(Grade [A-F]\)/);
      expect(quiet.stdout).toMatch(/critical \d+/);
      expect(quiet.stdout.length).toBeLessThan(full.stdout.length);
    });
  });
});

// ── RS-14: nothing-to-scan + Posture label ───────────────────────────────────
describe('RS-14: surface-free dir reports "nothing to scan", not Grade F', () => {
  it('an empty dir is n/a and exits 0, never 12/100 Grade F exit 1', async () => {
    await withTmpDir(async (home) => {
      await withTmpDir(async (empty) => {
        const res = runIsolated([empty, '--no-color'], home);
        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/HYGIENE SCORE: n\/a/);
        expect(res.stdout).not.toMatch(/Grade: F/);
      });
    });
  });

  it('the hardening tier is labelled "Posture:", never "Risk:"', async () => {
    await withTmpDir(async (home) => {
      fs.writeFileSync(path.join(home, 'Dockerfile'), 'FROM node:20\n'); // a real finding → real score
      const res = runIsolated([home, '--no-color', '--fail-under', '0'], home);
      expect(res.stdout).toMatch(/Posture:/);
      expect(res.stdout).not.toMatch(/Risk:/);
    });
  });
});

// ── Help text: init --merge/--harden + the new flags are documented ──────────
describe('help text documents init --merge/--harden and new flags', () => {
  const help = spawnSync('node', [BIN, '--help'], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } }).stdout;
  it('documents init --merge and its --harden alias', () => {
    expect(help).toMatch(/init --<pack> --merge/);
    expect(help).toMatch(/--harden/);
  });
  it('documents the new output/scan flags', () => {
    for (const flag of ['--junit', '--code-quality', '--quiet', '--trend', '--record-score', '--badge-format']) {
      expect(help, `help missing ${flag}`).toContain(flag);
    }
  });
});
