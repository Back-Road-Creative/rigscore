import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, readJsonSafe, fileExists } from '../utils.js';

// Directories excluded from recursive pipeline scans
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.git']);

// Stage marker patterns for pipeline-step-overload check
const STAGE_PATTERNS = [
  /# Stage \d/i,
  /# Step \d/i,
  /Phase [A-Z\d]/,
  /stage_\d/i,
  /STAGE_\d/,
  /^## Stage\b/im,
  /^## Step\b/im,
  /^## Phase\b/im,
  // Letter-keyed phase substeps: # A1:, # B5.5:, # C2 —
  /^\s*#\s+[A-D]\d+(?:\.\d+)?\s*[:\-–]/,
  // Stage/phase class definitions: class FooStage(...), class PhaseA:
  /^class \w+Stage\b/,
  /^class Phase[A-Z]\b/,
];

// Default stage directory names that indicate distributed pipeline architectures.
// Additional names can be added via config.workflowMaturity.stageDirs.
const DEFAULT_STAGE_DIR_NAMES = ['stages', 'phases'];

/**
 * Discover all skill directories under .claude/skills and .claude/commands
 * for both cwd and homedir. Returns array of { name, dir } objects.
 */
async function discoverSkillDirs(cwd, homedir) {
  const skillDirs = [
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.claude', 'commands'),
  ];

  if (homedir && homedir !== cwd) {
    skillDirs.push(
      path.join(homedir, '.claude', 'skills'),
      path.join(homedir, '.claude', 'commands'),
    );
  }

  const results = [];
  for (const dir of skillDirs) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        results.push({ name: entry.name, dir: path.join(dir, entry.name) });
      }
    } catch { /* directory doesn't exist */ }
  }
  return results;
}

/**
 * Discover all SKILL.md files and return their content alongside skill name.
 * Returns array of { name, content, skillPath }.
 */
async function discoverSkillsWithContent(cwd, homedir) {
  const skillDirs = await discoverSkillDirs(cwd, homedir);
  const skills = [];
  for (const { name, dir } of skillDirs) {
    const skillPath = path.join(dir, 'SKILL.md');
    const content = await readFileSafe(skillPath);
    if (content) {
      skills.push({ name, content, skillPath });
    }
  }
  return skills;
}

/**
 * Parse the YAML frontmatter from a SKILL.md file.
 * Returns the raw frontmatter block as a string (between --- delimiters), or null.
 */
function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Extract the description field value from frontmatter text.
 */
function extractDescription(frontmatter) {
  if (!frontmatter) return null;
  const match = frontmatter.match(/^description\s*:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

/**
 * Count distinct trigger keywords in a SKILL.md (frontmatter triggers: or ## Triggers section).
 */
function countTriggerKeywords(content) {
  const triggers = new Set();

  // Frontmatter triggers: field — support single-line array or multi-line list
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    // Single-line array: triggers: [a, b, c]
    const inlineMatch = fm.match(/^triggers\s*:\s*\[([^\]]+)\]/im);
    if (inlineMatch) {
      for (const t of inlineMatch[1].split(',')) {
        const kw = t.trim().replace(/^["']|["']$/g, '');
        if (kw) triggers.add(kw.toLowerCase());
      }
    } else {
      // Multi-line list under triggers:
      const blockMatch = fm.match(/^triggers\s*:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/im);
      if (blockMatch) {
        for (const line of blockMatch[1].split('\n')) {
          const kw = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
          if (kw) triggers.add(kw.toLowerCase());
        }
      }
    }
  }

  // ## Triggers section in body
  const bodyTrigMatch = content.match(/^## Triggers\s*\r?\n([\s\S]*?)(?=^##|\z)/im);
  if (bodyTrigMatch) {
    for (const line of bodyTrigMatch[1].split('\n')) {
      const kw = line.replace(/^\s*[-*]\s*/, '').trim().replace(/^["'`]|["'`]$/g, '');
      if (kw && kw.length > 1) triggers.add(kw.toLowerCase());
    }
  }

  return triggers.size;
}

/**
 * Read MCP server names from .mcp.json and .claude/settings.json
 * under both cwd and homedir.
 */
async function discoverMcpServers(cwd, homedir) {
  const serverNames = new Set();

  const mcpJsonPaths = [
    path.join(cwd, '.mcp.json'),
  ];
  if (homedir && homedir !== cwd) {
    mcpJsonPaths.push(path.join(homedir, '.mcp.json'));
  }

  for (const p of mcpJsonPaths) {
    const data = await readJsonSafe(p);
    if (data?.mcpServers && typeof data.mcpServers === 'object') {
      for (const name of Object.keys(data.mcpServers)) {
        serverNames.add(name);
      }
    }
  }

  const settingsPaths = [
    path.join(cwd, '.claude', 'settings.json'),
  ];
  if (homedir && homedir !== cwd) {
    settingsPaths.push(path.join(homedir, '.claude', 'settings.json'));
  }

  for (const p of settingsPaths) {
    const data = await readJsonSafe(p);
    if (data?.mcpServers && typeof data.mcpServers === 'object') {
      for (const name of Object.keys(data.mcpServers)) {
        serverNames.add(name);
      }
    }
  }

  return [...serverNames];
}

/**
 * Recursively find directories matching a name set under a root directory,
 * skipping SKIP_DIRS.
 */
async function findDirsNamed(root, nameSet) {
  const results = [];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(root, entry.name);
      if (nameSet.has(entry.name)) results.push(full);
      const sub = await findDirsNamed(full, nameSet);
      results.push(...sub);
    }
  } catch { /* permission or missing */ }
  return results;
}

/**
 * Recursively find files matching a name pattern under a root directory,
 * skipping SKIP_DIRS.
 */
async function findFiles(root, namePredicate) {
  const results = [];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const sub = await findFiles(full, namePredicate);
        results.push(...sub);
      } else if (namePredicate(entry.name)) {
        results.push(full);
      }
    }
  } catch { /* permission or missing */ }
  return results;
}

