import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe } from '../utils.js';

// Every flag/input name below is confirmed against vendor docs (URLs: docs/checks/ci-agent-caps.md). A
// name that could not be confirmed is omitted, never invented: where a vendor documents NO turn cap the
// signal is `null` and no finding is emitted — a miss beats a false positive on a job that IS capped.
const ACTION = /^anthropics\/claude-code(?:-base)?-action@/;
const TURNS = /--max-turns[\s=]/;
const CTOOLS = /--(?:dis)?allowed-?tools[\s=]|--tools[\s=]/i;
// [tool, invocation, turn-cap flag | null, tool-scoping flags | null]. Invocations match a command word
// (`claude …`), never a path (`.claude/x`). aider/opencode are out of scope — see the docs page.
const CLIS = [
  ['claude', /(?:^|[\s;&|(])claude(?=\s)(?=.*(?:\s-p\b|\s--print\b))/, TURNS, CTOOLS],
  ['codex', /(?:^|[\s;&|(])codex\s+e(?:xec)?(?=\s|$)/, null,
    /--sandbox[\s=]+(?:read-only|workspace-write)|--ask-for-approval[\s=]|(?:^|\s)-s[\s=]+(?:read-only|workspace-write)|(?:^|\s)-a[\s=]/],
  ['gemini', /(?:^|[\s;&|(])gemini(?=\s)(?=.*(?:\s-p\b|\s--prompt\b))/, null,
    /--allowed-tools[\s=]|--approval-mode[\s=]+(?:default|auto_edit|plan)\b/],
];
// Unambiguous "no ceiling" flags. Gemini's `-y` is excluded on purpose — it collides with apt-get/npm.
const BYPASS = [
  /--dangerously-skip-permissions\b/, /--dangerously-bypass-approvals-and-sandbox\b/, /--yolo\b/,
  /--permission-mode[\s=]+bypassPermissions\b/, /--approval-mode[\s=]+yolo\b/, /--sandbox[\s=]+danger-full-access\b/,
];
// [signal, finding id, title phrase, detail, remediation]
const GAPS = [
  ['turnCap', 'agent-job-missing-turn-cap', 'with no turn cap',
    'With no turn/iteration cap the agent keeps taking turns until it decides it is done — or until the job times out.', 'Pass --max-turns (via claude_args on the action, or the CLI flag).'],
  ['toolScope', 'agent-job-missing-tool-scoping', 'with unrestricted tools',
    'An unattended agent holding every tool can shell out, push, and reach the network with the runner credentials.', 'Scope the tools: --allowedTools/--disallowedTools (Claude), --sandbox + --ask-for-approval (codex), --approval-mode (gemini).'],
];

async function loadWorkflows(cwd) {
  const dir = path.join(cwd, '.github', 'workflows');
  const files = (await fs.promises.readdir(dir).catch(() => [])).sort().filter((f) => /\.ya?ml$/i.test(f));
  const out = [];
  for (const file of files) {
    const content = await readFileSafe(path.join(dir, file));
    if (content) out.push({ file, content });
  }
  return out;
}
// Every AI-agent invocation in one job, with its declared caps:
// true = declared, false = supported but missing, null = the tool has no such flag.
function agentInvocations(job) {
  const found = [];
  for (const step of Array.isArray(job?.steps) ? job.steps : []) {
    if (!step || typeof step !== 'object') continue;
    const stepTimeout = step['timeout-minutes'] !== undefined;
    if (typeof step.uses === 'string' && ACTION.test(step.uses.trim())) {
      const w = step.with || {};
      const has = (k) => w[k] !== undefined && String(w[k]).trim() !== '';
      const args = String(w.claude_args ?? '');
      found.push({ tool: step.uses.trim(),
        turnCap: has('max_turns') || TURNS.test(args),
        toolScope: has('allowed_tools') || has('disallowed_tools') || CTOOLS.test(args)
          || /permissions/.test(String(w.settings ?? '')),
        // v0's `timeout_minutes` input capped runtime before the job-level move.
        stepTimeout: stepTimeout || has('timeout_minutes') });
    }
    if (typeof step.run !== 'string') continue;
    // Join backslash continuations, then match one command per line.
    for (const line of step.run.replace(/\\\s*\n\s*/g, ' ').split('\n')) {
      for (const [tool, invoke, cap, scope] of CLIS) {
        if (!invoke.test(line)) continue;
        found.push({ tool: `${tool} CLI`, stepTimeout,
          turnCap: cap ? cap.test(line) : null, toolScope: scope ? scope.test(line) : null });
      }
    }
  }
  return found;
}
export default {
  id: 'ci-agent-caps',
  enforcementGrade: 'pattern',
  name: 'CI agent caps',
  category: 'process',
  async run(context) {
    const findings = [];
    const add = (id, severity, title, detail, remediation, extra) => findings.push({
      findingId: `ci-agent-caps/${id}`, severity, title, detail, remediation, ...extra,
    });
    const workflows = await loadWorkflows(context.cwd);
    let agentJobs = 0;
    for (const wf of workflows) {
      // A removed permission ceiling counts wherever it appears — including inside a
      // wrapper-script call this check cannot otherwise parse.
      for (const re of BYPASS) {
        const m = wf.content.match(re);
        if (!m) continue;
        add('agent-permission-bypass', 'critical', `${wf.file}: agent permission ceiling removed (${m[0]})`,
          `${m[0]} lets an unattended CI agent run every tool call with no approval and no sandbox — on a runner holding repo write credentials.`,
          `Remove ${m[0]} and scope the agent instead (allowed/disallowed tools, or a sandbox + approval policy).`,
          { evidence: m[0] });
      }
      let doc;
      try { doc = YAML.parse(wf.content); } catch {
        add('failed-to-parse-workflow', 'info', `Failed to parse ${wf.file}`,
          'Invalid YAML — this workflow could not be analyzed for agent jobs.');
        continue;
      }
      for (const [name, job] of Object.entries((doc && typeof doc.jobs === 'object' && doc.jobs) || {})) {
        const invocations = agentInvocations(job);
        if (invocations.length === 0) continue;
        agentJobs++;
        const where = `${wf.file} job "${name}"`;
        if (job['timeout-minutes'] === undefined && !invocations.some((i) => i.stepTimeout)) {
          add('agent-job-missing-timeout', 'warning', `${where} runs an AI agent with no timeout-minutes`,
            "GitHub's default job timeout is 360 minutes. An agent that loops gets six unattended hours on a runner with repo write access.",
            'Add timeout-minutes to the job (or to the agent step).');
        }
        for (const inv of invocations) {
          for (const [signal, id, phrase, detail, fix] of GAPS) {
            if (inv[signal] === null || inv[signal]) continue;
            add(id, 'warning', `${where} runs ${inv.tool} ${phrase}`, detail, fix);
          }
        }
      }
    }
    // Most repos run no agent in CI at all — that is N/A, not a zero.
    if (agentJobs === 0 && !findings.some((f) => f.severity === 'critical')) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: { agentJobs: 0 } };
    }
    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Every CI agent job declares a turn cap, a timeout, and tool scoping' });
    }
    return { score: calculateCheckScore(findings), findings, data: { agentJobs } };
  },
};
