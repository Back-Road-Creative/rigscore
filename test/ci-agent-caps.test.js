import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/ci-agent-caps.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);
const run = (cwd) => check.run({ cwd, config: {} });
const ids = (r) => r.findings.map((f) => f.findingId);
const MISSING_ALL = ['ci-agent-caps/agent-job-missing-timeout',
  'ci-agent-caps/agent-job-missing-turn-cap', 'ci-agent-caps/agent-job-missing-tool-scoping'];

// Reusable-workflow repos are built inline, not as fixture dirs: the order-independence
// test needs the same topology twice under different names, and a template writes that
// second copy for free.
async function runWorkflows(files) {
  let result;
  await withTmpDir(async (tmp) => {
    const dir = path.join(tmp, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    result = await run(tmp);
  });
  return result;
}
// The caller holds the caps; the callee holds the agent. Neither file alone is the truth.
const caller = (callee, withBlock = '') => `on: [pull_request]
jobs:
  triage:
    uses: ./.github/workflows/${callee}
${withBlock}`;
const CALLEE = `on:
  workflow_call:
    inputs:
      max_turns: { type: string, required: false }
      allowed_tools: { type: string, required: false }
jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          max_turns: \${{ inputs.max_turns }}
          allowed_tools: \${{ inputs.allowed_tools }}
`;
const CAPS = "    with:\n      max_turns: '5'\n      allowed_tools: Read,Grep\n";

describe('ci-agent-caps', () => {
  it('flags an uncapped Claude action job: no turn cap, no timeout, no tool scoping', async () => {
    const r = await run(fixture('ci-agent-uncapped'));
    expect(ids(r)).toEqual(expect.arrayContaining(MISSING_ALL));
    expect(r.findings.some((f) => f.severity === 'critical')).toBe(false);
    expect(r.score).toBe(55); // three WARNINGs, no CRITICAL
  });
  // Capped fixture also carries `codex exec --sandbox … -a …`: sandbox + approval policy IS codex's tool
  // scoping, and codex documents no turn-cap flag to demand.
  it('passes a fully capped agent job (Claude action + codex run step)', async () => {
    const r = await run(fixture('ci-agent-capped'));
    expect(r.findings.map((f) => f.severity)).toEqual(['pass']);
    expect(r.score).toBe(100);
  });
  it('flags a run: step agent CLI invocation and its permission bypass', async () => {
    const r = await run(fixture('ci-agent-cli'));
    expect(ids(r)).toEqual(
      expect.arrayContaining(['ci-agent-caps/agent-permission-bypass', ...MISSING_ALL]),
    );
    const bypass = r.findings.find((f) => f.findingId === 'ci-agent-caps/agent-permission-bypass');
    expect(bypass.severity).toBe('critical');
    expect(r.score).toBe(0);
  });
  // Neither vendor documents a turn cap or a tool-scoping flag (docs page cites the pages checked),
  // so both are graded on timeout-minutes alone — inventing the other two findings would be unfixable
  // noise. aider's `--yes` is its own docs' prescribed scripted form and gh's `--auto` collides with
  // `gh pr merge --auto`: neither is a bypass, exactly as gemini's `-y` is not.
  it('grades aider and opencode run on timeout-minutes alone, with no invented findings', async () => {
    const r = await run(fixture('ci-agent-aider-opencode'));
    expect(r.data.agentJobs).toBe(2);
    expect(ids(r)).toEqual(['ci-agent-caps/agent-job-missing-timeout']);
    expect(r.findings[0].title).toContain('job "aider"');
    expect(r.score).toBe(85); // one WARNING: the capped opencode job contributes nothing
  });
  it('returns N/A with no agent job, and with no workflows at all', async () => {
    const noAgent = await run(fixture('ci-no-agent'));
    expect(noAgent).toEqual({ score: NOT_APPLICABLE_SCORE, findings: [], data: { agentJobs: 0 } });
    await withTmpDir(async (tmp) => {
      const noWorkflows = await run(tmp);
      expect(noWorkflows.score).toBe(NOT_APPLICABLE_SCORE);
      expect(noWorkflows.findings).toEqual([]);
    });
  });
  it('reports N/A on rigscore itself — its own CI runs no agent', async () => {
    const r = await run(path.resolve(__dirname, '..'));
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.findings).toEqual([]);
  });

  // The caps are `${{ inputs.* }}` and the caller passes none, so at runtime the action
  // gets an empty max_turns and an empty allow-list. Read standalone the callee looks
  // capped (a non-empty string sits in both inputs) and the check CERTIFIES it: 100/100,
  // "declares a turn cap". Only the call site says otherwise.
  it('follows a local reusable-workflow call: caps the caller never passes are missing', async () => {
    const r = await runWorkflows({ 'ci.yml': caller('agent.yml'), 'agent.yml': CALLEE });
    expect(ids(r)).toEqual(expect.arrayContaining([
      'ci-agent-caps/agent-job-missing-turn-cap', 'ci-agent-caps/agent-job-missing-tool-scoping']));
    expect(r.findings.some((f) => f.severity === 'critical')).toBe(false);
    // Named at the callee — where the invocation is, and where a default would fix it —
    // and it cites the caller, the other place the operator can pass the cap.
    expect(r.findings[0].title).toBe('agent.yml job "agent" (called by ci.yml job "triage") '
      + 'runs anthropics/claude-code-action@v1 with no turn cap');
  });
  // The whole command is an input, so nothing in either file matches an agent pattern
  // until the call site is resolved: the repo reports N/A — "no agent in CI" — while
  // running an uncapped claude on every PR.
  it('follows a call site whose input IS the agent command', async () => {
    const r = await runWorkflows({
      'ci.yml': `on: [pull_request]\njobs:\n  triage:\n    uses: ./.github/workflows/agent.yml\n`
        + '    with:\n      cmd: claude -p "triage the failing build"\n',
      'agent.yml': 'on:\n  workflow_call:\n    inputs:\n      cmd: { type: string, required: true }\n'
        + 'jobs:\n  agent:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${{ inputs.cmd }}\n',
    });
    expect(ids(r)).toEqual(expect.arrayContaining(MISSING_ALL));
    expect(r.data.agentJobs).toBe(1);
  });
  it('a called workflow the caller DOES cap produces no finding', async () => {
    const r = await runWorkflows({ 'ci.yml': caller('agent.yml', CAPS), 'agent.yml': CALLEE });
    expect(r.findings.map((f) => f.severity)).toEqual(['pass']);
    expect(r.score).toBe(100);
  });
  // a → b → a. Invalid at runtime, but a static scanner must terminate on it and still
  // see the agent in b.
  it('terminates on a call cycle', async () => {
    const r = await runWorkflows({
      'a.yml': 'on: [push]\njobs:\n  b:\n    uses: ./.github/workflows/b.yml\n',
      'b.yml': 'on:\n  workflow_call:\njobs:\n  a:\n    uses: ./.github/workflows/a.yml\n'
        + '  agent:\n    runs-on: ubuntu-latest\n    steps:\n      - run: claude -p "fix the build"\n',
    });
    expect(ids(r)).toEqual(expect.arrayContaining(MISSING_ALL));
    expect(r.findings.every((f) => f.title.startsWith('b.yml'))).toBe(true);
  });
  // A workflow in another repo cannot be read offline. Saying so is INFO; guessing a
  // CRITICAL for a job we never opened would zero the check on a shared build workflow.
  it('reports a remote reusable-workflow call as unanalyzable, never a false CRITICAL', async () => {
    const r = await runWorkflows({
      'ci.yml': 'on: [push]\njobs:\n  build:\n    uses: acme/shared/.github/workflows/build.yml@v1\n'
        + '  agent:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n'
        + '      - run: claude -p "review" --max-turns 5 --allowedTools Read\n',
    });
    expect(ids(r)).toEqual(['ci-agent-caps/reusable-workflow-not-analyzed']);
    expect(r.findings[0].severity).toBe('info');
    expect(r.findings[0].title).toContain('acme/shared/.github/workflows/build.yml@v1');
    expect(r.score).toBe(98); // one INFO, nothing zeroed
  });
  // Same topology, different names, opposite walk order (`agent` < `ci`, but
  // `a-caller` < `z-agent`). A call site published mid-round instead of at the end of
  // one would resolve in one repo and not the other — loop-governance's bug, not repeated.
  it('the verdict does not depend on filename / walk order', async () => {
    const first = await runWorkflows({ 'ci.yml': caller('agent.yml'), 'agent.yml': CALLEE });
    const twin = await runWorkflows({
      'a-caller.yml': caller('z-agent.yml'), 'z-agent.yml': CALLEE,
    });
    expect(ids(twin).sort()).toEqual(ids(first).sort());
    expect(twin.score).toBe(first.score);
  });
});
