import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/loop-governance.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function run(name) {
  const cwd = fixture(name);
  return check.run({ cwd, homedir: cwd, config: {} });
}

const ids = (result) => result.findings.map((f) => f.findingId);
const byId = (result, id) => result.findings.find((f) => f.findingId === id);

describe('loop-governance check', () => {
  it('has the required check shape', () => {
    expect(check.id).toBe('loop-governance');
    expect(check.name).toBe('Loop governance');
    expect(check.category).toBe('process');
    expect(check.enforcementGrade).toBe('pattern');
    expect(typeof check.run).toBe('function');
  });

  it('flags `while true; do claude -p ...; done` as an uncapped agent loop', async () => {
    const result = await run('loop-uncapped');
    const finding = byId(result, 'loop-governance/uncapped-loop');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
    expect(finding.context.file).toMatch(/run-agent\.sh$/);
    expect(result.score).toBeLessThan(100);
  });

  it('passes a loop with an iteration cap, and ignores a loop with no agent in it', async () => {
    const result = await run('loop-capped');
    expect(ids(result)).not.toContain('loop-governance/uncapped-loop');
    expect(result.findings.every((f) => f.severity === 'pass')).toBe(true);
    expect(result.score).toBe(100);
    // The fixture's uncapped `while true; do sleep 60; done` has no agent — not a loop we own.
    expect(result.data.agentLoops).toBe(1);
  });

  it('flags --dangerously-skip-permissions in a script with no loop at all', async () => {
    const result = await run('loop-skip-permissions');
    const finding = byId(result, 'loop-governance/skip-permissions');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
    // A one-shot agent call is not a loop — the loop finding must stay silent.
    expect(ids(result)).not.toContain('loop-governance/uncapped-loop');
  });

  // CI agent jobs (.github/workflows) are the `ci-agent-caps` check's surface.
  // Flagging them here too would double-deduct on the Practice axis.
  it('ignores .github/workflows entirely', async () => {
    const result = await run('loop-ci-out-of-scope');
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toEqual([]);
  });

  it('returns N/A on a repo with no agent-loop surface at all', async () => {
    const result = await run('vanilla-rust');
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toEqual([]);
  });

  describe('no-stop-condition', () => {
    it('flags an unconditional loop whose body decides nothing — even when capped', async () => {
      const result = await run('loop-no-stop');
      const finding = byId(result, 'loop-governance/no-stop-condition');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
      expect(finding.context.file).toMatch(/run-agent\.sh$/);
      // --max-turns bounds the spend, so the cost finding must stay silent:
      // the two findings are orthogonal, and only this one applies.
      expect(ids(result)).not.toContain('loop-governance/uncapped-loop');
      expect(result.score).toBeLessThan(100);
    });

    it('stays silent when the body evaluates anything at all (break / grep -q / -f sentinel)', async () => {
      const result = await run('loop-stop-guarded');
      expect(ids(result)).not.toContain('loop-governance/no-stop-condition');
      expect(result.findings.every((f) => f.severity === 'pass')).toBe(true);
    });

    it('stays silent on a conditional header, and on an unconditional loop with no agent', async () => {
      // loop-capped holds `while [ "$i" -lt "$MAX_ITER" ]` (conditional) and a
      // `while true; do sleep 60; done` (unconditional, but no agent in it).
      const result = await run('loop-capped');
      expect(ids(result)).not.toContain('loop-governance/no-stop-condition');
    });
  });

  describe('cron', () => {
    it('flags an agent on a cron line with nothing bounding the tick', async () => {
      const result = await run('cron-agent-uncapped');
      const finding = byId(result, 'loop-governance/uncapped-cron');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
      expect(finding.context.file).toBe('crontab');
      expect(finding.evidence).toContain('claude -p');
      // The commented-out cron line must not count as a second job.
      expect(result.data.cronJobs).toBe(1);
    });

    it('passes a capped cron agent across `*.cron` and `*.crontab`', async () => {
      const result = await run('cron-agent-capped');
      expect(ids(result)).not.toContain('loop-governance/uncapped-cron');
      expect(result.findings.every((f) => f.severity === 'pass')).toBe(true);
      expect(result.data.cronJobs).toBe(2);
    });

    it('returns N/A on an ordinary crontab with no agent on any line', async () => {
      const result = await run('cron-no-agent');
      expect(result.score).toBe(NOT_APPLICABLE_SCORE);
      expect(result.findings).toEqual([]);
    });
  });
});
