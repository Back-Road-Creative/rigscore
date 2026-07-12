import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, statSafe, fileExists } from '../utils.js';

const TASKS = 'tasks.md';
const SPECS = 'specs';
const CONSTITUTION_REL = path.join('.specify', 'memory', 'constitution.md');

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

/** Spec Kit feature dirs: `specs/<NNN-name>/` carrying a `spec.md`. */
async function collectSpecDirs(root) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, e.name);
    if (!(await fileExists(path.join(dir, 'spec.md')))) continue;
    found.push({ specDir: `${SPECS}/${e.name}`, hasTasks: await fileExists(path.join(dir, TASKS)) });
  }
  return found;
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

    // Spec Kit is gated on `.specify/` because a bare `specs/` is far too generic (RSpec,
    // OpenAPI, prose design docs) to read as spec-driven development on its own.
    const isSpecKit = await isDir(path.join(cwd, '.specify'));
    if (isSpecKit) {
      frameworks.push('spec-kit');
      if (await isDir(path.join(cwd, SPECS))) specDirs = await collectSpecDirs(path.join(cwd, SPECS));
    }

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

    const withoutTasks = specDirs.filter((s) => !s.hasTasks);
    for (const s of withoutTasks) {
      findings.push({
        findingId: 'spec-goals/spec-dir-no-tasks', severity: 'info',
        title: `Spec \`${s.specDir}\` has no \`${TASKS}\``,
        detail: `\`${s.specDir}/\` holds a spec but no \`${TASKS}\` — it was never decomposed into executable work, so agents improvise around it.`,
        remediation: `Generate \`${s.specDir}/${TASKS}\` from the spec, or archive the spec if it is abandoned.`,
        context: { specDir: s.specDir, missing: TASKS },
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
