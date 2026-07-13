/**
 * Q1 — `suppress:` must not be inert in --recursive/monorepo mode.
 * Q2 — `--check <N/A here>` must report not-applicable / exit 0, not 0/F/exit 1.
 * Both run the real CLI with a throwaway $HOME so a dev box's home can't leak in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsi } from '../src/reporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');
const SUPPRESSED_ID = 'mcp-config/unpinned-npx-package';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function run(args) {
  return spawnSync('node', [BIN, ...args, '--no-state-write'], {
    encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', HOME: home },
  });
}

describe('Q1: recursive mode honors per-project config suppress:', () => {
  let root, project;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-root-'));
    project = path.join(root, 'svc-a');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"svc-a"}');
    // An unpinned npx MCP server → a WARNING with a stable findingId.
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify(
      { mcpServers: { demo: { command: 'npx', args: ['-y', 'some-mcp-server'] } } }));
    fs.writeFileSync(path.join(project, '.rigscorerc.json'), JSON.stringify({ suppress: [SUPPRESSED_ID] }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('discloses the mute, removes the finding, and rescores to match single-project', () => {
    const single = JSON.parse(run([project, '--json']).stdout);
    expect(single.suppressed.count).toBe(1); // control: single-project always honored it

    const rec = JSON.parse(run([root, '--recursive', '--json']).stdout);
    expect(rec.suppressed).toBeTruthy();
    expect(rec.suppressed.ids).toContain(SUPPRESSED_ID);
    const svc = rec.projects.find((p) => p.path === 'svc-a');
    expect(svc.results.find((r) => r.id === 'mcp-config').findings
      .some((f) => f.findingId === SUPPRESSED_ID)).toBe(false);
    expect(svc.score).toBe(single.score); // report now agrees with the exit code
  });
});

describe('Q2: --check with a check that is N/A for this repo', () => {
  let project;
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-na-'));
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"na"}'); // no Dockerfile
  });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('exits 0 with score null / notApplicable across JSON, human report, and badge', () => {
    const j = JSON.parse(run([project, '--check', 'docker-security', '--json']).stdout);
    expect(j.notApplicable).toBe(true);
    expect(j.score).toBeNull();

    const human = run([project, '--check', 'docker-security']);
    expect(human.status).toBe(0);
    const out = stripAnsi(human.stdout);
    expect(out).toContain('HYGIENE SCORE: n/a');
    expect(out).not.toContain('HYGIENE SCORE: 0/100');
    expect(out).not.toContain('Grade: F');
    expect(out).not.toContain('score scaled'); // no "scaled ×0.00" when nothing scored
    const boxed = out.split('\n').filter((l) => l.startsWith('  │'));
    expect(new Set(boxed.map((l) => l.length)).size).toBe(1); // 38-char box width intact

    const badge = run([project, '--check', 'docker-security', '--badge']);
    expect(badge.stdout).toContain('rigscore-n%2Fa-lightgrey');
    expect(badge.stdout).not.toContain('0%2F100');
  });

  it('scores normally when the check IS applicable, and keeps red on an unknown id', () => {
    fs.writeFileSync(path.join(project, 'Dockerfile'), 'FROM node:20-alpine\nUSER node\n');
    const ok = JSON.parse(run([project, '--check', 'docker-security', '--json', '--fail-under', '0']).stdout);
    expect(ok.notApplicable).toBe(false);
    expect(typeof ok.score).toBe('number');

    // A typo'd --check id must NOT silently go green.
    const typo = run([project, '--check', 'no-such-check-id', '--json']);
    expect(typo.status).toBe(1);
    expect(JSON.parse(typo.stdout).score).toBe(0);
  });
});
