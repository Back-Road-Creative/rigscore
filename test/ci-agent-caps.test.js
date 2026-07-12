import { describe, it, expect } from 'vitest';
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
});
