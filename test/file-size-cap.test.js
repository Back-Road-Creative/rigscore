import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import deepSecrets from '../src/checks/deep-secrets.js';
import { withTmpDir } from './helpers.js';

describe('A5: deep-secrets file size cap', () => {
  it('skips files over the default 512 KB cap and emits INFO', async () => {
    await withTmpDir(async (tmp) => {
      // 1 MB of a secret-looking line. If we were to read this file the
      // scanner would find the secret; asserting no critical means the
      // file was skipped by the size gate.
      const oneMb = Buffer.alloc(
        1024 * 1024,
        'AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP0123456789abcdefghij\n',
      );
      fs.writeFileSync(path.join(tmp, 'big.js'), oneMb);

      // And a small valid file so the deep scan has something to do.
      fs.writeFileSync(path.join(tmp, 'small.js'), 'const x = 1;\n');

      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });

      // Skipped-oversize INFO is emitted.
      const oversizeInfo = result.findings.find(
        (f) => f.severity === 'info' && /skipped \d+ file/i.test(f.title),
      );
      expect(oversizeInfo).toBeTruthy();

      // No critical secret finding attributed to big.js.
      const bigCritical = result.findings.find(
        (f) => f.severity === 'critical' && typeof f.title === 'string' && f.title.includes('big.js'),
      );
      expect(bigCritical).toBeFalsy();
    });
  });

  it('honours config.limits.maxFileBytes override', async () => {
    await withTmpDir(async (tmp) => {
      // 2 KB — would be scanned under default 512 KB, but we lower the cap
      // to 1 KB to force a skip.
      const payload = Buffer.alloc(2 * 1024, 'a');
      fs.writeFileSync(path.join(tmp, 'medium.js'), payload);

      const result = await deepSecrets.run({
        cwd: tmp,
        deep: true,
        config: { limits: { maxFileBytes: 1024 } },
      });

      const info = result.findings.find(
        (f) => f.severity === 'info' && /skipped \d+ file/i.test(f.title),
      );
      expect(info).toBeTruthy();
    });
  });

  it('does not skip files under the cap', async () => {
    await withTmpDir(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'tiny.js'), 'const x = 1;\n');
      const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });
      const oversizeInfo = result.findings.find(
        (f) => f.severity === 'info' && /skipped \d+ file/i.test(f.title),
      );
      expect(oversizeInfo).toBeFalsy();
    });
  });
});
