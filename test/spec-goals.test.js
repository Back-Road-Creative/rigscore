import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/spec-goals.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ctx = (name) => ({ cwd: path.join(__dirname, 'fixtures', name), homedir: '/tmp/nohome', config: {} });
const find = (r, id) => r.findings.find((f) => f.findingId === id);

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
});
