import fs from 'node:fs';
import path from 'node:path';
import { loadChecks } from './checks/index.js';
import { calculateOverallScore } from './scoring.js';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from './constants.js';
import { loadConfig, resolveWeights } from './config.js';

/**
 * Run an array of checks against a context, collect results.
 * Uses Promise.allSettled so one failing check doesn't block others.
 */
export async function runChecks(checks, context, options = {}) {
  const { checkFilter } = options;

  let filtered = checks;
  if (checkFilter) {
    filtered = checks.filter((c) => c.id === checkFilter);
  }

  const settled = await Promise.allSettled(
    filtered.map(async (check) => {
      const result = await check.run(context);
      return {
        id: check.id,
        name: check.name,
        category: check.category,
        weight: WEIGHTS[check.id] || check.weight || 0,
        score: result.score,
        findings: result.findings,
        ...(result.data !== undefined && { data: result.data }),
      };
    }),
  );

  return settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    // Check threw — return score 0 with a CRITICAL finding
    const check = filtered[i];
    return {
      id: check.id,
      name: check.name,
      category: check.category,
      weight: WEIGHTS[check.id] || check.weight || 0,
      score: 0,
      findings: [
        {
          severity: 'critical',
          title: `Check "${check.id}" failed to run`,
          detail: outcome.reason?.message || 'Unknown error',
        },
      ],
    };
  });
}

/**
 * Full scan: load checks, run them, calculate scores.
 */
export async function scan(options = {}) {
  const cwd = options.cwd || process.cwd();
  const checks = await loadChecks({ cwd });
  const homedir = options.homedir || (await import('node:os')).homedir();
  const config = await loadConfig(cwd, homedir);

  // Merge CLI profile into config
  if (options.profile) {
    config.profile = options.profile;
  }

  const context = { cwd, homedir, config, deep: options.deep || false, online: options.online || false };

  // Split checks into regular and coherence (two-pass)
  const regularChecks = checks.filter(c => c.id !== 'coherence');
  const coherenceCheck = checks.find(c => c.id === 'coherence');

  // Pass 1: Run all regular checks
  const results = await runChecks(regularChecks, context, options);

  // Pass 2: Run coherence check with prior results
  if (coherenceCheck && (!options.checkFilter || options.checkFilter === 'coherence')) {
    const coherenceContext = { ...context, priorResults: results };
    const coherenceResults = await runChecks([coherenceCheck], coherenceContext, {});
    results.push(...coherenceResults);
  }

  // When filtering to specific checks, use average of their scores
  // instead of weighted system (which assumes all checks are present)
  let overallScore;
  if (options.checkFilter) {
    const applicable = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
    const avg = applicable.length > 0
      ? applicable.reduce((sum, r) => sum + r.score, 0) / applicable.length
      : 0;
    overallScore = Math.round(avg);
  } else {
    const weights = resolveWeights(config);
    overallScore = calculateOverallScore(results, weights);
  }

  return { score: overallScore, results };
}

// Files that indicate a directory is a scannable project
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
  'CLAUDE.md', '.cursorrules', '.windsurfrules', '.clinerules',
  '.continuerules', 'AGENTS.md', '.mcp.json',
  '.env', '.sops.yaml',
];

/**
 * Discover project directories under rootDir up to maxDepth levels.
 * A directory is a project if it contains any PROJECT_MARKERS file.
 */
export async function discoverProjects(rootDir, maxDepth = 1) {
  const projects = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`rigscore: could not read directory ${dir}: ${err.message}`);
      return;
    }

    // Skip hidden dirs, node_modules, venv, .git
    const subdirs = entries.filter((e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      e.name !== 'node_modules' &&
      e.name !== 'venv' &&
      e.name !== '__pycache__',
    );

    for (const sub of subdirs) {
      const subPath = path.join(dir, sub.name);
      let subEntries;
      try {
        subEntries = await fs.promises.readdir(subPath);
      } catch (err) {
        console.warn(`rigscore: could not read directory ${subPath}: ${err.message}`);
        continue;
      }

      const hasMarker = PROJECT_MARKERS.some((m) => subEntries.includes(m));
      if (hasMarker) {
        projects.push(subPath);
      }

      // Recurse deeper
      if (depth + 1 <= maxDepth) {
        await walk(subPath, depth + 1);
      }
    }
  }

  // Check if rootDir itself is a project
  try {
    const rootEntries = await fs.promises.readdir(rootDir);
    const rootHasMarker = PROJECT_MARKERS.some((m) => rootEntries.includes(m));
    if (rootHasMarker) {
      projects.push(rootDir);
    }
  } catch {
    // Can't read root — skip
  }

  await walk(rootDir, 1);
  return projects.sort();
}

/**
 * Recursive scan: discover projects under rootDir, scan each, aggregate.
 * Returns { score, projects: [{ path, score, results }] }.
 */
export async function scanRecursive(options = {}) {
  const rootDir = options.cwd || process.cwd();
  const maxDepth = options.depth || 1;

  const projectDirs = await discoverProjects(rootDir, maxDepth);

  if (projectDirs.length === 0) {
    return {
      score: 0,
      projects: [],
      error: `No projects found under ${rootDir} (depth ${maxDepth})`,
    };
  }

  // Scan projects concurrently with a limit of 4
  const CONCURRENCY = 4;
  const projects = [];
  for (let i = 0; i < projectDirs.length; i += CONCURRENCY) {
    const batch = projectDirs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (dir) => {
        const result = await scan({ ...options, cwd: dir });
        return {
          path: path.relative(rootDir, dir) || path.basename(dir),
          absolutePath: dir,
          score: result.score,
          results: result.results,
        };
      }),
    );
    projects.push(...batchResults);
  }

  // Overall score = average across projects (excluding all-N/A projects with score 0)
  const scorable = projects.filter((p) => p.score > 0 || p.results.some((r) => r.score !== NOT_APPLICABLE_SCORE && r.score !== undefined));
  const avgScore = scorable.length > 0
    ? Math.round(scorable.reduce((sum, p) => sum + p.score, 0) / scorable.length)
    : 0;

  // Track the worst-scoring project for catastrophic warnings
  const worstProject = projects.length > 0
    ? projects.reduce((worst, p) => (p.score < worst.score ? p : worst), projects[0])
    : null;

  return { score: avgScore, projects, worstProject };
}
