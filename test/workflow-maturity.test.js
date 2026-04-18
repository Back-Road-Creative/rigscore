import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/workflow-maturity.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-wm-'));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeSkill(cwd, name, content) {
  const skillPath = path.join(cwd, '.claude', 'skills', name, 'SKILL.md');
  writeFile(skillPath, content);
}

function writeCommand(cwd, name, content) {
  const cmdPath = path.join(cwd, '.claude', 'commands', `${name}.md`);
  writeFile(cmdPath, content);
}

// Track tmpdirs for cleanup
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

describe('workflow-maturity check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('workflow-maturity');
    expect(check.name).toBe('Workflow maturity');
    expect(check.category).toBe('governance');
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('returns N/A when no skills, MCP, memory, or pipelines exist', async () => {
    const cwd = tmp();
    const home = tmp();
    const result = await check.run({ cwd, homedir: home });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toEqual([]);
    expect(result.data).toEqual({});
  });

  it('emits a pass finding when all sub-checks healthy', async () => {
    const cwd = tmp();
    const home = tmp();
    // Skill with eval coverage and few triggers
    writeSkill(cwd, 'healthy', [
      '---',
      'name: healthy',
      'description: A healthy skill',
      'triggers: [alpha, beta]',
      '---',
      '# Healthy',
      'Do one thing well.',
    ].join('\n'));
    // Provide eval dir
    fs.mkdirSync(path.join(cwd, 'evals', 'healthy'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'evals', 'healthy', 'case.md'), 'eval');

    const result = await check.run({ cwd, homedir: home });
    expect(result.score).not.toBe(NOT_APPLICABLE_SCORE);
    const passes = result.findings.filter(f => f.severity === 'pass');
    expect(passes.length).toBe(1);
    const warnings = result.findings.filter(f => f.severity === 'warning');
    const infos = result.findings.filter(f => f.severity === 'info');
    expect(warnings).toHaveLength(0);
    expect(infos).toHaveLength(0);
    expect(result.data.skillsChecked).toBe(1);
    expect(result.data.skillsWithoutEvals).toBe(0);
  });

  // ---- eval-coverage ----

  describe('eval-coverage', () => {
    it('flags skill without eval or test as info', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'no-evals', [
        '---',
        'name: no-evals',
        'description: Missing evals',
        '---',
        '# No evals',
      ].join('\n'));

      const result = await check.run({ cwd, homedir: home });
      const evalFindings = result.findings.filter(f =>
        f.title?.includes('no-evals') && f.title?.includes('no eval'),
      );
      expect(evalFindings.length).toBe(1);
      expect(evalFindings[0].severity).toBe('info');
      expect(result.data.skillsWithoutEvals).toBe(1);
    });

    it('does not flag skill with evals/<name>/ directory', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'has-evals', [
        '---',
        'name: has-evals',
        'description: Covered',
        '---',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'has-evals'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'evals', 'has-evals', 'case.md'), 'x');

      const result = await check.run({ cwd, homedir: home });
      const evalFindings = result.findings.filter(f =>
        f.title?.includes('has-evals') && f.title?.includes('no eval'),
      );
      expect(evalFindings).toHaveLength(0);
    });

    it('does not flag skill with tests/test_<name>.py', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'tested', [
        '---',
        'name: tested',
        'description: Covered',
        '---',
      ].join('\n'));
      writeFile(path.join(cwd, 'tests', 'test_tested.py'), 'def test_x(): pass\n');

      const result = await check.run({ cwd, homedir: home });
      const evalFindings = result.findings.filter(f =>
        f.title?.includes('tested') && f.title?.includes('no eval'),
      );
      expect(evalFindings).toHaveLength(0);
    });

    it('resolves hyphen→underscore variant for tests/', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'hyphen-name', [
        '---',
        'name: hyphen-name',
        'description: hyphen',
        '---',
      ].join('\n'));
      // test_hyphen_name.py (underscore variant)
      writeFile(path.join(cwd, 'tests', 'test_hyphen_name.py'), 'def test_x(): pass\n');

      const result = await check.run({ cwd, homedir: home });
      const evalFindings = result.findings.filter(f =>
        f.title?.includes('hyphen-name') && f.title?.includes('no eval'),
      );
      expect(evalFindings).toHaveLength(0);
    });
  });

  // ---- compound-responsibility ----

  describe('skill-compound-responsibility', () => {
    it('flags skill with ≥8 trigger keywords as info (inline array)', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'overloaded', [
        '---',
        'name: overloaded',
        'description: too much',
        'triggers: [a, b, c, d, e, f, g, h, i]',
        '---',
        '# Overloaded',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'overloaded'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const compound = result.findings.filter(f =>
        f.title?.includes('overloaded') && f.title?.includes('compound responsibility'),
      );
      expect(compound.length).toBe(1);
      expect(compound[0].severity).toBe('info');
      expect(result.data.compoundSkills).toBe(1);
    });

    it('does not flag skill with 7 triggers', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'ok', [
        '---',
        'name: ok',
        'description: fine',
        'triggers: [a, b, c, d, e, f, g]',
        '---',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'ok'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const compound = result.findings.filter(f =>
        f.title?.includes('compound responsibility'),
      );
      expect(compound).toHaveLength(0);
    });

    it('parses multi-line block triggers form', async () => {
      const cwd = tmp();
      const home = tmp();
      writeSkill(cwd, 'block-form', [
        '---',
        'name: block-form',
        'description: block trigger form',
        'triggers:',
        '  - alpha',
        '  - beta',
        '  - gamma',
        '  - delta',
        '  - epsilon',
        '  - zeta',
        '  - eta',
        '  - theta',
        '  - iota',
        '---',
        '# Skill',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'block-form'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const compound = result.findings.filter(f =>
        f.title?.includes('block-form') && f.title?.includes('compound responsibility'),
      );
      expect(compound.length).toBe(1);
    });
  });

  // ---- mcp-single-consumer ----

  describe('mcp-single-consumer', () => {
    it('warns when MCP server has ≤1 consumer (from .mcp.json)', async () => {
      const cwd = tmp();
      const home = tmp();
      writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { 'lonely-server': { command: 'foo' } },
      }));
      writeSkill(cwd, 'only-consumer', [
        '---',
        'name: only-consumer',
        'description: Uses lonely-server',
        '---',
        '# Skill',
        'This skill calls lonely-server for things.',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'only-consumer'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const mcpFindings = result.findings.filter(f =>
        f.title?.includes('lonely-server') && f.severity === 'warning',
      );
      expect(mcpFindings.length).toBe(1);
      expect(result.data.mcpSingleConsumer).toBe(1);
    });

    it('does not warn when MCP server has ≥2 consumers', async () => {
      const cwd = tmp();
      const home = tmp();
      writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { 'shared-server': { command: 'foo' } },
      }));
      writeSkill(cwd, 'consumer-a', [
        '---',
        'name: consumer-a',
        'description: uses shared-server',
        '---',
        'This skill calls shared-server.',
      ].join('\n'));
      writeSkill(cwd, 'consumer-b', [
        '---',
        'name: consumer-b',
        'description: uses shared-server',
        '---',
        'Also uses shared-server.',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'consumer-a'), { recursive: true });
      fs.mkdirSync(path.join(cwd, 'evals', 'consumer-b'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const mcpFindings = result.findings.filter(f =>
        f.title?.includes('shared-server'),
      );
      expect(mcpFindings).toHaveLength(0);
    });

    it('picks up MCP servers from .claude/settings.json', async () => {
      const cwd = tmp();
      const home = tmp();
      writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
        mcpServers: { 'settings-server': { command: 'bar' } },
      }));
      // No skills at all -> server is <=1 consumer
      writeSkill(cwd, 'something', [
        '---',
        'name: something',
        'description: unrelated',
        '---',
        'Does unrelated things.',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'something'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const mcpFindings = result.findings.filter(f =>
        f.title?.includes('settings-server'),
      );
      expect(mcpFindings.length).toBe(1);
      expect(mcpFindings[0].severity).toBe('warning');
    });

    it('picks up MCP servers from both .mcp.json and .claude/settings.json', async () => {
      const cwd = tmp();
      const home = tmp();
      writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { 'server-from-mcp': { command: 'a' } },
      }));
      writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
        mcpServers: { 'server-from-settings': { command: 'b' } },
      }));
      writeSkill(cwd, 'noop', [
        '---',
        'name: noop',
        'description: no usage',
        '---',
        'Nothing here.',
      ].join('\n'));
      fs.mkdirSync(path.join(cwd, 'evals', 'noop'), { recursive: true });

      const result = await check.run({ cwd, homedir: home });
      const titles = result.findings.map(f => f.title || '').join(' | ');
      expect(titles).toContain('server-from-mcp');
      expect(titles).toContain('server-from-settings');
      expect(result.data.mcpServersChecked).toBe(2);
    });
  });

  // ---- memory-orphan ----

  describe('memory-orphan', () => {
    it('warns on orphan memory file not linked from MEMORY.md', async () => {
      const cwd = tmp();
      const home = tmp();
      const memDir = path.join(home, '.claude', 'projects', 'proj-a', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory Index\n- [known](known.md)\n');
      fs.writeFileSync(path.join(memDir, 'known.md'), '# Known\n');
      fs.writeFileSync(path.join(memDir, 'orphan.md'), '# Orphan\n');

      const result = await check.run({ cwd, homedir: home });
      const orphans = result.findings.filter(f =>
        f.title?.includes('orphan.md') && f.title?.includes('not linked'),
      );
      expect(orphans.length).toBe(1);
      expect(orphans[0].severity).toBe('warning');

      const known = result.findings.filter(f =>
        f.title?.includes('known.md'),
      );
      expect(known).toHaveLength(0);
    });

    it('treats all files as orphans when MEMORY.md missing', async () => {
      const cwd = tmp();
      const home = tmp();
      const memDir = path.join(home, '.claude', 'projects', 'proj-b', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'a.md'), '# A');
      fs.writeFileSync(path.join(memDir, 'b.md'), '# B');

      const result = await check.run({ cwd, homedir: home });
      const orphans = result.findings.filter(f =>
        f.severity === 'warning' && f.title?.includes('not linked'),
      );
      expect(orphans.length).toBe(2);
      expect(result.data.orphanMemoryFiles).toBe(2);
    });

    it('scans cwd/.claude/memory/ in addition to homedir projects', async () => {
      const cwd = tmp();
      const home = tmp();
      const cwdMemDir = path.join(cwd, '.claude', 'memory');
      fs.mkdirSync(cwdMemDir, { recursive: true });
      fs.writeFileSync(path.join(cwdMemDir, 'MEMORY.md'), '# Index\n');
      fs.writeFileSync(path.join(cwdMemDir, 'stray.md'), '# Stray');

      const result = await check.run({ cwd, homedir: home });
      const orphans = result.findings.filter(f =>
        f.title?.includes('stray.md'),
      );
      expect(orphans.length).toBe(1);
    });
  });

  // ---- pipeline-step-overload ----

  describe('pipeline-step-overload', () => {
    it('flags pipeline*.py with 10+ stage markers as info', async () => {
      const cwd = tmp();
      const home = tmp();
      const stages = Array.from({ length: 10 }, (_, i) => `# Stage ${i + 1}`).join('\n');
      writeFile(path.join(cwd, 'src', 'pipeline_main.py'), `${stages}\ndef run(): pass\n`);

      const result = await check.run({ cwd, homedir: home });
      const pipelineFindings = result.findings.filter(f =>
        f.title?.includes('pipeline_main.py') && f.title?.includes('stage markers'),
      );
      expect(pipelineFindings.length).toBe(1);
      expect(pipelineFindings[0].severity).toBe('info');
      expect(result.data.overloadedPipelines).toBe(1);
    });

    it('does not flag pipeline*.py with <10 markers', async () => {
      const cwd = tmp();
      const home = tmp();
      const stages = Array.from({ length: 5 }, (_, i) => `# Stage ${i + 1}`).join('\n');
      writeFile(path.join(cwd, 'src', 'pipeline_small.py'), `${stages}\ndef run(): pass\n`);

      const result = await check.run({ cwd, homedir: home });
      const pipelineFindings = result.findings.filter(f =>
        f.title?.includes('pipeline_small.py') && f.title?.includes('stage markers'),
      );
      expect(pipelineFindings).toHaveLength(0);
      expect(result.data.pipelinesChecked).toBe(1);
      expect(result.data.overloadedPipelines).toBe(0);
    });

    it('flags stages/ directory with 10+ .py modules as info', async () => {
      const cwd = tmp();
      const home = tmp();
      const stagesDir = path.join(cwd, 'src', 'stages');
      fs.mkdirSync(stagesDir, { recursive: true });
      for (let i = 0; i < 11; i++) {
        fs.writeFileSync(path.join(stagesDir, `stage${i}.py`), 'pass\n');
      }
      // NOTE: the check's N/A guard only trips when pipelinesChecked > 0
      // (among other counters), and stages-dir detection doesn't increment it.
      // Add a minimal pipeline file so hasAnything=true and findings are emitted.
      writeFile(path.join(cwd, 'src', 'pipeline_tiny.py'), '# nothing\ndef run(): pass\n');

      const result = await check.run({ cwd, homedir: home });
      const pipelineFindings = result.findings.filter(f =>
        f.title?.includes('stages/') && f.title?.includes('stage modules'),
      );
      expect(pipelineFindings.length).toBe(1);
      expect(pipelineFindings[0].severity).toBe('info');
    });
  });
});
