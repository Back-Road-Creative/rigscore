import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as YAML from 'yaml';

// Executes the `Run rigscore` step of action.yml (id: scan) with bash, the way
// the runner would: inputs arrive as env vars, the rigscore source sits in
// $GITHUB_WORKSPACE/.rigscore-action-src. action-yml.test.js only checks the
// YAML structure; this file checks what the script actually does.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const action = YAML.parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));
const scanStep = action.runs.steps.find((s) => s.id === 'scan');
const scanScript = scanStep?.run;

const DEFAULT_ENV = {
  SCAN_PATH: '.',
  FAIL_UNDER: '0',
  PROFILE: 'default',
  CHECK: '',
  RECURSIVE: 'false',
  DEPTH: '3',
  DEEP: 'false',
  ONLINE: 'false',
  IGNORE: '',
  BASELINE: '',
};

// A stand-in for bin/rigscore.js: records its argv, prints a canned stdout and
// exits with a canned code, so arg assembly and grade derivation are observable
// without depending on a real scan score.
const STUB_CLI = `
const fs = require('node:fs');
fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.STUB_STDOUT || '');
process.exit(Number(process.env.STUB_CODE || 0));
`;

let tmp;
let workspace;
let runnerTemp;
let githubOutput;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'rigscore-action-run-'));
  workspace = path.join(tmp, 'workspace');
  runnerTemp = path.join(tmp, 'runner-temp');
  githubOutput = path.join(tmp, 'github-output');
  mkdirSync(workspace);
  mkdirSync(runnerTemp);
  writeFileSync(githubOutput, '');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function linkSource(target) {
  symlinkSync(target, path.join(workspace, '.rigscore-action-src'), 'dir');
}

function linkStub() {
  const stubDir = path.join(tmp, 'stub-src');
  mkdirSync(path.join(stubDir, 'bin'), { recursive: true });
  writeFileSync(path.join(stubDir, 'bin', 'rigscore.js'), STUB_CLI);
  linkSource(stubDir);
}

function runScan(envOverrides = {}) {
  const result = spawnSync('bash', ['-c', scanScript], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      NO_COLOR: '1',
      GITHUB_OUTPUT: githubOutput,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      STUB_ARGV_OUT: path.join(tmp, 'argv.json'),
      ...DEFAULT_ENV,
      ...envOverrides,
    },
  });
  const outputs = {};
  for (const line of readFileSync(githubOutput, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  const argvFile = path.join(tmp, 'argv.json');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs,
    argv: existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf8')) : null,
    argsFile: existsSync(path.join(runnerTemp, 'rigscore-args'))
      ? readFileSync(path.join(runnerTemp, 'rigscore-args'), 'utf8')
      : null,
    json: existsSync(path.join(runnerTemp, 'rigscore.json'))
      ? readFileSync(path.join(runnerTemp, 'rigscore.json'), 'utf8')
      : null,
  };
}

