import fs from 'node:fs';
import path from 'node:path';
import { GOVERNANCE_FILES, NOT_APPLICABLE_SCORE } from '../constants.js';
import { calculateCheckScore } from '../scoring.js';
import { readFileSafe, statSafe, fileExists } from '../utils.js';

// Only AI_POLICY.md is confirmed against primary sources (pypa/pip, modelcontextprotocol);
// the rest are generous variants — a false "no policy" flag is the expensive failure here.
const POLICY_FILENAMES = new Set(['ai_policy.md', 'ai-policy.md', 'aipolicy.md', 'ai.md', 'ai_covenant.md', 'ai_contributing.md', 'ai-contributing.md']);
const POLICY_DIRS = ['.', 'docs', '.github'];
const PROSE_POLICY_FILES = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', ...GOVERNANCE_FILES];
// GitHub honours a PR template in the repo root, `.github/`, or `docs/` — as a single
// file, or as a PULL_REQUEST_TEMPLATE/ directory holding several. Read all of them:
// a false "you have no PR template" on a repo that has one is the expensive failure.
// https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository
const PR_TEMPLATE_ROOTS = ['.github', '.', 'docs'];
const PR_TEMPLATE_FILES = PR_TEMPLATE_ROOTS.flatMap((d) => ['PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md'].map((n) => path.join(d, n)));
const PR_TEMPLATE_DIRS = PR_TEMPLATE_ROOTS.flatMap((d) => [path.join(d, 'PULL_REQUEST_TEMPLATE'), path.join(d, 'pull_request_template')]);
const MCP_CONFIGS = ['.mcp' + '.json', 'mcp_config.json', '.cursor/mcp' + '.json', '.vscode/mcp' + '.json'];
// Presence-based keyword sets — NOT a semantic read. See the docs page's limitations.
const AI_TERM = '\\b(generative ai|gen-?ai|ai|a\\.i\\.|artificial intelligence|llm|large language model|copilot|chatgpt|claude|cursor|codex|coding agent|machine[ -]generated)\\b';
const DISCLOSURE_TERM = /\b(disclos\w*|declar\w*|attribut\w*|co-?authors?|policy|policies|transparen\w*|acknowledg\w*|prohibit\w*|permitted|human (?:review\w*|checked|oversight))\b/i;
const AGENT_CI = /(claude-code-action|anthropics\/claude|openai\/codex|gemini-cli|aider|sweep-ai|devin)/i;
const WINDOW = 400; // chars either side of an AI term searched for policy language
const mentionsAi = (text) => new RegExp(AI_TERM, 'i').test(text || '');
const readdirSafe = async (d) => { try { return await fs.promises.readdir(d); } catch { return []; } };
// AI tool named AND disclosure language within WINDOW chars of it. The proximity rule stops
// a governance file — which says "Claude" by definition — from counting as a policy.
function hasPolicyLanguage(text) {
  if (!text) return false;
  const re = new RegExp(AI_TERM, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (DISCLOSURE_TERM.test(text.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW))) return true;
  }
  return false;
}
// AI surfaces present in the repo. Empty ⇒ the repo owes no disclosure.
async function detectAiSurface(cwd) {
  const surface = [];
  for (const f of [...GOVERNANCE_FILES, ...MCP_CONFIGS]) {
    if (await fileExists(path.join(cwd, f))) surface.push(f);
  }
  const claudeDir = await statSafe(path.join(cwd, '.claude'));
  if (claudeDir && claudeDir.isDirectory()) surface.push('.claude/');
  const wf = '.github/workflows';
  for (const entry of await readdirSafe(path.join(cwd, wf))) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const content = await readFileSafe(path.join(cwd, wf, entry));
    if (content && AGENT_CI.test(content)) { surface.push(path.join(wf, entry)); break; }
  }
  return surface;
}
async function findPolicy(cwd) {
  for (const dir of POLICY_DIRS) {
    for (const entry of await readdirSafe(path.join(cwd, dir))) {
      if (POLICY_FILENAMES.has(entry.toLowerCase())) return path.join(dir, entry);
    }
  }
  for (const rel of PROSE_POLICY_FILES) {
    if (hasPolicyLanguage(await readFileSafe(path.join(cwd, rel)))) return rel;
  }
  return null;
}
async function findPrTemplates(cwd) {
  const found = new Map(); // lowercased rel → {rel, content}; dedupes case-insensitive FS
  const add = async (rel) => {
    const content = await readFileSafe(path.join(cwd, rel));
    if (content !== null) found.set(rel.toLowerCase(), { rel, content });
  };
  for (const rel of PR_TEMPLATE_FILES) await add(rel);
  for (const dir of PR_TEMPLATE_DIRS) {
    for (const entry of await readdirSafe(path.join(cwd, dir))) {
      if (/\.(md|markdown|txt)$/i.test(entry)) await add(path.join(dir, entry));
    }
  }
  return [...found.values()];
}

