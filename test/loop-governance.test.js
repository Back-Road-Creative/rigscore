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

  // One level of call resolution: the loop is in the shell, the agent is not.
  describe('indirection', () => {
    it('resolves a Makefile target that shells out to an agent', async () => {
      const result = await run('loop-indirect-make');
      const finding = byId(result, 'loop-governance/uncapped-loop');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
      // The loop lives in the shell script — that is where the fix goes.
      expect(finding.context.file).toMatch(/run-loop\.sh$/);
      // The Makefile is now a scanned script, so its flag is seen too.
      expect(ids(result)).toContain('loop-governance/skip-permissions');
      expect(result.score).toBeLessThan(100);
    });

    it('resolves an npm script named on a cron line', async () => {
      const result = await run('loop-indirect-npm');
      const finding = byId(result, 'loop-governance/uncapped-cron');
      expect(finding).toBeDefined();
      expect(finding.context.file).toBe('crontab');
      expect(result.data.cronJobs).toBe(1);
    });

    it('resolves a python subprocess wrapper driven by a shell loop', async () => {
      const result = await run('loop-indirect-python');
      expect(ids(result)).toContain('loop-governance/uncapped-loop');
      expect(byId(result, 'loop-governance/uncapped-loop').context.file).toMatch(/drive\.sh$/);
    });

    it('stays silent when the loop around the indirect agent is bounded', async () => {
      const result = await run('loop-indirect-capped');
      expect(result.findings.every((f) => f.severity === 'pass')).toBe(true);
      expect(result.score).toBe(100);
      expect(result.data.agentLoops).toBe(1);
    });

    // Second hop: the loop runs `make agent`, whose recipe runs a script, which
    // runs the agent. One hop of resolution leaves the agent invisible.
    it('resolves a second hop — a make target that runs a script that runs the agent', async () => {
      const result = await run('loop-indirect-second-hop');
      const finding = byId(result, 'loop-governance/uncapped-loop');
      expect(finding).toBeDefined();
      // The loop is in the shell script — two files from the agent.
      expect(finding.context.file).toMatch(/run-loop\.sh$/);
      expect(result.score).toBeLessThan(100);
    });

    // A script that calls a script that calls the first one must terminate, not
    // recurse — and the agent behind the cycle is still resolved.
    it('terminates on a call cycle and still resolves the agent behind it', async () => {
      const result = await run('loop-indirect-cycle');
      const finding = byId(result, 'loop-governance/uncapped-loop');
      expect(finding).toBeDefined();
      expect(finding.context.file).toMatch(/run\.sh$/);
    });
  });

  // A loop written *inside* the indirection target: the make target's call is
  // resolved, but the `while True:` lives in the module's own control flow.
  it('reads a `while True:` written inside the Python module a make target invokes', async () => {
    const result = await run('loop-python-while');
    const uncapped = byId(result, 'loop-governance/uncapped-loop');
    expect(uncapped).toBeDefined();
    // The loop is in the module — that is where the bound goes.
    expect(uncapped.context.file).toMatch(/loop_agent\.py$/);
    expect(uncapped.evidence).toContain('while True');
    expect(ids(result)).toContain('loop-governance/no-stop-condition');
    expect(result.data.agentLoops).toBe(1);
  });

  // Same shape, one language over: the npm script's call is resolved, but the
  // loop lives in the `.js` runner's own control flow — and the agent is two
  // hops past it (`./scripts/agent.sh` → `claude -p`), so no loop the old
  // check could read ever held an agent invocation.
  it('reads `for (;;)` / `while (true)` / `do … while (1)` inside the JS runner an npm script invokes', async () => {
    const result = await run('loop-js-while');
    const uncapped = result.findings.filter((f) => f.findingId === 'loop-governance/uncapped-loop');
    // One finding per file — three runners, three loops, three findings.
    expect(uncapped.map((f) => f.context.file).sort()).toEqual([
      'scripts/poll.mjs', 'scripts/runner.js', 'scripts/watch.cjs',
    ]);
    expect(uncapped.every((f) => f.severity === 'warning')).toBe(true);
    // The bound goes in the runner, so the evidence is its loop header.
    expect(uncapped.find((f) => f.context.file === 'scripts/runner.js').evidence).toContain('for (;;)');
    expect(ids(result)).toContain('loop-governance/no-stop-condition');
    expect(result.data.agentLoops).toBe(3);
    expect(result.score).toBeLessThan(100);
  });

  it('stays silent on a `for (const task of tasks)` runner — bounded by construction', async () => {
    const result = await run('loop-js-bounded');
    expect(ids(result)).not.toContain('loop-governance/uncapped-loop');
    expect(ids(result)).not.toContain('loop-governance/no-stop-condition');
    expect(result.findings.every((f) => f.severity === 'pass')).toBe(true);
    expect(result.score).toBe(100);
    expect(result.data.agentLoops).toBe(1);
  });

  // A timer is cron in a different file format: the schedule is one unit, the
  // agent another. Reaching it means pairing the .timer to its .service.
  it('flags a systemd timer whose service runs an unbounded agent, and clears the bounded one', async () => {
    const result = await run('loop-systemd');
    const hits = result.findings.filter((f) => f.findingId === 'loop-governance/uncapped-timer');
    // Both timers drive an agent; only agent.timer's service is unbounded.
    // review.service carries RuntimeMaxSec=900 — a systemd-native bound.
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warning');
    expect(hits[0].context.file).toBe('agent.timer');
    expect(hits[0].evidence).toContain('claude -p');
    expect(result.data.timerJobs).toBe(2);
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
