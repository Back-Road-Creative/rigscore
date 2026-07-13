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

// One planning quarter: long enough that a goal file or spec has demonstrably sat out a
// cycle, short enough to catch drift while it is cheap to fix. Tunable per repo via
// `specGoals.driftWindowDays` in .rigscorerc.json (DEFAULTS in src/config.js); this is the
// fallback when the key is absent or not a positive integer.
const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

// OpenSpec ticks tasks off as a change lands, then parks it under changes/archive/.
// Every box ticked and none left open is the tool's own "this shipped" signal.
const TICKED_TASK_RE = /^[ \t]*[-*] \[[xX]\]/m;
const OPEN_TASK_RE = /^[ \t]*[-*] \[ \]/m;

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

// EARS (Easy Approach to Requirements Syntax). Every form — ubiquitous, event-driven
// (WHEN), state-driven (WHILE), optional-feature (WHERE) and unwanted-behaviour (IF/THEN) —
// bottoms out in the same clause: `THE <system> SHALL <response>`. Matching that clause
// recognises all five, and staying lenient about clause *order* keeps this finding about
// prose masquerading as requirements, not about EARS pedantry.
const EARS_RE = /\bthe\b[^.!?]*\bshall\b/i;
// Only lines carrying a normative verb are judged. A user story ("As a user, I want …") or
// a background paragraph is not a requirement, so it is never held to the grammar.
const NORMATIVE_RE = /\b(?:shall|must)\b/i;

// OpenSpec's living spec (`openspec/specs/<domain>/spec.md`) is the domain's current truth,
// and its documented skeleton is `## Purpose` → `## Requirements` → `### Requirement:` →
// `#### Scenario:`. Its own authoring guide makes the scenario the testable half: "Every
// requirement has at least one scenario that actually exercises it."
const PURPOSE_RE = /^##\s+Purpose\b/im;
const REQUIREMENT_SPLIT_RE = /^###\s+Requirement:[ \t]*/m;
const SCENARIO_RE = /^####\s+Scenario:/m;
// A requirement block runs until the next h2 — `##` followed by a space, which neither
// `### Requirement:` nor `#### Scenario:` can match.
const NEXT_H2_RE = /^##\s/m;

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
 * Committer date of every spec, plus the newest of them — the yardstick both staleness
 * findings are measured against. Null where history can't answer (no `.git`, no `git` on
 * PATH, or a shallow clone that dates every file to one commit): we skip rather than guess.
 */
function specDates(cwd, specs) {
  if (git(cwd, ['rev-parse', '--git-dir']) === null) return null;
  if (git(cwd, ['rev-parse', '--is-shallow-repository']) === 'true') return null;

  const dated = [];
  let newest = null;
  for (const s of specs) {
    const ms = lastCommitMs(cwd, s.entryRel);
    if (Number.isNaN(ms)) continue;
    dated.push({ ...s, ms });
    if (!newest || ms > newest.ms) newest = { rel: s.entryRel, ms };
  }
  return newest ? { dated, newest } : null;
}

/**
 * Liveness, not completeness: has the goal file sat out a planning cycle the specs kept
 * moving through? Compares committer dates *relative to each other*, so a rebase — which
 * rewrites every date together — cannot manufacture a finding.
 */
function goalFileDrift(cwd, goalRel, newest, windowDays) {
  const goalMs = lastCommitMs(cwd, goalRel);
  if (Number.isNaN(goalMs)) return null; // never committed — nothing to compare against
  const gapDays = Math.floor((newest.ms - goalMs) / DAY_MS);
  return gapDays >= windowDays ? { goalRel, newestSpec: newest.rel, gapDays } : null;
}

/**
 * Specs the tree left behind. An unfinished spec is only *evidence* of abandonment once
 * the rest of the tree kept moving without it, so the gap is measured against the newest
 * spec — never the wall clock. That keeps the finding rebase-immune (every date rewritten
 * together closes the gap) at the price of staying silent on a tree abandoned wholesale,
 * where no spec is newer than any other. A spec that is old but *complete* is finished
 * work, not abandoned work, and is never flagged.
 */
function abandonedSpecs(dated, newest, windowDays) {
  const out = [];
  for (const s of dated) {
    if (s.missing.length === 0) continue;
    const gapDays = Math.floor((newest.ms - s.ms) / DAY_MS);
    if (gapDays >= windowDays) out.push({ ...s, gapDays });
  }
  return out;
}

/**
 * The tree the repo left behind wholesale. `abandonedSpecs` dates each spec against the
 * newest spec, so a tree where *every* spec is equally ancient trails nothing and stays
 * silent. The second yardstick for exactly that case is the scan root's own pulse — the
 * newest commit touching `cwd` (pathspec `.`) — never the wall clock and never a date from
 * outside the scanned tree. Both halves of the gap are committer dates the tree already
 * carries, so the verdict is frozen the moment the tree is committed: no run can start
 * firing because a calendar page turned, only because someone committed.
 *
 * Firing needs both halves of "adopted, then dropped": the repo kept committing for a
 * window while no spec moved, *and* unfinished specs are still sitting in the tree. A tree
 * that is old but complete is finished work — the same rule `abandonedSpecs` applies. A
 * repo archived wholesale (code stopped too) has a zero gap and is silent by construction.
 */
