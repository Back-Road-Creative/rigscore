import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'rigscore.js');
const fixture = (name) => path.join(__dirname, 'fixtures', name);

describe('CLI integration', () => {
  it('--version prints version', async () => {
    const { stdout } = await exec('node', [bin, '--version']);
    expect(stdout.trim()).toMatch(/^rigscore v\d+\.\d+\.\d+$/);
  });

  it('scans a fixture directory and produces score output', async () => {
    const { stdout } = await exec('node', [bin, fixture('claude-full')], { timeout: 10000 });
    expect(stdout).toContain('HYGIENE SCORE');
    // Should contain a number score
    expect(stdout).toMatch(/\d+\/100/);
  });

  it('--json produces valid JSON to stdout', async () => {
    const { stdout } = await exec('node', [bin, '--json', fixture('claude-full')], { timeout: 10000 });
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('results');
    expect(typeof parsed.score).toBe('number');
  });

  it('--check filters to a single check', async () => {
    const { stdout } = await exec('node', [bin, '--json', '--check', 'env-exposure', fixture('env-clean')], { timeout: 10000 });
    const parsed = JSON.parse(stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe('env-exposure');
  });

  it('bad path produces error', async () => {
    try {
      await exec('node', [bin, '/nonexistent/path/xyz'], { timeout: 10000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.stderr || err.stdout).toContain('not a valid directory');
    }
  });
});

describe('CLI --help', () => {
  it('--help prints usage info', async () => {
    const { stdout } = await exec('node', [bin, '--help']);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--recursive');
    expect(stdout).toContain('--depth');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('--check');
    expect(stdout).toContain('claude-md');
    expect(stdout).toContain('docker-security');
    expect(stdout).toContain('permissions-hygiene');
  });

  it('-h is an alias for --help', async () => {
    const { stdout } = await exec('node', [bin, '-h']);
    expect(stdout).toContain('Usage:');
  });
});
