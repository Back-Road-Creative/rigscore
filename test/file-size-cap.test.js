import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import deepSecrets from '../src/checks/deep-secrets.js';
import { withTmpDir } from './helpers.js';

// A5 — per-file size cap. These assertions were INVERTED: they previously
// pinned the fail-open bug (a file over the cap was skipped unread, its
// secret invisible, yet the scan still called itself "clean"). The cap now
// switches large files onto a bounded-memory *streaming* read instead of
// skipping them, so a secret over the cap IS detected and the oversize
// disclosure reads "stream-scanned", not "skipped". The `oversize-skipped`
// finding id is retained for SARIF contract stability.
describe('A5: deep-secrets file size cap (over-cap files are stream-scanned)', () => {
  it('stream-scans files over the default 512 KB cap and STILL finds the secret', async () => {
    await withTmpDir(async (tmp) => {
      // 1 MB of a secret-looking line. This file is over the cap; the scanner
      // now reads it in bounded chunks, so the AWS key IS detected. The key is
      // quoted so the `\b` anchor after AKIA + 16 chars is satisfied (the old
      // fixture appended trailing word chars, which silently broke the match —
      // the previous "would find the secret" comment was inaccurate on two
      // counts: the file was skipped AND the token never matched).
      const oneMb = Buffer.alloc(
        1024 * 1024,
        'const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";\n',
      );
      fs.writeFileSync(path.join(tmp, 'big.js'), oneMb);

      // And a small valid file so the deep scan has something else to do.
      fs.writeFileSync(path.join(tmp, 'small.js'), 'const x = 1;\n');

      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });

      // The honest "stream-scanned" INFO is emitted (same id as before).
      const oversizeInfo = result.findings.find(
        (f) => f.severity === 'info' && /stream-scanned \d+ large file/i.test(f.title),
      );
      expect(oversizeInfo).toBeTruthy();
      expect(oversizeInfo.findingId).toBe('deep-secrets/oversize-skipped');

      // INVERTED: the secret in the over-cap file is now detected as critical.
      const bigCritical = result.findings.find(
        (f) => f.severity === 'critical' && typeof f.title === 'string' && f.title.includes('big.js'),
      );
      expect(bigCritical).toBeTruthy();

      // And the scan must NOT report itself clean when a secret was found.
      const clean = result.findings.find((f) => f.severity === 'pass');
      expect(clean).toBeFalsy();
    });
  });

  it('honours config.limits.maxFileBytes override (over-cap file is stream-scanned)', async () => {
    await withTmpDir(async (tmp) => {
      // 2 KB of filler — would use the plain readFile path under the default
      // 512 KB cap, but we lower the cap to 1 KB to force the streaming path.
      const payload = Buffer.alloc(2 * 1024, 'a');
      fs.writeFileSync(path.join(tmp, 'medium.js'), payload);

      const result = await deepSecrets.run({
        cwd: tmp,
        deep: true,
        config: { limits: { maxFileBytes: 1024 } },
      });

      const info = result.findings.find(
        (f) => f.severity === 'info' && /stream-scanned \d+ large file/i.test(f.title),
      );
      expect(info).toBeTruthy();
    });
  });

  it('does not emit the stream-scanned notice for files under the cap', async () => {
    await withTmpDir(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'tiny.js'), 'const x = 1;\n');
      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });
      const oversizeInfo = result.findings.find(
        (f) => f.severity === 'info' && /stream-scanned \d+ large file/i.test(f.title),
      );
      expect(oversizeInfo).toBeFalsy();
    });
  });
});