function dormantTree(cwd, dated, newest, windowDays) {
  const rootMs = lastCommitMs(cwd, '.');
  if (Number.isNaN(rootMs)) return null;
  const gapDays = Math.floor((rootMs - newest.ms) / DAY_MS);
  if (gapDays < windowDays) return null;
  const unfinished = dated.filter((s) => s.missing.length > 0).map((s) => s.specDir);
  return unfinished.length > 0 ? { gapDays, unfinished } : null;
}

/**
 * Kiro requirement files whose requirements are not written in EARS. Kiro is the layout that
 * mandates the grammar, so it is the only one held to it. Two shapes fail: a file with no
 * EARS requirement at all (freeform prose, which used to pass by merely existing), and one
 * that mixes EARS with normative lines that fall outside it. Line-based by design: Kiro
 * writes one acceptance criterion per bullet.
 */
async function nonEarsRequirements(cwd, specs) {
  const out = [];
  for (const s of specs) {
    if (s.framework !== 'kiro') continue;
    const text = await readFileSafe(path.join(cwd, s.entryRel));
    if (text === null) continue;
    const normative = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => NORMATIVE_RE.test(l));
    const earsCount = normative.filter((l) => EARS_RE.test(l)).length;
    const nonEars = normative.filter((l) => !EARS_RE.test(l));
    if (earsCount > 0 && nonEars.length === 0) continue;
    out.push({ ...s, earsCount, nonEars: nonEars.slice(0, 2) });
  }
  return out;
}

/** What a living OpenSpec domain spec is missing against its documented skeleton; [] when whole. */
function domainSpecGaps(text) {
  const missing = [];
  if (!PURPOSE_RE.test(text)) missing.push('a `## Purpose` section');
  const blocks = text.split(REQUIREMENT_SPLIT_RE).slice(1);
  if (blocks.length === 0) {
    missing.push('at least one `### Requirement:`');
    return missing;
  }
  for (const block of blocks) {
    const body = block.split(NEXT_H2_RE)[0];
    if (!SCENARIO_RE.test(body)) {
      missing.push(`a \`#### Scenario:\` under "${block.split(/\r?\n/, 1)[0].trim()}"`);
    }
  }
  return missing;
}

/** Complete OpenSpec changes whose tasks are all ticked — shipped work never swept into archive/. */
async function unarchivedChanges(cwd, specs) {
  const out = [];
  for (const s of specs) {
    if (s.framework !== 'openspec' || s.missing.length > 0) continue;
    const text = await readFileSafe(path.join(cwd, s.specDir, TASKS));
    if (text && TICKED_TASK_RE.test(text) && !OPEN_TASK_RE.test(text)) out.push(s);
  }
  return out;
}

