import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, statSafe, fileExists } from '../utils.js';

const TASKS = 'tasks.md';
const DESIGN = 'design.md';
const SPECS = 'specs';
const CONSTITUTION_REL = path.join('.specify', 'memory', 'constitution.md');

// One planning quarter: long enough that the goal file has demonstrably sat out a cycle,
// short enough to catch drift while it is cheap to fix. Deliberately a module constant —
// config.js allowlists known keys, so a threshold here would need a shared DEFAULTS entry.
const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

// Each layout: the marker dir that proves the tool is installed, where its spec dirs live,
// which file makes a dir a spec, and what a finished spec must also carry.
const LAYOUTS = [
  { framework: 'spec-kit', marker: '.specify', root: SPECS, entries: ['spec.md'], required: [TASKS] },
  { framework: 'kiro', marker: '.kiro', root: '.kiro/specs', entries: ['requirements.md', 'bugfix.md'], required: [DESIGN, TASKS] },
  // Shipped OpenSpec work is parked under changes/archive/ — done, not incomplete.
  { framework: 'openspec', marker: 'openspec', root: 'openspec/changes', entries: ['proposal.md'], required: [DESIGN, TASKS], skip: ['archive'] },
];

const MISSING_ARTIFACT = {
  [TASKS]: {
    findingId: 'spec-goals/spec-dir-no-tasks',
    why: 'it was never decomposed into executable work, so agents improvise around it',
    fix: (dir) => `Generate \`${dir}/${TASKS}\` from the spec, or archive the spec if it is abandoned.`,
  },
  [DESIGN]: {
    findingId: 'spec-goals/spec-dir-no-design',
    why: 'the requirements were never turned into a design, so agents invent the architecture',
    fix: (dir) => `Write \`${dir}/${DESIGN}\`, or archive the change if it is abandoned.`,
  },
};

// Verbatim tokens from github/spec-kit's templates/constitution-template.md. Two or more
// survivors means the template was never filled in.
const PLACEHOLDER_TOKENS = [
  '[PROJECT_NAME]', '[PRINCIPLE_1_NAME]', '[PRINCIPLE_1_DESCRIPTION]',
  '[GOVERNANCE_RULES]', '[CONSTITUTION_VERSION]', '[RATIFICATION_DATE]',
];

