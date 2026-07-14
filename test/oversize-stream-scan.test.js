import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import deepSecrets from '../src/checks/deep-secrets.js';
import { withTmpDir } from './helpers.js';

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mem-probe.mjs');

// Run one read strategy over the fixture in a FRESH process and return its peak
// RSS growth. Both arms are measured by the same instrument in the same way, so
// the comparison between them is meaningful even though RSS on its own is not.
function probe(mode, dir) {
  return JSON.parse(
    execFileSync(process.execPath, [PROBE, mode, dir], { encoding: 'utf-8' }),
  );
}

// The historical bug: a file over `limits.maxFileBytes` was never opened, yet
// deep-secrets still emitted the PASS "Deep scan clean" finding — a tree
// holding a live key scored 98. The fix streams every candidate file in
// bounded-memory chunks, so "clean" is true by construction. These tests pin
// (a) that a secret over the cap is detected and the scan is NOT called clean,
// and (b) that a minified single-line file is scanned without memory scaling
// to file size (the reason readline was rejected).
describe('deep-secrets: oversize files are stream-scanned, not skipped', () => {
  it('detects a critical secret in a file OVER the size cap and does not report clean', async () => {
    await withTmpDir(async (tmp) => {
      // Built dynamically so this test source is not itself flagged.
      const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // AKIA + 16 chars = AWS access key
      // ~648 KB of filler (over the 512 KB cap AND the 256 KB internal chunk,
      // so the secret lands 3 chunks in), then the secret on line 8001.
      const filler = ('// ' + 'x'.repeat(77) + '\n').repeat(8000);
      fs.writeFileSync(path.join(tmp, 'bundle.js'), filler + `const KEY = "${awsKey}";\n`);
      fs.writeFileSync(path.join(tmp, 'small.js'), 'const x = 1;\n');

      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });

      const bigCritical = result.findings.find(
        (f) => f.severity === 'critical' && typeof f.title === 'string' && f.title.includes('bundle.js'),
      );
      expect(bigCritical).toBeTruthy();
      // Line number recovered by counting newlines across chunk boundaries.
      expect(bigCritical.title).toContain('bundle.js:8001');

      // The scan must NOT call itself clean when a candidate file held a secret.
      const clean = result.findings.find((f) => f.severity === 'pass');
      expect(clean).toBeFalsy();

      // A critical zeroes the check score.
      expect(result.score).toBe(0);

      // The oversize disclosure is now an honest "stream-scanned" info, same id.
      const streamInfo = result.findings.find(
        (f) => f.severity === 'info' && /stream-scanned/i.test(f.title),
      );
      expect(streamInfo).toBeTruthy();
      expect(streamInfo.findingId).toBe('deep-secrets/oversize-skipped');
    });
  });

  // The INVARIANT here is unchanged and still enforced: deep-secrets must
  // CHUNK-STREAM a huge file, never readline it / buffer it whole (a readline
  // regression OOM'd, which is why this test exists). Only the INSTRUMENT changed.
  //
  // The old instrument sampled process-wide RSS and compared the peak growth to a
  // fixed `0.5 * fileMb` constant. RSS carries allocator slack and GC timing noise:
  // roughly 26 of the ~32 MB it "measured" was noise, not the scan's working set.
  // It therefore sat a hair under its own bound and flaked in CI at 32.34 MB vs a
  // 31.97 MB threshold — on a PR that touched neither deep-secrets.js nor utils.js,
  // and which passed on re-run. Widening that multiplier was rejected: it erodes the
  // very guard the OOM bought and only relocates the flake.
  //
  // The instrument is now RELATIVE. Both read strategies run over the SAME fixture,
  // measured the SAME way, each in its own fresh process, and the assertion is on the
  // RATIO. readline's peak scales with FILE SIZE; chunk-streaming's does not — that
  // is the actual invariant. Allocator and GC noise now lands in BOTH arms and
  // cancels, instead of accumulating against a fixed bound, so the assertion is
  // self-calibrating across platforms, Node versions and GC modes.
  it('scans a large single-line (minified) file in memory that does not scale with file size', { timeout: 60_000 }, async () => {
    await withTmpDir(async (tmp) => {
      const SIZE_MB = 64;
      const awsKey = 'AKIA' + 'QRSTUVWXYZ012345';
      const file = path.join(tmp, 'app.min.js');
      const fd = fs.openSync(file, 'w');
      const chunk = 'x'.repeat(64 * 1024); // 64 KB, ZERO newlines
      for (let i = 0; i < SIZE_MB * 16 - 1; i++) fs.writeSync(fd, chunk);
      // Secret near the END so the scan must stream the whole file to find it.
      fs.writeSync(fd, 'x'.repeat(1000) + `const KEY="${awsKey}";` + 'x'.repeat(1000));
      fs.closeSync(fd);

      const subject = probe('chunk', tmp); // the real check
      const control = probe('readline', tmp); // the rejected strategy, same fixture

      // The minified secret must still be detected (streamed, not skipped).
      expect(subject.detail).toBe(1);
      // Sanity-check the control is a real control: readline did buffer the whole
      // ~64 MB single line, so it is genuinely the memory profile we must stay under.
      expect(control.detail).toBeGreaterThan(SIZE_MB * 1024 * 1024 * 0.9);
      // Control arm cost, so CI stays sane: one short-lived process, ~0.25s, ~105 MB
      // peak RSS — it is cheaper than the subject arm it calibrates.

      // Measured locally: chunk ~26 MB vs readline ~106 MB on a 64 MB file => ~0.25.
      // Reintroducing readline makes the two arms the SAME strategy, driving the
      // ratio to ~1.0, so 0.5 is a 2x margin — not the 1.01x the old bound had.
      const ratio = subject.peakRssBytes / control.peakRssBytes;
      expect(ratio).toBeLessThan(0.5);
    });
  });
});
