import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/ai-disclosure.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-aid-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    try { fs.rmSync(tmpdirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
// homedir → empty tmp dir, so a developer's real ~/.claude can't make a case look AI-tooled.
const runOn = (cwd) => check.run({ cwd, homedir: tmp(), config: {} });
function runWith(files) {
  const cwd = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return runOn(cwd);
}
const fixture = (name) => runOn(path.join(__dirname, 'fixtures', name));
const ids = (r) => r.findings.map((f) => f.findingId);
const sev = (r, id) => r.findings.find((f) => f.findingId === id)?.severity;
const CLAUDE = { 'CLAUDE.md': '# Instructions\n' };
describe('ai-disclosure check', () => {
  it('has the required shape and ships advisory (weight 0)', () => {
    expect(check.id).toBe('ai-disclosure');
    expect(check.category).toBe('governance');
    expect(check.enforcementGrade).toBe('keyword');
    expect(WEIGHTS[check.id]).toBe(0);
  });
  describe('applicability gate', () => {
    it('returns N/A for a repo with no AI surface at all', async () => {
      const r = await fixture('ai-disclosure-nonai');
      expect(r.score).toBe(NOT_APPLICABLE_SCORE);
      expect(r.findings).toEqual([]);
    });
    it('is applicable when only a .claude/ dir exists (no governance file)', async () => {
      const r = await runWith({ '.claude/settings.json': '{}' });
      expect(r.score).not.toBe(NOT_APPLICABLE_SCORE);
      expect(ids(r)).toContain('ai-disclosure/no-ai-policy');
    });
    it('is applicable when only an MCP config exists', async () => {
      expect((await runWith({ '.mcp.json': '{"mcpServers":{}}' })).score).not.toBe(NOT_APPLICABLE_SCORE);
    });
    it('is applicable when only an agent CI job exists', async () => {
      const ci = 'jobs:\n  bot:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n';
      expect((await runWith({ '.github/workflows/a.yml': ci })).score).not.toBe(NOT_APPLICABLE_SCORE);
    });
  });
  describe('signals', () => {
    it('flags an AI repo with no policy and no PR template', async () => {
      const r = await fixture('ai-disclosure-none');
      expect(sev(r, 'ai-disclosure/no-ai-policy')).toBe('warning');
      // Weakest of the three signals — plenty of legitimate repos have no PR
      // template at all (solo projects, mirrors, non-GitHub hosting) — so INFO.
      expect(sev(r, 'ai-disclosure/no-pr-template')).toBe('info');
    });
    it('flags an AI repo whose PR template carries no AI-disclosure field', async () => {
      const r = await fixture('ai-disclosure-template-gap');
      expect(sev(r, 'ai-disclosure/pr-template-no-ai-field')).toBe('warning');
    });
    it('passes an AI repo with a CONTRIBUTING.md policy and a disclosing template', async () => {
      const r = await fixture('ai-disclosure-clean');
      expect(r.findings.every((f) => f.severity === 'pass')).toBe(true);
      expect(r.score).toBe(100);
    });
  });
  describe('conservative detection', () => {
    it('accepts a dedicated AI_POLICY.md as the policy; the missing template is only advisory', async () => {
      const r = await runWith({ ...CLAUDE, 'AI_POLICY.md': '# AI policy\nDisclose AI use.\n' });
      expect(r.findings.filter((f) => f.severity === 'warning')).toEqual([]);
      expect(sev(r, 'ai-disclosure/no-pr-template')).toBe('info');
    });
    it('accepts a policy stated inside the governance file itself', async () => {
      const r = await runWith({ 'AGENTS.md': '# Agents\n\nAI-assisted changes must be disclosed in the pull request.\n' });
      expect(ids(r)).not.toContain('ai-disclosure/no-ai-policy');
    });
    it('handles the .github/PULL_REQUEST_TEMPLATE/ directory form', async () => {
      const tpl = '## Summary\n\n- [ ] I used generative AI tools and a human reviewed the code.\n';
      const r = await runWith({ ...CLAUDE, '.github/PULL_REQUEST_TEMPLATE/feature.md': tpl });
      expect(ids(r)).not.toContain('ai-disclosure/pr-template-no-ai-field');
    });
    it('flags a directory-form template set where no template mentions AI', async () => {
      const r = await runWith({ ...CLAUDE, '.github/PULL_REQUEST_TEMPLATE/bug.md': '## Summary\n' });
      expect(sev(r, 'ai-disclosure/pr-template-no-ai-field')).toBe('warning');
    });
  });
  // A false "you have no PR template" on a repo that has one is the expensive
  // failure, so every location GitHub honours must be read: root, .github/ and
  // docs/, either casing, single file or PULL_REQUEST_TEMPLATE/ directory.
  describe('no PR template at all', () => {
    const TPL = '## Summary\n\n- [ ] I used generative AI and a human reviewed the code.\n';
    it('never fires on a repo with no AI surface (owes no disclosure)', async () => {
      expect(ids(await fixture('ai-disclosure-nonai'))).not.toContain('ai-disclosure/no-pr-template');
    });
    it('does not fire alongside pr-template-no-ai-field (the arms are exclusive)', async () => {
      const r = await fixture('ai-disclosure-template-gap');
      expect(ids(r)).not.toContain('ai-disclosure/no-pr-template');
    });
    for (const rel of [
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/pull_request_template.md',
      'PULL_REQUEST_TEMPLATE.md',
      'pull_request_template.md',
      'docs/PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE/feature.md',
      'PULL_REQUEST_TEMPLATE/feature.md',
      'docs/PULL_REQUEST_TEMPLATE/feature.md',
    ]) {
      it(`sees a template at ${rel}`, async () => {
        const r = await runWith({ ...CLAUDE, [rel]: TPL });
        expect(ids(r)).not.toContain('ai-disclosure/no-pr-template');
      });
    }
  });
  // The repo asking is not the repo enforcing. A disclosure checkbox nothing can fail
  // is honour-system only — but only a repo that ASKS can be un-enforcing, so the
  // finding is gated on the ask (a repo that never asks gets no-ai-policy instead).
  describe('unenforced disclosure', () => {
    const ID = 'ai-disclosure/disclosure-not-enforced';
    const ASKING = {
      ...CLAUDE,
      'CONTRIBUTING.md': '# Contributing\n## Generative AI policy\nAI use must be disclosed in the pull request.\n',
      '.github/pull_request_template.md': '## Summary\n- [ ] I used generative AI tools and a human checked the code.\n',
    };
    it('fires when the repo asks for a disclosure but nothing enforces it', async () => {
      const r = await runWith(ASKING);
      expect(ids(r)).toContain(ID);
      // Governance weakness, not a vulnerability — and the repo already did the asking.
      expect(sev(r, ID)).toBe('info');
    });
    it('does not fire when a workflow reads the PR body and fails on it', async () => {
      const wf = [
        'on: pull_request',
        'jobs:',
        '  disclosure:',
        '    steps:',
        '      - env:',
        '          BODY: ${{ github.event.pull_request.body }}',
        '        run: echo "$BODY" | grep -q "\\[x\\]" || exit 1',
      ].join('\n');
      const r = await runWith({ ...ASKING, '.github/workflows/disclosure.yml': wf });
      expect(ids(r)).not.toContain(ID);
    });
    it('does not fire on a repo that never asks for a disclosure (that is no-ai-policy)', async () => {
      expect(ids(await runWith(CLAUDE))).not.toContain(ID);
      expect(ids(await fixture('ai-disclosure-none'))).not.toContain(ID);
      expect(ids(await fixture('ai-disclosure-nonai'))).not.toContain(ID);
    });
    it('fires on a workflow that merely mentions AI without gating on the PR body', async () => {
      const wf = 'name: AI review\non: pull_request\njobs:\n  ai:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n';
      expect(ids(await runWith({ ...ASKING, '.github/workflows/ai.yml': wf }))).toContain(ID);
    });
    it('accepts a checklist-enforcer action as enforcement', async () => {
      const wf = 'on: pull_request\njobs:\n  c:\n    steps:\n      - uses: mheap/require-checklist-action@v2\n';
      expect(ids(await runWith({ ...ASKING, '.github/workflows/c.yml': wf }))).not.toContain(ID);
    });
    it('accepts a Dangerfile that fails on the PR body', async () => {
      const df = 'if (!danger.github.pr.body.includes("[x]")) fail("Tick the AI-disclosure box");\n';
      expect(ids(await runWith({ ...ASKING, 'dangerfile.js': df }))).not.toContain(ID);
    });
    it('does not accept CODEOWNERS review as enforcement of a disclosure', async () => {
      const r = await runWith({ ...ASKING, '.github/CODEOWNERS': '* @maintainers\n' });
      expect(ids(r)).toContain(ID);
    });
  });
});
