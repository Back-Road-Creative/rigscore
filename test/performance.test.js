import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive } from '../src/scanner.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-perf-'));
}

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

      expect(elapsed).toBeLessThan(5000);
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

      expect(elapsed).toBeLessThan(15000);
      expect(result.projects).toHaveLength(20);
      expect(result.score).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