export default {
  id: 'spec-goals',
  enforcementGrade: 'keyword',
  name: 'Spec goals',
  category: 'governance',

  async run(context) {
    const { cwd, config } = context;
    const configured = config?.specGoals?.driftWindowDays;
    const windowDays = Number.isInteger(configured) && configured > 0 ? configured : STALE_DAYS;
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

    for (const s of await nonEarsRequirements(cwd, specDirs)) {
      findings.push({
        findingId: 'spec-goals/requirements-not-ears', severity: 'info',
        title: `Requirements in \`${s.specDir}\` are not written in EARS`,
        detail: s.earsCount === 0
          ? `\`${s.entryRel}\` states no requirement in a recognisable EARS form (\`WHEN <trigger> THE <system> SHALL <response>\`, or the ubiquitous \`THE <system> SHALL …\`) — it is prose, so it names no trigger and no testable response, and an agent has nothing to satisfy.`
          : `\`${s.entryRel}\` mixes ${s.earsCount} EARS requirement(s) with ${s.nonEars.length} line(s) outside the grammar (e.g. "${s.nonEars[0]}") — the strays name no system or no response, so what "done" means is left to the agent.`,
        remediation: `Rewrite the acceptance criteria in \`${s.entryRel}\` as EARS: \`WHEN <trigger> THE <system> SHALL <response>\` (or \`IF <condition> THEN …\`, \`WHILE <state> …\`, \`WHERE <feature> …\`).`,
        context: { specDir: s.specDir, file: s.entryRel, framework: s.framework, earsCount: s.earsCount, nonEars: s.nonEars },
      });
    }

    // The goal file is Spec Kit's constitution when it exists, else AGENTS.md.
    const goalRel = isSpecKit && (await fileExists(path.join(cwd, CONSTITUTION_REL)))
      ? CONSTITUTION_REL
      : (agentsMd !== null ? 'AGENTS.md' : null);
    // OpenSpec's living specs are dated for drift, but not completeness-checked.
    const openspecSpecs = frameworks.includes('openspec')
      ? (await collectSpecDirs(cwd, { framework: 'openspec', root: 'openspec/specs', entries: ['spec.md'], required: [] }))
      : [];
    const allSpecs = [...specDirs, ...openspecSpecs];
    const dates = allSpecs.length > 0 ? specDates(cwd, allSpecs) : null;

    const drift = goalRel && dates ? goalFileDrift(cwd, goalRel, dates.newest, windowDays) : null;
    if (drift) {
      findings.push({
        findingId: 'spec-goals/goal-file-stale', severity: 'info',
        title: `Goal file \`${goalRel}\` is ${drift.gapDays} days behind the newest spec`,
        detail: `\`${goalRel}\` was last committed ${drift.gapDays} days before \`${drift.newestSpec}\` (threshold ${windowDays}) — specs kept moving while the goal file sat out a planning cycle. Commit dates proxy attention, so read this as a prompt, not proof.`,
        remediation: `Re-read \`${goalRel}\` against the newest specs and update what no longer holds.`,
        context: { file: goalRel, newestSpec: drift.newestSpec, gapDays: drift.gapDays, thresholdDays: windowDays },
      });
    }

    const abandoned = dates ? abandonedSpecs(dates.dated, dates.newest, windowDays) : [];
    for (const s of abandoned) {
      findings.push({
        findingId: 'spec-goals/spec-abandoned', severity: 'info',
        title: `Spec \`${s.specDir}\` was left unfinished ${s.gapDays} days behind the newest spec`,
        detail: `\`${s.specDir}/\` is still missing \`${s.missing.join('`, `')}\` and its last commit is ${s.gapDays} days behind \`${dates.newest.rel}\` (threshold ${windowDays}) — the spec tree moved on without it, so it reads as abandoned rather than mid-flight. Commit dates proxy attention, so read this as a prompt, not proof.`,
        remediation: `Finish \`${s.specDir}\` or archive it — an unfinished spec agents can still read is a goal no one is steering.`,
        context: { specDir: s.specDir, missing: s.missing, gapDays: s.gapDays, thresholdDays: windowDays, framework: s.framework },
      });
    }

    const dormant = dates ? dormantTree(cwd, dates.dated, dates.newest, windowDays) : null;
    if (dormant) {
      findings.push({
        findingId: 'spec-goals/spec-tree-dormant', severity: 'info',
        title: `The whole spec tree has sat still for the ${dormant.gapDays} days the repo kept committing`,
        detail: `No spec has been touched since \`${dates.newest.rel}\`, ${dormant.gapDays} days before the scan root's own last commit (threshold ${windowDays}), and ${dormant.unfinished.length} spec(s) are still unfinished (\`${dormant.unfinished.join('`, `')}\`) — the repo moved on while the entire tree stood still, so spec-driven development reads as adopted and then dropped. Per-spec staleness cannot see this: no spec trails any other when all are equally ancient. Commit dates proxy attention, so read this as a prompt, not proof.`,
        remediation: `Finish or archive \`${dormant.unfinished[0]}\` and its siblings, or remove the spec scaffolding if the project no longer runs on it — an unfinished spec no one has touched in ${dormant.gapDays} days of active development is a goal agents still read and no one is steering.`,
        context: { newestSpec: dates.newest.rel, gapDays: dormant.gapDays, thresholdDays: windowDays, unfinished: dormant.unfinished },
      });
    }

    for (const s of await unarchivedChanges(cwd, specDirs)) {
      findings.push({
        findingId: 'spec-goals/change-unarchived', severity: 'info',
        title: `Change \`${s.specDir}\` is fully ticked off but never archived`,
        detail: `Every task in \`${s.specDir}/${TASKS}\` is checked and none is open, but the change still sits in \`openspec/changes/\` — OpenSpec parks shipped work under \`changes/archive/\`, so the active tree overstates what is actually in flight.`,
        remediation: `Sweep \`${s.specDir}\` into \`openspec/changes/archive/\` (\`openspec archive <name>\`), or reopen the tasks that are not really done.`,
        context: { specDir: s.specDir, framework: s.framework },
      });
    }

    // OpenSpec's living specs: dated for drift above, audited for completeness here.
    for (const s of openspecSpecs) {
      const text = await readFileSafe(path.join(cwd, s.entryRel));
      if (text === null) continue;
      const missing = domainSpecGaps(text);
      if (missing.length === 0) continue;
      findings.push({
        findingId: 'spec-goals/domain-spec-incomplete', severity: 'info',
        title: `Domain spec \`${s.specDir}\` is missing ${missing.length} required part(s)`,
        detail: `\`${s.entryRel}\` is missing ${missing.join(', ')} — OpenSpec's living spec is what agents read as the domain's current truth, so a hollow one sends them to the changes tree, or to guesswork, for behaviour that is supposed to be settled.`,
        remediation: `Fill \`${s.entryRel}\` out to OpenSpec's shape: a \`## Purpose\`, then \`### Requirement:\` blocks each carrying at least one \`#### Scenario:\` — a requirement with no scenario states no way to tell whether it holds.`,
        context: { specDir: s.specDir, file: s.entryRel, framework: s.framework, missing },
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

    const data = {
      frameworks,
      specDirsChecked: specDirs.length,
      specDirsWithoutTasks: withoutTasks.length,
      driftWindowDays: windowDays,
    };
    return { score: calculateCheckScore(findings), findings, data };
  },
};
