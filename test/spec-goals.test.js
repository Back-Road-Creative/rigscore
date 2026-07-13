import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/spec-goals.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const at = (cwd) => ({ cwd, homedir: '/tmp/nohome', config: {} });
const ctx = (name) => at(path.join(__dirname, 'fixtures', name));
const find = (r, id) => r.findings.find((f) => f.findingId === id);

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

/**
 * Materialise a complete spec-kit tree in `root`. When `goalDate` is given,
 * back it with real git history: the goal file lands on `goalDate`, the specs
 * on `specDate`. No dates → files on disk with no `.git` at all.
 */
function specKitRepo(root, { goalDate, specDate } = {}) {
  const w = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('.specify/memory/constitution.md', '# Constitution\n\nI. Ship reviewable diffs.\n');
  w('specs/001-example/spec.md', '# Spec\n');
  w('specs/001-example/tasks.md', '- [ ] build it\n');
  if (!goalDate) return;
  const g = (args, date) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  g(['init', '-q'], goalDate);
  g(['add', '.specify'], goalDate);
  g(['commit', '-q', '-m', 'goal'], goalDate);
  g(['add', '-A'], specDate);
  g(['commit', '-q', '-m', 'specs'], specDate);
}

describe('spec-goals check', () => {
  it('has required shape and is advisory (weight 0)', () => {
    expect(check.id).toBe('spec-goals');
    expect(check.name).toBe('Spec goals');
    expect(check.category).toBe('governance');
    expect(check.enforcementGrade).toBe('keyword');
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('returns N/A when the repo has no spec-driven layout', async () => {
    const r = await check.run(ctx('spec-goals-none'));
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.findings).toEqual([]);
  });

  it('passes a complete spec-kit layout with an actionable AGENTS.md', async () => {
    const r = await check.run(ctx('spec-goals-complete'));
    expect(r.findings.every((f) => f.severity === 'pass')).toBe(true);
    expect(r.score).toBe(100);
    expect(r.data.frameworks).toEqual(['spec-kit', 'agents-md']);
  });

  it('flags a placeholder constitution and a spec dir with no tasks artifact', async () => {
    const r = await check.run(ctx('spec-goals-stub-constitution'));
    expect(find(r, 'spec-goals/constitution-placeholder')?.severity).toBe('warning');
    const noTasks = find(r, 'spec-goals/spec-dir-no-tasks');
    expect(noTasks?.severity).toBe('info');
    expect(noTasks.context.specDir).toBe('specs/001-example');
  });

  it('WARNs when .specify/ exists but the constitution file does not', async () => {
    const r = await check.run(ctx('spec-goals-no-constitution'));
    expect(find(r, 'spec-goals/constitution-missing')?.severity).toBe('warning');
  });

  it('flags an AGENTS.md with no runnable setup/test/build command', async () => {
    const r = await check.run(ctx('spec-goals-hollow-agents'));
    expect(find(r, 'spec-goals/agents-md-hollow')?.severity).toBe('info');
  });

  it('reads a Kiro layout, counting bugfix.md as a spec, and flags missing tasks/design', async () => {
    const r = await check.run(ctx('spec-goals-kiro'));
    expect(r.data.frameworks).toContain('kiro');
    expect(find(r, 'spec-goals/spec-dir-no-tasks')?.context.specDir).toBe('.kiro/specs/001-login');
    const noDesign = find(r, 'spec-goals/spec-dir-no-design');
    expect(noDesign?.severity).toBe('info');
    expect(noDesign.context.specDir).toBe('.kiro/specs/002-crash');
  });

  it('reads an OpenSpec layout and never flags archived (shipped) changes', async () => {
    const r = await check.run(ctx('spec-goals-openspec'));
    expect(r.data.frameworks).toContain('openspec');
    const noTasks = r.findings.filter((f) => f.findingId === 'spec-goals/spec-dir-no-tasks');
    expect(noTasks.map((f) => f.context.specDir)).toEqual(['openspec/changes/add-auth']);
    expect(r.findings.some((f) => String(f.context?.specDir || '').includes('archive'))).toBe(false);
  });

  it('INFOs when the goal file sat out a planning cycle the specs kept moving through', async () => {
    await withTmpDir(async (tmp) => {
      specKitRepo(tmp, { goalDate: daysAgo(300), specDate: daysAgo(5) });
      const stale = find(await check.run(at(tmp)), 'spec-goals/goal-file-stale');
      expect(stale?.severity).toBe('info');
      expect(stale.context.file).toBe('.specify/memory/constitution.md');
      expect(stale.context.gapDays).toBeGreaterThanOrEqual(90);
    });
  });

  it('compares relatively: a rebase rewriting every committer date together cannot manufacture drift', async () => {
    await withTmpDir(async (tmp) => {
      specKitRepo(tmp, { goalDate: daysAgo(400), specDate: daysAgo(400) });
      expect(find(await check.run(at(tmp)), 'spec-goals/goal-file-stale')).toBeUndefined();
    });
  });

  it('skips drift — never guesses — with no git history, and in a shallow clone', async () => {
    await withTmpDir(async (tmp) => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      specKitRepo(plain, {});
      expect(find(await check.run(at(plain)), 'spec-goals/goal-file-stale')).toBeUndefined();

      const origin = path.join(tmp, 'origin');
      fs.mkdirSync(origin);
      specKitRepo(origin, { goalDate: daysAgo(300), specDate: daysAgo(1) });
      const shallow = path.join(tmp, 'shallow');
      spawnSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow], { encoding: 'utf8' });
      expect(fs.existsSync(path.join(shallow, '.git', 'shallow'))).toBe(true);
      expect(find(await check.run(at(shallow)), 'spec-goals/goal-file-stale')).toBeUndefined();
    });
  });
});
