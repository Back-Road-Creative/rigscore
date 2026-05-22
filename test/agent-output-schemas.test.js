import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/agent-output-schemas.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE, OWASP_AGENTIC_MAP } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-aos-'));
}

function writeAgent(rootDir, name, body, frontmatter = null) {
  const fmBlock = frontmatter
    ? `---\n${frontmatter}\n---\n\n`
    : `---\nname: ${name}\ndescription: test\n---\n\n`;
  const agentPath = path.join(rootDir, '.claude', 'agents', `${name}.md`);
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, fmBlock + body);
  return agentPath;
}

const tmpdirs = [];
function tmp() {
  const d = makeTmpDir();
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('agent-output-schemas check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('agent-output-schemas');
    expect(check.name).toBe('Agent output schemas');
    expect(check.category).toBe('governance');
    expect(WEIGHTS[check.id]).toBe(0);
    expect(OWASP_AGENTIC_MAP[check.id]).toMatch(/^ASI\d{2}$/);
  });

  it('returns N/A when no .claude/agents/ directories exist', async () => {
    const cwd = tmp();
    const home = tmp();
    const result = await check.run({ cwd, homedir: home });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toEqual([]);
  });

  it('emits pass when all JSON-claiming agents have parseable schemas', async () => {
    const cwd = tmp();
    const home = tmp();
    writeAgent(cwd, 'good-array',
      'Return ONLY a JSON array of findings.\n\n## Output Format\n\n```json\n[{"name": "x", "verdict": "OK"}]\n```\n',
    );
    writeAgent(cwd, 'good-object',
      '## Output Format\n\nSingle JSON object:\n\n```json\n{"score": 7.5, "summary": "fine"}\n```\n',
    );
    const result = await check.run({ cwd, homedir: home });
    expect(result.score).not.toBe(NOT_APPLICABLE_SCORE);
    const passes = result.findings.filter(f => f.severity === 'pass');
    const warnings = result.findings.filter(f => f.severity === 'warning');
    expect(passes).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(result.data.agentsScanned).toBe(2);
    expect(result.data.agentsClaimingJson).toBe(2);
  });

  it('flags missing-schema-block when agent claims JSON but has no fence', async () => {
    const cwd = tmp();
    const home = tmp();
    writeAgent(cwd, 'no-fence',
      'Return ONLY a JSON object. You should know what to do.\n\n(But there is no example fence anywhere.)\n',
    );
    const result = await check.run({ cwd, homedir: home });
    const missing = result.findings.filter(
      f => f.findingId === 'agent-output-schemas/missing-schema-block',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('warning');
    expect(missing[0].context.agent).toBe('no-fence');
    expect(result.data.agentsMissingFence).toBe(1);
  });

  it('flags malformed-schema-block when fenced JSON fails to parse', async () => {
    const cwd = tmp();
    const home = tmp();
    writeAgent(cwd, 'bad-json',
      '## Output Format\n\n```json\n{"verdict": <placeholder>, "trailing": ,}\n```\n',
    );
    const result = await check.run({ cwd, homedir: home });
    const malformed = result.findings.filter(
      f => f.findingId === 'agent-output-schemas/malformed-schema-block',
    );
    expect(malformed).toHaveLength(1);
    expect(malformed[0].severity).toBe('warning');
    expect(malformed[0].context.fenceIndex).toBe(1);
    expect(result.data.agentsWithMalformedFence).toBe(1);
  });

  it('skips agents that do not claim JSON output', async () => {
    const cwd = tmp();
    const home = tmp();
    writeAgent(cwd, 'narrative',
      'You are a narrative code reviewer. Write your review in prose. Cite file:line.\n',
    );
    const result = await check.run({ cwd, homedir: home });
    const passes = result.findings.filter(f => f.severity === 'pass');
    expect(passes).toHaveLength(1);
    expect(result.data.agentsScanned).toBe(1);
    expect(result.data.agentsClaimingJson).toBe(0);
  });

  it('scans agents from both cwd and homedir', async () => {
    const cwd = tmp();
    const home = tmp();
    writeAgent(cwd, 'project-agent',
      '## Output Format\n\n```json\n{"k": "v"}\n```\n',
    );
    writeAgent(home, 'user-global-agent',
      'Return ONLY a JSON object with no fence here.\n',
    );
    const result = await check.run({ cwd, homedir: home });
    expect(result.data.agentsScanned).toBe(2);
    const missing = result.findings.filter(
      f => f.findingId === 'agent-output-schemas/missing-schema-block',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].context.agent).toBe('user-global-agent');
  });

  it('handles agent files without frontmatter', async () => {
    const cwd = tmp();
    const home = tmp();
    const agentPath = path.join(cwd, '.claude', 'agents', 'no-fm.md');
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(agentPath, '## Output Format\n\n```json\n{"ok": true}\n```\n');
    const result = await check.run({ cwd, homedir: home });
    const warnings = result.findings.filter(f => f.severity === 'warning');
    expect(warnings).toHaveLength(0);
    expect(result.data.agentsClaimingJson).toBe(1);
  });
});
