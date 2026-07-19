import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive } from '../src/scanner.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-perf-'));
}

// Windows CI runners spawn processes and touch the filesystem several times
// slower than ubuntu/macOS — the same asymmetry vitest.config.js scales test
// and hook timeouts 3x for (#371). These are wall-clock perf gates, so runner
// slowness lands directly on the assertion: a 20-project scan that finishes
// well under 15s on a healthy runner crossed it on a loaded windows leg
// (measured — the suite ran 1.6x slow), reddening a now-BLOCKING leg on a PR
// that changed no scanner code. Scale the tight budgets by the same 3x so the
// gate keeps catching a real algorithmic regression (which is multiplicative)
// without flaking on ordinary runner variance. Only the tight budgets need it;
// the 30s skill-file budget is already generous enough to never bind.
const WIN = process.platform === 'win32';
const perf = (ms) => (WIN ? ms * 3 : ms);

describe('performance', () => {
  it('scans project with 100+ YAML files under 5s', async () => {
    const tmpDir = makeTmpDir();
    try {
      // Create package.json to mark as project
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

      // Create 100+ YAML files in k8s/ directory
      const k8sDir = path.join(tmpDir, 'k8s');
      fs.mkdirSync(k8sDir);
      for (let i = 0; i < 110; i++) {
        const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: pod-${i}
spec:
  containers:
    - name: app-${i}
      image: nginx:latest
      resources:
        limits:
          memory: "128Mi"
`;
        fs.writeFileSync(path.join(k8sDir, `pod-${i}.yaml`), manifest);
      }

      const start = Date.now();
      const result = await scan({ cwd: tmpDir, homedir: '/tmp/nonexistent' });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(perf(5000));
      expect(result.score).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scans project with 50+ skill files under 30s', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

      // Create skill directory with 50+ files
      const skillDir = path.join(tmpDir, '.claude', 'commands');
      fs.mkdirSync(skillDir, { recursive: true });
      for (let i = 0; i < 55; i++) {
        fs.writeFileSync(
          path.join(skillDir, `command-${i}.md`),
          `# Command ${i}\nDo something useful for task ${i}.\nUse TypeScript conventions.\n`,
        );
      }

      const start = Date.now();
      const result = await scan({ cwd: tmpDir, homedir: '/tmp/nonexistent' });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(30000);
      expect(result.score).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // Explicit per-test timeout (below): without it the test inherits vitest's
  // default, which is BELOW this test's own assertion ceiling — so under load
  // vitest aborts before `elapsed < perf(15000)` can ever be evaluated, turning
  // a real perf regression signal into a load-sensitive flake. The timeout is
  // set to twice the scaled assertion budget on every platform, so the framework
  // can never fire before the assertion does — the assertion stays the gate.
  it('recursive scan with 20 projects under 15s', async () => {
    const tmpDir = makeTmpDir();
    try {
      for (let i = 0; i < 20; i++) {
        const projDir = path.join(tmpDir, `project-${i}`);
        fs.mkdirSync(projDir);
        fs.writeFileSync(path.join(projDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), `# Project ${i} Rules\nBe safe.\n`);
      }

      const start = Date.now();
      const result = await scanRecursive({ cwd: tmpDir, depth: 1 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(perf(15000));
      expect(result.projects).toHaveLength(20);
      expect(result.score).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }, perf(15000) * 2);
});