// agents.md states headings are NOT normative ("use any headings you like"), so hollowness
// is judged on runnable content, never on section titles.
const COMMAND_RE = /(^|[\s`$(])(npm|pnpm|yarn|bun|npx|make|pytest|python3?|node|cargo|go|uv|poetry|pip3?|bundle|rake|mvn|gradle|gradlew|dotnet|composer|docker|tox|vitest|jest|ruff|eslint|tsc|just|task|deno)\s+\S/m;

const isDir = async (p) => (await statSafe(p))?.isDirectory() === true;

/**
 * Spec dirs for one layout: a child of `layout.root` carrying one of `layout.entries`.
 * Returns the entry file's repo-relative path too, so drift can date the spec itself.
 */
async function collectSpecDirs(cwd, layout) {
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(cwd, layout.root), { withFileTypes: true });
  } catch {
    return [];
  }
  const skip = new Set(layout.skip || []);
  const found = [];
  for (const e of entries.filter((x) => x.isDirectory() && !skip.has(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const specDir = `${layout.root}/${e.name}`;
    const dir = path.join(cwd, layout.root, e.name);
    let entry = null;
    for (const cand of layout.entries) {
      if (await fileExists(path.join(dir, cand))) { entry = cand; break; }
    }
    if (!entry) continue;
    const missing = [];
    for (const req of layout.required) {
      if (!(await fileExists(path.join(dir, req)))) missing.push(req);
    }
    found.push({ framework: layout.framework, specDir, entryRel: `${specDir}/${entry}`, missing });
  }
  return found;
}

/** Run git read-only in `cwd`; null whenever git can't answer (missing binary, no repo, error). */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  if (!r || r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

/** Epoch ms of a path's last commit (committer date), or NaN when git has no answer. */
function lastCommitMs(cwd, rel) {
  return Date.parse(git(cwd, ['log', '-1', '--format=%cI', '--', rel]) || '');
}

/**
 * Liveness, not completeness: has the goal file sat out a planning cycle the specs kept
 * moving through? Compares committer dates *relative to each other*, so a rebase — which
 * rewrites every date together — cannot manufacture a finding. Where history can't answer
 * (no `.git`, no `git` on PATH, or a shallow clone that dates every file to one commit),
 * we skip rather than guess.
 */
function goalFileDrift(cwd, goalRel, specRels) {
  if (git(cwd, ['rev-parse', '--git-dir']) === null) return null;
  if (git(cwd, ['rev-parse', '--is-shallow-repository']) === 'true') return null;

  const goalMs = lastCommitMs(cwd, goalRel);
  if (Number.isNaN(goalMs)) return null; // never committed — nothing to compare against

  let newest = null;
  for (const rel of specRels) {
    const ms = lastCommitMs(cwd, rel);
    if (Number.isNaN(ms)) continue;
    if (!newest || ms > newest.ms) newest = { rel, ms };
  }
  if (!newest) return null;

  const gapDays = Math.floor((newest.ms - goalMs) / DAY_MS);
  return gapDays >= STALE_DAYS ? { goalRel, newestSpec: newest.rel, gapDays } : null;
}

export default {
  id: 'spec-goals',
  enforcementGrade: 'keyword',
  name: 'Spec goals',
  category: 'governance',

  async run(context) {
    const { cwd } = context;
    const findings = [];
    const frameworks = [];
    let specDirs = [];

    // Every layout is gated on its marker dir: a bare `specs/` is far too generic (RSpec,
    // OpenAPI, prose design docs) to read as spec-driven development on its own.
    for (const layout of LAYOUTS) {
      if (!(await isDir(path.join(cwd, layout.marker)))) continue;
      frameworks.push(layout.framework);
      specDirs = specDirs.concat(await collectSpecDirs(cwd, layout));
    }
    const isSpecKit = frameworks.includes('spec-kit');

    const agentsMd = await readFileSafe(path.join(cwd, 'AGENTS.md'));
    if (agentsMd !== null) frameworks.push('agents-md');

    // Not a spec-driven repo: out of scope, not broken.
    if (frameworks.length === 0) return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };

    // The constitution is Spec Kit's goal file: absent, or still boilerplate.
    if (isSpecKit) {
      const text = await readFileSafe(path.join(cwd, CONSTITUTION_REL));
      if (text === null) {
        findings.push({
          findingId: 'spec-goals/constitution-missing', severity: 'warning',
          title: '`.specify/` present but no constitution file',
          detail: `Spec Kit is installed but \`${CONSTITUTION_REL}\` does not exist — every spec under it is written without governing principles.`,
          remediation: 'Run `/speckit.constitution`, or author the file, to state the principles specs must satisfy.',
          context: { expected: CONSTITUTION_REL },
        });
      } else {
        const hits = PLACEHOLDER_TOKENS.filter((t) => text.includes(t));
        if (hits.length >= 2) {
          findings.push({
            findingId: 'spec-goals/constitution-placeholder', severity: 'warning',
            title: 'Constitution is still an unfilled template',
            detail: `\`${CONSTITUTION_REL}\` still holds ${hits.length} unreplaced template tokens (${hits.slice(0, 3).join(', ')}) — agents are pointed at boilerplate.`,
            remediation: `Replace the bracketed placeholders in \`${CONSTITUTION_REL}\` with the project's real principles.`,
            context: { file: CONSTITUTION_REL, placeholders: hits },
          });
        }
      }
    }

    const withoutTasks = specDirs.filter((s) => s.missing.includes(TASKS));
    for (const s of specDirs) {
      for (const miss of s.missing) {
        const meta = MISSING_ARTIFACT[miss];
        findings.push({
          findingId: meta.findingId, severity: 'info',
          title: `Spec \`${s.specDir}\` has no \`${miss}\``,
          detail: `\`${s.specDir}/\` holds a spec but no \`${miss}\` — ${meta.why}.`,
          remediation: meta.fix(s.specDir),
          context: { specDir: s.specDir, missing: miss, framework: s.framework },
        });
      }
    }

    // The goal file is Spec Kit's constitution when it exists, else AGENTS.md.
    const goalRel = isSpecKit && (await fileExists(path.join(cwd, CONSTITUTION_REL)))
      ? CONSTITUTION_REL
      : (agentsMd !== null ? 'AGENTS.md' : null);
    // OpenSpec's living specs are dated for drift, but not completeness-checked.
    const openspecSpecs = frameworks.includes('openspec')
      ? (await collectSpecDirs(cwd, { framework: 'openspec', root: 'openspec/specs', entries: ['spec.md'], required: [] }))
      : [];
    const specRels = [...specDirs, ...openspecSpecs].map((s) => s.entryRel);
    const drift = goalRel && specRels.length > 0 ? goalFileDrift(cwd, goalRel, specRels) : null;
    if (drift) {
      findings.push({
        findingId: 'spec-goals/goal-file-stale', severity: 'info',
        title: `Goal file \`${goalRel}\` is ${drift.gapDays} days behind the newest spec`,
        detail: `\`${goalRel}\` was last committed ${drift.gapDays} days before \`${drift.newestSpec}\` (threshold ${STALE_DAYS}) — specs kept moving while the goal file sat out a planning cycle. Commit dates proxy attention, so read this as a prompt, not proof.`,
        remediation: `Re-read \`${goalRel}\` against the newest specs and update what no longer holds.`,
        context: { file: goalRel, newestSpec: drift.newestSpec, gapDays: drift.gapDays, thresholdDays: STALE_DAYS },
      });
    }

    if (agentsMd !== null && !COMMAND_RE.test(agentsMd)) {
      findings.push({
        findingId: 'spec-goals/agents-md-hollow', severity: 'info',
        title: 'AGENTS.md names no runnable command',
        detail: 'AGENTS.md exists but names no setup, test, or build command an agent could execute — it is prose, not an operating manual.',
        remediation: 'Add the concrete commands (install, test, build, lint) an agent must run, in code spans or fenced blocks.',
        context: { file: 'AGENTS.md' },
      });
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: `Spec-driven artifacts are complete (${frameworks.join(', ')})` });
    }

    const data = { frameworks, specDirsChecked: specDirs.length, specDirsWithoutTasks: withoutTasks.length };
    return { score: calculateCheckScore(findings), findings, data };
  },
};
