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
// (`claude …`), never a path (`.claude/x`). aider and opencode carry `null, null`: neither vendor
// documents a turn cap or a tool-scoping flag, so both are graded on timeout-minutes alone. Their
// auto-approve flags (aider `--yes`, opencode `--auto`) are deliberately NOT bypasses — see the docs page.
const CLIS = [
  ['claude', /(?:^|[\s;&|(])claude(?=\s)(?=.*(?:\s-p\b|\s--print\b))/, TURNS, CTOOLS],
  ['codex', /(?:^|[\s;&|(])codex\s+e(?:xec)?(?=\s|$)/, null,
    /--sandbox[\s=]+(?:read-only|workspace-write)|--ask-for-approval[\s=]|(?:^|\s)-s[\s=]+(?:read-only|workspace-write)|(?:^|\s)-a[\s=]/],
  ['gemini', /(?:^|[\s;&|(])gemini(?=\s)(?=.*(?:\s-p\b|\s--prompt\b))/, null,
    /--allowed-tools[\s=]|--approval-mode[\s=]+(?:default|auto_edit|plan)\b/],
  // aider's non-interactive form is `--message`/`--msg`/`-m` (or `--message-file`); bare `aider` would
  // sit at an interactive prompt, so requiring the flag is what makes this a CI invocation.
  ['aider', /(?:^|[\s;&|(])aider(?=\s)(?=.*(?:\s-m\b|\s--msg\b|\s--message(?:-file)?\b))/, null, null],
  ['opencode', /(?:^|[\s;&|(])opencode\s+run(?=\s|$)/, null, null],
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

// A job can delegate to another workflow (`jobs.<id>.uses:`). The LOCAL form is the only
// one GitHub allows for a same-repo call, and it lands in the very directory this check
// reads — so the callee's steps are already scanned. What is NOT visible standalone is
// what the CALLER passes it: a reusable workflow takes its prompt, its flags and its caps
// as `inputs`, so a callee alone reads `max_turns: ${{ inputs.max_turns }}` — a non-empty
// string that looks like a declared cap even when every caller passes nothing, and
// `run: ${{ inputs.cmd }}` — an agent invocation that matches no pattern at all.
const LOCAL_USES = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/;
const INPUT_REF = /\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}/g;
// GitHub itself allows four levels of nested reusable workflows, so four hops is the whole
// reachable graph — a real ceiling, not a hedge. One hop per ROUND, and a round publishes
// its call sites only at the END: adding them to the map mid-round would make the reachable
// depth an artifact of directory order (loop-governance's MAX_HOPS learned this).
const MAX_REUSABLE_HOPS = 4;

const jobsOf = (doc) => Object.entries((doc && typeof doc.jobs === 'object' && doc.jobs) || {});
const localCallee = (job) => {
  const m = typeof job?.uses === 'string' && job.uses.trim().match(LOCAL_USES);
  return m ? m[1] : null;
};

/** Substitute `${{ inputs.x }}` through a parsed workflow. An input no caller passes
 * resolves to '' — what the runner substitutes, and what turns a templated `max_turns:`
 * from "declared" back into the missing cap it really is. */
function expandInputs(node, inputs) {
  if (typeof node === 'string') return node.replace(INPUT_REF, (_, k) => String(inputs[k] ?? ''));
  if (Array.isArray(node)) return node.map((n) => expandInputs(n, inputs));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expandInputs(v, inputs)]));
  }
  return node;
}
/** The inputs a callee sees at ONE call site: its own declared defaults, overlaid by what
 * this caller passes — itself expanded in the caller's call context, so a pass-through
 * (`with: {max_turns: ${{ inputs.max_turns }}}`) resolves down the chain. */
function callInputs(calleeDoc, job, callerInputs) {
  const declared = calleeDoc?.on?.workflow_call?.inputs;
  const out = {};
  for (const [k, v] of Object.entries((declared && typeof declared === 'object' && declared) || {})) {
    if (v && v.default !== undefined) out[k] = String(v.default);
  }
  for (const [k, v] of Object.entries((job.with && typeof job.with === 'object' && job.with) || {})) {
    out[k] = expandInputs(String(v), callerInputs || {});
  }
  return out;
}
/** Every local call site, keyed by callee file: `{inputs, via}` — `via` names the caller, so
 * a gap raised inside a callee can say who calls it. Rounds, not recursion: a→b→a terminates
 * because a context already seen contributes nothing new, and MAX_REUSABLE_HOPS bounds the
 * work either way. */
function resolveCallSites(workflows) {
  const byFile = new Map(workflows.map((w) => [w.file, w]));
  const sites = new Map();
  const seen = new Set();
  let frontier = workflows.map((wf) => ({ wf, inputs: null }));
  for (let hop = 0; hop < MAX_REUSABLE_HOPS && frontier.length; hop++) {
    const next = [];
    for (const { wf, inputs } of frontier) {
      for (const [name, job] of jobsOf(wf.doc)) {
        const callee = byFile.get(localCallee(job));
        if (!callee?.doc) continue;
        const site = { inputs: callInputs(callee.doc, job, inputs), via: `${wf.file} job "${name}"` };
        const key = `${callee.file}|${JSON.stringify(site)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ wf: callee, inputs: site.inputs, site });
      }
    }
    for (const n of next) sites.set(n.wf.file, [...(sites.get(n.wf.file) || []), n.site]);
    frontier = next;
  }
  return sites;
}

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

// GitLab CI and CircleCI configs (RS-30). GitHub's reusable-workflow call graph is
// GitHub-specific, so these are scanned the standalone way: a raw-content bypass
// scan plus a per-job command scan for uncapped agent invocations.
const CI_PROVIDER_FILES = [
  { kind: 'gitlab', rel: '.gitlab-ci.yml' },
  { kind: 'gitlab', rel: '.gitlab-ci.yaml' },
  { kind: 'circle', rel: '.circleci/config.yml' },
  { kind: 'circle', rel: '.circleci/config.yaml' },
];
async function loadCIConfigs(cwd) {
  const out = [];
  for (const { kind, rel } of CI_PROVIDER_FILES) {
    const content = await readFileSafe(path.join(cwd, rel));
    if (content) out.push({ file: rel, kind, content });
  }
  return out;
}

// GitLab job = any top-level mapping with a `script` (before/after_script pulled in
// too). Reserved globals (variables/default/workflow/...) have no `script` key.
function gitlabJobs(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const out = [];
  for (const [name, val] of Object.entries(doc)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    if (name.startsWith('.') || !('script' in val)) continue; // hidden template / not a job
    const lines = [];
    for (const key of ['before_script', 'script', 'after_script']) {
      const s = val[key];
      if (typeof s === 'string') lines.push(s);
      else if (Array.isArray(s)) for (const l of s) if (typeof l === 'string') lines.push(l);
    }
    if (lines.length) out.push({ name, lines });
  }
  return out;
}

// CircleCI job/command = `steps: [{ run: "cmd" | { command: "cmd" } }, ...]`.
function circleJobs(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const out = [];
  for (const container of [doc.jobs, doc.commands]) {
    if (!container || typeof container !== 'object') continue;
    for (const [name, job] of Object.entries(container)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const lines = [];
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue; // e.g. the string "checkout"
        const run = step.run;
        if (typeof run === 'string') lines.push(run);
        else if (run && typeof run === 'object' && typeof run.command === 'string') lines.push(run.command);
      }
      if (lines.length) out.push({ name, lines });
    }
  }
  return out;
}

// CLI agent invocations found in a list of shell-command strings, with declared caps
// (true = declared, false = supported but missing, null = the tool has no such flag).
// The same per-line CLIS matching agentInvocations() uses for GitHub `run:` steps.
function cliInvocationsInLines(cmdStrings) {
  const found = [];
  for (const raw of cmdStrings) {
    for (const line of String(raw).replace(/\\\s*\n\s*/g, ' ').split('\n')) {
      for (const [tool, invoke, cap, scope] of CLIS) {
        if (!invoke.test(line)) continue;
        found.push({ tool: `${tool} CLI`,
          turnCap: cap ? cap.test(line) : null, toolScope: scope ? scope.test(line) : null });
      }
    }
  }
  return found;
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
    // Parse every workflow before analyzing any of them: a call site cannot be resolved
    // until both ends of the edge have been read.
    for (const wf of workflows) {
      try { wf.doc = YAML.parse(wf.content); } catch {
        add('failed-to-parse-workflow', 'info', `Failed to parse ${wf.file}`,
          'Invalid YAML — this workflow could not be analyzed for agent jobs.');
      }
    }
    const callSites = resolveCallSites(workflows);
    const agentJobKeys = new Set();
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
      if (!wf.doc) continue;
      // A `uses:` we cannot open — another repo's workflow, or a local path missing from the
      // checkout — is an agent surface this check cannot grade. Say so and stop there: an
      // offline scanner guessing a WARNING (let alone a CRITICAL) about a job it never read
      // would fire on every repo that shares an org-wide build workflow.
      for (const [name, job] of jobsOf(wf.doc)) {
        if (typeof job?.uses !== 'string' || callSites.has(localCallee(job))) continue;
        add('reusable-workflow-not-analyzed', 'info',
          `${wf.file} job "${name}" delegates to a workflow rigscore cannot read (${job.uses.trim()})`,
          'This job runs another workflow — from another repo, or from a path not in this checkout. Whatever agent it invokes, and whatever caps it declares, are outside this scan.',
          'Review that workflow\'s agent caps by hand, or vendor it into .github/workflows/ so it is scanned.',
          { evidence: job.uses.trim() });
      }
      // Once per call site, with the caller's inputs resolved — or once as written when
      // nobody local calls it, which is the standalone reading this check has always done.
      for (const site of callSites.get(wf.file) || [null]) {
        const doc = site ? expandInputs(wf.doc, site.inputs) : wf.doc;
        for (const [name, job] of jobsOf(doc)) {
          const invocations = agentInvocations(job);
          if (invocations.length === 0) continue;
          agentJobKeys.add(`${wf.file} ${name}`);
          // Named at the CALLEE — the file holding the invocation, and the one place a
          // default can close the gap — with the caller cited, because that is the other
          // place the operator can pass the cap.
          const where = `${wf.file} job "${name}"${site ? ` (called by ${site.via})` : ''}`;
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
    }
    // GitLab CI / CircleCI (RS-30). Standalone scan: raw-content bypass detection
    // plus a per-job command scan for uncapped agent invocations. The GitHub-only
    // reusable-workflow graph and job-timeout default do not apply here.
    for (const cfg of await loadCIConfigs(context.cwd)) {
      for (const re of BYPASS) {
        const m = cfg.content.match(re);
        if (!m) continue;
        add('agent-permission-bypass', 'critical', `${cfg.file}: agent permission ceiling removed (${m[0]})`,
          `${m[0]} lets an unattended CI agent run every tool call with no approval and no sandbox — on a runner holding repo write credentials.`,
          `Remove ${m[0]} and scope the agent instead (allowed/disallowed tools, or a sandbox + approval policy).`,
          { evidence: m[0] });
      }
      let doc;
      try { doc = YAML.parse(cfg.content); } catch {
        add('failed-to-parse-workflow', 'info', `Failed to parse ${cfg.file}`,
          'Invalid YAML — this config could not be analyzed for agent jobs.');
        continue;
      }
      const jobs = cfg.kind === 'gitlab' ? gitlabJobs(doc) : circleJobs(doc);
      for (const { name, lines } of jobs) {
        const invocations = cliInvocationsInLines(lines);
        if (invocations.length === 0) continue;
        agentJobKeys.add(`${cfg.file} ${name}`);
        const where = `${cfg.file} job "${name}"`;
        for (const inv of invocations) {
          for (const [signal, id, phrase, detail, fix] of GAPS) {
            if (inv[signal] === null || inv[signal]) continue;
            add(id, 'warning', `${where} runs ${inv.tool} ${phrase}`, detail, fix);
          }
        }
      }
    }

    const agentJobs = agentJobKeys.size;
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