export default {
  id: 'ai-disclosure',
  enforcementGrade: 'keyword',
  name: 'AI-use disclosure',
  category: 'governance',
  async run(context) {
    const { cwd } = context;
    const findings = [];
    // A repo with no AI surface owes nobody a disclosure. Never punish it.
    const surface = await detectAiSurface(cwd);
    if (surface.length === 0) return { score: NOT_APPLICABLE_SCORE, findings: [] };
    const policy = await findPolicy(cwd);
    const templates = await findPrTemplates(cwd);
    const disclosing = templates.find((t) => mentionsAi(t.content));
    if (!policy) {
      findings.push({
        findingId: 'ai-disclosure/no-ai-policy',
        severity: 'warning',
        title: 'No AI-use policy for a repo that runs AI agents',
        detail: `AI surface present (${surface.slice(0, 3).join(', ')}) but no AI-use policy: nothing in CONTRIBUTING.md, no AI_POLICY.md, and nothing in the governance file saying how AI assistance is used and disclosed.`,
        remediation: 'Add an AI_POLICY.md, or a "Generative AI policy" section in CONTRIBUTING.md, stating whether AI-assisted contributions are accepted and how they must be disclosed.',
      });
    }
    // Weakest of the three signals — legitimate repos (solo projects, mirrors,
    // non-GitHub hosting) have no PR template at all — so INFO, never WARNING.
    if (templates.length === 0) {
      findings.push({
        findingId: 'ai-disclosure/no-pr-template',
        severity: 'info',
        title: 'No PR template for a repo that runs AI agents',
        detail: `AI surface present (${surface.slice(0, 3).join(', ')}) but no pull-request template in any location GitHub reads (root, .github/ or docs/ — single file or PULL_REQUEST_TEMPLATE/ directory), so a contributor is never asked to declare AI assistance.`,
        remediation: 'Add .github/pull_request_template.md carrying a generative-AI declaration — e.g. a checkbox pair: did not use generative AI / used it, but a human has checked the code.',
      });
    }
    if (templates.length > 0 && !disclosing) {
      findings.push({
        findingId: 'ai-disclosure/pr-template-no-ai-field',
        severity: 'warning',
        title: 'PR template has no AI-disclosure field',
        detail: `No PR template mentions AI at all (${templates.map((t) => t.rel).join(', ')}), so an AI-assisted change ships with no declaration.`,
        remediation: 'Add a "Generative AI declaration" to the PR template — e.g. a checkbox pair: did not use generative AI / used it, but a human has checked the code.',
      });
    }
    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'AI-use policy present',
        detail: `Policy stated in ${policy}${disclosing ? `; ${disclosing.rel} carries an AI-disclosure field` : ''}.`,
      });
    }
    return {
      score: calculateCheckScore(findings),
      findings,
      data: { aiSurface: surface, policyFile: policy, prTemplates: templates.map((t) => t.rel), hasDisclosureField: Boolean(disclosing) },
    };
  },
};
