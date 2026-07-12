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
      // "No PR template at all" is deferred (docs: "Not covered (yet)").
      expect(ids(r)).not.toContain('ai-disclosure/no-pr-template');
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
    it('accepts a dedicated AI_POLICY.md, with no PR template at all, as clean', async () => {
      const r = await runWith({ ...CLAUDE, 'AI_POLICY.md': '# AI policy\nDisclose AI use.\n' });
      expect(r.findings.every((f) => f.severity === 'pass')).toBe(true);
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
});