/**
 * Count stage markers in a file's content.
 */
function countStageMarkers(content) {
  let count = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    for (const pattern of STAGE_PATTERNS) {
      if (pattern.test(line)) {
        count++;
        break; // one hit per line
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Check 1: eval-coverage
// ---------------------------------------------------------------------------

/**
 * For a given skill name, check whether an eval or test file exists.
 */
async function hasEvalOrTest(skillName, cwd) {
  // evals/{skillName}/ directory
  const evalDir = path.join(cwd, 'evals', skillName);
  try {
    const stat = await fs.promises.stat(evalDir);
    if (stat.isDirectory()) return true;
  } catch { /* ok */ }

  // tests/test_{skillName}.* or tests/test_{skillName.replace(/-/g,'_')}.*
  const variants = [skillName, skillName.replace(/-/g, '_')];
  const testsDir = path.join(cwd, 'tests');
  try {
    const entries = await fs.promises.readdir(testsDir);
    for (const entry of entries) {
      for (const v of variants) {
        if (entry.startsWith(`test_${v}`)) return true;
      }
    }
  } catch { /* no tests dir */ }

  return false;
}

// ---------------------------------------------------------------------------
// Check 4: memory-orphan helpers
// ---------------------------------------------------------------------------

/**
 * Glob for memory .md files across all project memory directories and cwd memory.
 * Returns array of { dir, files: string[] } grouped by directory.
 */
async function discoverMemoryDirs(cwd, homedir) {
  const dirs = new Map(); // dirPath → Set of basename

  // ~/.claude/projects/*/memory/*.md
  if (homedir) {
    const projectsRoot = path.join(homedir, '.claude', 'projects');
    try {
      const projectDirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
      for (const pd of projectDirs) {
        if (!pd.isDirectory()) continue;
        const memDir = path.join(projectsRoot, pd.name, 'memory');
        try {
          const memFiles = await fs.promises.readdir(memDir);
          const mdFiles = memFiles.filter(f => f.endsWith('.md'));
          if (mdFiles.length > 0) {
            dirs.set(memDir, new Set(mdFiles));
          }
        } catch { /* no memory dir */ }
      }
    } catch { /* no projects dir */ }
  }

  // {cwd}/.claude/memory/*.md
  const cwdMemDir = path.join(cwd, '.claude', 'memory');
  try {
    const memFiles = await fs.promises.readdir(cwdMemDir);
    const mdFiles = memFiles.filter(f => f.endsWith('.md'));
    if (mdFiles.length > 0) {
      dirs.set(cwdMemDir, new Set(mdFiles));
    }
  } catch { /* no cwd memory dir */ }

  return dirs;
}

/**
 * Extract all markdown link targets from content.
 * Returns Set of basenames (link targets may include relative paths).
 */
function extractLinkedFiles(content) {
  const linked = new Set();
  const linkRe = /\[.*?\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = linkRe.exec(content)) !== null) {
    // Normalize to basename only for comparison within same directory
    const target = match[1].trim();
    if (!target.startsWith('http')) {
      linked.add(path.basename(target));
    }
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default {
  id: 'workflow-maturity',
  name: 'Workflow maturity',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    const configuredStageDirs = Array.isArray(config?.workflowMaturity?.stageDirs)
      ? config.workflowMaturity.stageDirs
      : DEFAULT_STAGE_DIR_NAMES;
    const stageDirNames = new Set(configuredStageDirs);

    // Shared: discover skills once for checks 1, 2, 3
    const skills = await discoverSkillsWithContent(cwd, homedir);

    // -----------------------------------------------------------------------
    // Check 1 — eval-coverage
    // -----------------------------------------------------------------------
    let skillsChecked = skills.length;
    let skillsWithoutEvals = 0;

    for (const skill of skills) {
      const hasEval = await hasEvalOrTest(skill.name, cwd);
      if (!hasEval) {
        skillsWithoutEvals++;
        findings.push({
          findingId: 'workflow-maturity/skill-no-eval',
          severity: 'info',
          title: `Skill \`${skill.name}\` has no eval`,
          detail: `Skill \`${skill.name}\` has no eval — graduation requires at least one eval before promoting to code or agent.`,
          remediation: `Create \`evals/${skill.name}/\` or \`tests/test_${skill.name}.*\` to provide coverage for this skill.`,
          context: { skill: skill.name },
        });
      }
    }

    // -----------------------------------------------------------------------
    // Check 2 — skill-compound-responsibility
    // -----------------------------------------------------------------------
    let compoundSkills = 0;

    for (const skill of skills) {
      const frontmatter = extractFrontmatter(skill.content);
      const description = extractDescription(frontmatter);
      const triggerCount = countTriggerKeywords(skill.content);

      const triggersOverloaded = triggerCount >= 8;

      if (triggersOverloaded) {
        compoundSkills++;
        const reasons = [`${triggerCount} trigger keywords`];
        findings.push({
          findingId: 'workflow-maturity/skill-compound-responsibility',
          severity: 'info',
          title: `Skill \`${skill.name}\` description suggests compound responsibility`,
          detail: `Skill \`${skill.name}\` description suggests compound responsibility — consider splitting or scoping more narrowly. (${reasons.join('; ')})`,
          remediation: `Review \`${skill.name}\` and split into focused skills if it handles multiple distinct concerns.`,
          context: { skill: skill.name, triggerCount },
        });
      }
    }

    // -----------------------------------------------------------------------
    // Check 3 — mcp-single-consumer
    // -----------------------------------------------------------------------
    const mcpServers = await discoverMcpServers(cwd, homedir);
    let mcpServersChecked = mcpServers.length;
    let mcpSingleConsumer = 0;

    if (mcpServers.length > 0) {
      // Build combined skill content corpus for grep
      const allSkillContent = skills.map(s => s.content).join('\n');

      for (const serverName of mcpServers) {
        const re = new RegExp(serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        // Count how many individual skill files reference this server
        let consumerCount = 0;
        for (const skill of skills) {
          if (re.test(skill.content)) consumerCount++;
        }

        if (consumerCount <= 1) {
          mcpSingleConsumer++;
          findings.push({
            findingId: 'workflow-maturity/mcp-single-consumer',
            severity: 'warning',
            title: `MCP server \`${serverName}\` has ≤1 discoverable consumer`,
            detail: `MCP server \`${serverName}\` has ≤1 discoverable consumer — MCP overhead requires at least 2 consumers to justify.`,
            remediation: `Either add \`${serverName}\` references to more skills or evaluate whether this MCP server is still needed.`,
            context: { serverName, consumerCount },
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Check 4 — memory-orphan
    // -----------------------------------------------------------------------
    let orphanMemoryFiles = 0;
    const memoryDirs = await discoverMemoryDirs(cwd, homedir);

    for (const [memDir, fileSet] of memoryDirs) {
      const indexPath = path.join(memDir, 'MEMORY.md');
      const indexContent = await readFileSafe(indexPath);
      if (!indexContent) {
        // No index — all non-index .md files are effectively orphans
        for (const f of fileSet) {
          if (f === 'MEMORY.md') continue;
          orphanMemoryFiles++;
          findings.push({
            findingId: 'workflow-maturity/memory-orphan',
            severity: 'warning',
            title: `\`${f}\` is not linked from MEMORY.md`,
            detail: `\`${path.join(memDir, f)}\` is not linked from MEMORY.md — orphan memory biases responses without visibility.`,
            remediation: `Add a link to \`${f}\` in the MEMORY.md index for this project.`,
            context: { file: f, memDir },
          });
        }
        continue;
      }

      const linkedFiles = extractLinkedFiles(indexContent);
      for (const f of fileSet) {
        if (f === 'MEMORY.md') continue;
        if (!linkedFiles.has(f)) {
          orphanMemoryFiles++;
          findings.push({
            findingId: 'workflow-maturity/memory-orphan',
            severity: 'warning',
            title: `\`${f}\` is not linked from MEMORY.md`,
            detail: `\`${path.join(memDir, f)}\` is not linked from MEMORY.md — orphan memory biases responses without visibility.`,
            remediation: `Add a link to \`${f}\` in the MEMORY.md index in \`${memDir}\`.`,
            context: { file: f, memDir },
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Check 5 — pipeline-step-overload
    // -----------------------------------------------------------------------
    let pipelinesChecked = 0;
    let overloadedPipelines = 0;

    const pipelineFiles = await findFiles(cwd, name =>
      /^(pipeline|orchestrator).*\.py$/i.test(name) ||
      /.*_stage\.py$/i.test(name),
    );

    for (const filePath of pipelineFiles) {
      const content = await readFileSafe(filePath);
      if (!content) continue;
      pipelinesChecked++;

      const markerCount = countStageMarkers(content);
      if (markerCount >= 10) {
        overloadedPipelines++;
        const relPath = path.relative(cwd, filePath);
        findings.push({
          findingId: 'workflow-maturity/pipeline-step-overload',
          severity: 'info',
          title: `Pipeline \`${relPath}\` has ${markerCount} stage markers`,
          detail: `Pipeline \`${relPath}\` has ${markerCount} stage markers — consider sub-pipeline decomposition.`,
          remediation: `Break \`${relPath}\` into sub-pipeline modules, each handling a focused phase.`,
          context: { file: relPath, markerCount },
        });
      }
    }

    // Distributed architecture detection: stage/phase directories with 10+ modules
    const stageDirs = await findDirsNamed(cwd, stageDirNames);
    for (const stageDir of stageDirs) {
      try {
        const entries = await fs.promises.readdir(stageDir);
        const pyFiles = entries.filter(e => e.endsWith('.py') && !e.startsWith('_'));
        if (pyFiles.length >= 10) {
          overloadedPipelines++;
          const relDir = path.relative(cwd, stageDir);
          findings.push({
            findingId: 'workflow-maturity/stage-dir-overload',
            severity: 'info',
            title: `Pipeline directory \`${relDir}/\` has ${pyFiles.length} stage modules`,
            detail: `Directory \`${relDir}/\` contains ${pyFiles.length} stage/phase modules — consider grouping related stages into sub-pipelines.`,
            remediation: `Group related stages in \`${relDir}/\` into sub-pipeline packages to reduce orchestration breadth.`,
            context: { dir: relDir, moduleCount: pyFiles.length },
          });
        }
      } catch { /* ok */ }
    }

    // -----------------------------------------------------------------------
    // N/A guard — nothing to scan at all
    // -----------------------------------------------------------------------
    const hasAnything =
      skillsChecked > 0 ||
      mcpServersChecked > 0 ||
      pipelinesChecked > 0 ||
      overloadedPipelines > 0 ||
      memoryDirs.size > 0;

    if (!hasAnything) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };
    }

    // If no issues found, emit a pass
    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Workflow maturity checks passed',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        skillsChecked,
        skillsWithoutEvals,
        compoundSkills,
        mcpServersChecked,
        mcpSingleConsumer,
        orphanMemoryFiles,
        pipelinesChecked,
        overloadedPipelines,
      },
    };
  },
};
