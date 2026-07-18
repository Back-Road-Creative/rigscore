import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import check from '../src/checks/ci-agent-caps.js';

// RS-30: ci-agent-caps was GitHub-Actions exclusive (.github/workflows). Extend it
// to also read GitLab CI (.gitlab-ci.yml) and CircleCI (.circleci/config.yml) so an
// unattended agent invocation there is graded for turn cap, tool scoping, and
// permission-ceiling removal too.

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-ci-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const ids = (res) => res.findings.map((f) => f.findingId);

describe('ci-agent-caps GitLab CI (RS-30)', () => {
  it('flags a GitLab job that runs an agent with no turn cap or tool scoping', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitlab-ci.yml'),
      'stages:\n  - test\nagent-job:\n  stage: test\n  script:\n    - claude -p "review the diff"\n');
    const res = await check.run({ cwd: tmpDir });
    expect(ids(res)).toContain('ci-agent-caps/agent-job-missing-turn-cap');
    expect(ids(res)).toContain('ci-agent-caps/agent-job-missing-tool-scoping');
    expect(res.data.agentJobs).toBeGreaterThan(0);
  });

  it('does not flag a GitLab job that passes both caps', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitlab-ci.yml'),
      'good-job:\n  script:\n    - claude -p --max-turns 5 --allowedTools "Read,Grep" "go"\n');
    const res = await check.run({ cwd: tmpDir });
    expect(ids(res)).not.toContain('ci-agent-caps/agent-job-missing-turn-cap');
    expect(ids(res)).not.toContain('ci-agent-caps/agent-job-missing-tool-scoping');
  });

  it('flags a removed permission ceiling in a GitLab config', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitlab-ci.yml'),
      'danger:\n  script:\n    - claude -p --dangerously-skip-permissions "go"\n');
    const res = await check.run({ cwd: tmpDir });
    expect(ids(res)).toContain('ci-agent-caps/agent-permission-bypass');
    expect(res.findings.some((f) => f.severity === 'critical')).toBe(true);
  });
});

describe('ci-agent-caps CircleCI (RS-30)', () => {
  it('flags a CircleCI job step that runs an agent with no caps', async () => {
    const dir = path.join(tmpDir, '.circleci');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yml'),
      'version: 2.1\njobs:\n  agent:\n    docker:\n      - image: cimg/node:20.0\n    steps:\n      - checkout\n      - run: codex exec "do it"\n');
    const res = await check.run({ cwd: tmpDir });
    expect(ids(res)).toContain('ci-agent-caps/agent-job-missing-tool-scoping');
    expect(res.data.agentJobs).toBeGreaterThan(0);
  });

  it('reads a CircleCI run step given as an object with command', async () => {
    const dir = path.join(tmpDir, '.circleci');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yml'),
      'version: 2.1\njobs:\n  agent:\n    steps:\n      - run:\n          name: agent\n          command: claude -p "review"\n');
    const res = await check.run({ cwd: tmpDir });
    expect(ids(res)).toContain('ci-agent-caps/agent-job-missing-turn-cap');
  });
});
