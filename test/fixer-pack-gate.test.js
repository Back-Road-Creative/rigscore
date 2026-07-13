/**
 * `--fix --yes` means "don't prompt me" — it does NOT mean "scaffold governance
 * files I never asked for". Those are two different consents.
 *
 * Pack installs (a whole starter baseline: `.claude/settings.json`, a pre-commit
 * hook) now sit behind their own explicit opt-in, `--install-packs`. `--fix --yes`
 * alone is back to remediating existing red checks and creating no pack file.
 *
 * NOTE: `--fix` writes its report to STDERR, not stdout — assert on res.stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rigscore.js');

const runCli = (args) =>
  spawnSync('node', [BIN, ...args], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });

/** A git repo with no governance files: red on git-hooks, so the `guards` pack applies. */
function redRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-packgate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"packgate"}\n');
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}

let cwd;
const settings = () => path.join(cwd, '.claude', 'settings.json');
const hook = () => path.join(cwd, '.git', 'hooks', 'pre-commit');

beforeEach(() => { cwd = redRepo(); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

describe('--fix --yes never installs a pack', () => {
  it('writes no pack file into a repo that had none', () => {
    runCli([cwd, '--fix', '--yes']);
    expect(fs.existsSync(settings())).toBe(false);
    expect(fs.existsSync(hook())).toBe(false);
  });

  it('offers the pack and names the opt-in flag instead of installing it', () => {
    const res = runCli([cwd, '--fix', '--yes']);
    expect(res.stderr).toContain('guards');
    expect(res.stderr).toContain('--install-packs');
  });
});

describe('--install-packs opts back in', () => {
  it('--fix --yes --install-packs writes the guards baseline', () => {
    const res = runCli([cwd, '--fix', '--yes', '--install-packs']);
    expect(res.stderr).toContain('Installed packs');
    expect(fs.existsSync(settings())).toBe(true);
    expect(fs.existsSync(hook())).toBe(true);
  });

  it('--install-packs without --yes is still a dry run — --yes remains the write gate', () => {
    const res = runCli([cwd, '--fix', '--install-packs']);
    expect(fs.existsSync(settings())).toBe(false);
    expect(res.stderr).toContain('dry run');
  });

  it('parseArgs exposes installPacks, default false', () => {
    expect(parseArgs([]).installPacks).toBe(false);
    expect(parseArgs(['--install-packs']).installPacks).toBe(true);
  });
});
