import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import deepSecrets from '../src/checks/deep-secrets.js';
import { withTmpDir } from './helpers.js';

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

  it('scans a large single-line (minified) file with memory bounded well below file size', async () => {
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
      const fileMb = fs.statSync(file).size / (1024 * 1024);

      if (global.gc) global.gc();
      const base = process.memoryUsage().rss;
      let peak = 0;
      const timer = setInterval(() => {
        const d = process.memoryUsage().rss - base;
        if (d > peak) peak = d;
      }, 5);

      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });

      clearInterval(timer);
      const dEnd = process.memoryUsage().rss - base;
      if (dEnd > peak) peak = dEnd;

      // The minified secret must be detected (streamed, not skipped).
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeTruthy();

      // Memory must NOT scale to file size. readline buffered the whole single
      // line (measured ~83 MB for this 64 MB file); chunk streaming stays far
      // below. Guard against anyone reintroducing readline: peak growth must be
      // under half the file size (in practice it is a few MB).
      expect(peak / (1024 * 1024)).toBeLessThan(fileMb * 0.5);
    });
  });
});
