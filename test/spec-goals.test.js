import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/spec-goals.js';
import { loadConfig } from '../src/config.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const at = (cwd, config = {}) => ({ cwd, homedir: '/tmp/nohome', config });
const ctx = (name) => at(path.join(__dirname, 'fixtures', name));
const find = (r, id) => r.findings.find((f) => f.findingId === id);

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

/**
 * Materialise a complete spec-kit tree in `root`. When `goalDate` is given,
 * back it with real git history: the goal file lands on `goalDate`, the specs
 * on `specDate`. No dates → files on disk with no `.git` at all.
 *
 * `stale` additionally commits two specs at that older date — one unfinished
 * (no `tasks.md`) and one finished — so a test can prove staleness flags the
 * abandoned spec while leaving the equally-old *finished* one alone.
 */
function specKitRepo(root, { goalDate, specDate, stale } = {}) {
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
  if (stale) {
    w('specs/002-abandoned/spec.md', '# Abandoned\n');
    w('specs/003-shipped/spec.md', '# Shipped\n');
    w('specs/003-shipped/tasks.md', '- [x] done\n');
    g(['add', 'specs/002-abandoned', 'specs/003-shipped'], stale);
    g(['commit', '-q', '-m', 'old specs'], stale);
  }
  g(['add', '-A'], specDate);
  g(['commit', '-q', '-m', 'specs'], specDate);
}

/** Write an OpenSpec change dir with the given tasks.md body. */
function openspecChange(root, name, tasks) {
  const dir = path.join(root, 'openspec/changes', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(dir, 'design.md'), '# Design\n');
  fs.writeFileSync(path.join(dir, 'tasks.md'), tasks);
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

  it('flags a Kiro requirements file written as prose, and one that mixes strays into EARS', async () => {
    const r = await check.run(ctx('spec-goals-kiro'));
    const notEars = r.findings.filter((f) => f.findingId === 'spec-goals/requirements-not-ears');
    // 001-login and 002-crash are already EARS ("WHEN … THE SYSTEM SHALL …") — they never fire.
    expect(notEars.map((f) => f.context.specDir)).toEqual([
      '.kiro/specs/003-prose',
      '.kiro/specs/004-mixed',
    ]);
    expect(notEars[0].severity).toBe('info');
    expect(notEars[0].context.earsCount).toBe(0);
    // 004-mixed has one real EARS line and one stray ("Refunds must be quick.").
    expect(notEars[1].context.earsCount).toBe(1);
    expect(notEars[1].context.nonEars[0]).toContain('Refunds must be quick');
  });

  it('audits OpenSpec living specs: a hollow domain spec, and a requirement carrying no scenario', async () => {
    const r = await check.run(ctx('spec-goals-openspec'));
    const gaps = r.findings.filter((f) => f.findingId === 'spec-goals/domain-spec-incomplete');
    // billing is complete (Purpose + Requirement + Scenario) — only auth and payments fire.
    expect(gaps.map((f) => f.context.specDir)).toEqual([
      'openspec/specs/auth',
      'openspec/specs/payments',
    ]);
    expect(gaps[0].severity).toBe('info');
    expect(gaps[0].context.missing).toContain('a `## Purpose` section');
    expect(gaps[0].context.missing).toContain('at least one `### Requirement:`');
    expect(gaps[1].context.missing).toEqual(['a `#### Scenario:` under "Card Capture"']);
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

  it('honours a tuned drift window, and falls back to 90 days on a junk value', async () => {
    await withTmpDir(async (tmp) => {
      // A 59-day gap: silent under the 90-day default, loud under a 30-day window.
      specKitRepo(tmp, { goalDate: daysAgo(60), specDate: daysAgo(1) });
      expect(find(await check.run(at(tmp)), 'spec-goals/goal-file-stale')).toBeUndefined();

      const tuned = find(
        await check.run(at(tmp, { specGoals: { driftWindowDays: 30 } })),
        'spec-goals/goal-file-stale',
      );
      expect(tuned?.severity).toBe('info');
      expect(tuned.context.thresholdDays).toBe(30);

      // Non-positive / non-integer values are dropped, not honoured.
      const junk = await check.run(at(tmp, { specGoals: { driftWindowDays: 0 } }));
      expect(find(junk, 'spec-goals/goal-file-stale')).toBeUndefined();
      expect(junk.data.driftWindowDays).toBe(90);
    });
  });

  it('merges specGoals.driftWindowDays from .rigscorerc.json instead of dropping it', async () => {
    await withTmpDir(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, '.rigscorerc.json'),
        JSON.stringify({ specGoals: { driftWindowDays: 45 } }),
      );
      const config = await loadConfig(tmp, null);
      expect(config.specGoals.driftWindowDays).toBe(45);
    });
  });

  it('flags an unfinished spec the tree left behind, but not a finished one of the same age', async () => {
    await withTmpDir(async (tmp) => {
      specKitRepo(tmp, { goalDate: daysAgo(400), specDate: daysAgo(1), stale: daysAgo(300) });
      const r = await check.run(at(tmp));
      const abandoned = r.findings.filter((f) => f.findingId === 'spec-goals/spec-abandoned');
      // 003-shipped is just as old but complete — done, not abandoned.
      expect(abandoned.map((f) => f.context.specDir)).toEqual(['specs/002-abandoned']);
      expect(abandoned[0].severity).toBe('info');
      expect(abandoned[0].context.gapDays).toBeGreaterThanOrEqual(90);
      expect(abandoned[0].context.missing).toEqual(['tasks.md']);
    });
  });

  it('flags an OpenSpec change whose tasks are all ticked but was never archived', async () => {
    await withTmpDir(async (tmp) => {
      openspecChange(tmp, 'add-auth', '- [x] ship it\n- [x] write docs\n');
      openspecChange(tmp, 'add-billing', '- [x] schema\n- [ ] still in flight\n');
      const r = await check.run(at(tmp));
      const unarchived = r.findings.filter((f) => f.findingId === 'spec-goals/change-unarchived');
      // add-billing still has an open task — in flight, not sweepable.
      expect(unarchived.map((f) => f.context.specDir)).toEqual(['openspec/changes/add-auth']);
      expect(unarchived[0].severity).toBe('info');
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