describe.skipIf(process.platform === 'win32')('action.yml scan step — executed with bash', () => {
  it('the scan step exists and has a run script', () => {
    expect(scanStep).toBeTruthy();
    expect(typeof scanScript).toBe('string');
    expect(scanScript.length).toBeGreaterThan(0);
  });

  describe('against the real CLI', () => {
    const fixture = path.join(repoRoot, 'test', 'fixtures', 'claude-full');

    it('FAIL_UNDER=0: writes score, grade and exit-code=0 consistent with the JSON', () => {
      linkSource(repoRoot);
      const r = runScan({ SCAN_PATH: fixture, FAIL_UNDER: '0' });
      expect(r.status).toBe(0);
      expect(r.outputs['exit-code']).toBe('0');
      const report = JSON.parse(r.json);
      expect(r.outputs.score).toBe(String(report.score));
      expect(r.outputs.grade).toMatch(/^[ABCDF]$/);
      expect(r.outputs.grade).toBe(report.grade);
      expect(r.stdout).toContain(`rigscore: score ${report.score} (grade ${report.grade}), threshold 0, exit 0`);
      expect(r.stdout).not.toContain('::error::');
    });

    it('FAIL_UNDER=101: a breached threshold yields exit-code=1 with score and grade still set', () => {
      linkSource(repoRoot);
      const r = runScan({ SCAN_PATH: fixture, FAIL_UNDER: '101' });
      expect(r.outputs['exit-code']).toBe('1');
      expect(r.outputs.score).toMatch(/^\d+$/);
      expect(r.outputs.grade).toMatch(/^[ABCDF]$/);
      expect(r.stdout).not.toContain('::error::');
      // The step itself must not fail: the Enforce threshold step owns the gate.
      expect(r.status).toBe(0);
    });

    it('a nonexistent SCAN_PATH yields exit-code >= 2, empty score/grade and an ::error:: line', () => {
      linkSource(repoRoot);
      const r = runScan({ SCAN_PATH: path.join(tmp, 'does-not-exist') });
      expect(Number(r.outputs['exit-code'])).toBeGreaterThanOrEqual(2);
      expect(r.outputs.score).toBe('');
      expect(r.outputs.grade).toBe('');
      expect(r.stdout).toMatch(/^::error::rigscore scan did not complete \(exit \d+\)$/m);
      expect(r.stdout).toContain('score n/a (grade n/a)');
      expect(r.status).toBe(0);
    });
  });

  describe('grade derivation (stubbed CLI)', () => {
    const table = [
      [100, 'A'], [90, 'A'],
      [89, 'B'], [75, 'B'],
      [74, 'C'], [60, 'C'],
      [59, 'D'], [40, 'D'],
      [39, 'F'], [1, 'F'], [0, 'F'],
    ];
    for (const [score, grade] of table) {
      it(`score ${score} -> grade ${grade}`, () => {
        linkStub();
        const r = runScan({ STUB_STDOUT: JSON.stringify({ score }), STUB_CODE: '0' });
        expect(r.outputs.score).toBe(String(score));
        expect(r.outputs.grade).toBe(grade);
        expect(r.outputs['exit-code']).toBe('0');
      });
    }

    it('unparseable JSON leaves score and grade empty but keeps the exit code', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: 'not json at all', STUB_CODE: '1' });
      expect(r.outputs.score).toBe('');
      expect(r.outputs.grade).toBe('');
      expect(r.outputs['exit-code']).toBe('1');
    });

    it('a JSON report without a numeric score leaves score and grade empty', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: JSON.stringify({ score: 'high' }), STUB_CODE: '0' });
      expect(r.outputs.score).toBe('');
      expect(r.outputs.grade).toBe('');
    });

    it('exit code 2 prints the ::error:: line and echoes the head of the output to stderr', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: 'boom: something broke', STUB_CODE: '2' });
      expect(r.outputs['exit-code']).toBe('2');
      expect(r.stdout).toContain('::error::rigscore scan did not complete (exit 2)');
      expect(r.stderr).toContain('boom: something broke');
    });

    it('exit code 1 prints no ::error:: line', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: JSON.stringify({ score: 10 }), STUB_CODE: '1' });
      expect(r.outputs['exit-code']).toBe('1');
      expect(r.stdout).not.toContain('::error::');
    });
  });

  describe('argument assembly (stubbed CLI)', () => {
    const okOut = JSON.stringify({ score: 80 });

    it('defaults: --fail-under and --profile, then --json and the path', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: okOut, SCAN_PATH: 'some/dir', FAIL_UNDER: '70', PROFILE: 'minimal' });
      expect(r.argv).toEqual(['--fail-under', '70', '--profile', 'minimal', '--json', 'some/dir']);
      expect(r.argsFile).toBe('--fail-under\n70\n--profile\nminimal\n');
    });

    it('every optional input set: flags appear in order', () => {
      linkStub();
      const r = runScan({
        STUB_STDOUT: okOut,
        RECURSIVE: 'true',
        DEPTH: '5',
        DEEP: 'true',
        ONLINE: 'true',
        CHECK: 'docker-security',
        IGNORE: 'a,b',
        BASELINE: 'base.json',
      });
      expect(r.argv).toEqual([
        '--fail-under', '0', '--profile', 'default',
        '--recursive', '--depth', '5',
        '--deep', '--online',
        '--check', 'docker-security',
        '--ignore', 'a,b',
        '--baseline', 'base.json',
        '--json', '.',
      ]);
      expect(r.argsFile).not.toContain('--json');
    });

    it('DEPTH is ignored unless RECURSIVE is exactly "true"', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: okOut, RECURSIVE: 'false', DEPTH: '9' });
      expect(r.argv).not.toContain('--recursive');
      expect(r.argv).not.toContain('--depth');
    });

    it('boolean inputs other than the string "true" do not enable their flag', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: okOut, DEEP: 'True', ONLINE: '1', RECURSIVE: 'yes' });
      expect(r.argv).not.toContain('--deep');
      expect(r.argv).not.toContain('--online');
      expect(r.argv).not.toContain('--recursive');
    });

    it('shell metacharacters in inputs reach the CLI as literal arguments and are not executed', () => {
      linkStub();
      const marker = path.join(tmp, 'pwned');
      const evil = `$(touch ${marker}); \`touch ${marker}\` ; touch ${marker} #`;
      const r = runScan({ STUB_STDOUT: okOut, SCAN_PATH: evil, IGNORE: evil, CHECK: evil });
      expect(existsSync(marker)).toBe(false);
      expect(r.argv).toContain(evil);
      expect(r.argv.filter((a) => a === evil)).toHaveLength(3);
    });

    it('a scan path containing spaces stays one argument', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: okOut, SCAN_PATH: 'my project/sub dir' });
      expect(r.argv.at(-1)).toBe('my project/sub dir');
    });

    it('the CLI output goes to $RUNNER_TEMP/rigscore.json, not the step log', () => {
      linkStub();
      const r = runScan({ STUB_STDOUT: okOut });
      expect(r.json).toBe(okOut);
      expect(r.stdout).not.toContain('"score"');
    });
  });
});
