import fs from 'node:fs';
import path from 'node:path';
import { loadChecks } from './checks/index.js';
import { calculateOverallScore, calculateCheckScore } from './scoring.js';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from './constants.js';
import { loadConfig, resolveWeights } from './config.js';

/**
 * Deduplicate findings across check results.
 * When two checks produce findings with the same severity+title,
 * keep the one from the higher-weighted check.
 */
function deduplicateFindings(results) {
  const seen = new Map(); // "severity:normalizedTitle" → { resultIdx, findingIdx, weight }
  const toRemove = [];    // { resultIdx, findingIdx } pairs to batch-remove after scan

  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri];
    const weight = WEIGHTS[r.id] || 0;
    const findings = r.findings || [];

    for (let fi = findings.length - 1; fi >= 0; fi--) {
      const f = findings[fi];
      if (!f.title || f.severity === 'pass' || f.severity === 'info') continue;

      // Normalize: strip file paths and trailing details for comparison
      const normalized = f.title.replace(/\s+in\s+\S+$/, '').replace(/:\s+\S+$/, '').trim();
      const key = `${f.severity}:${normalized}`;

      if (seen.has(key)) {
        const prev = seen.get(key);
        if (weight >= prev.weight) {
          // Current check has higher weight — mark previous for removal
          toRemove.push({ resultIdx: prev.resultIdx, findingIdx: prev.findingIdx });
          seen.set(key, { resultIdx: ri, findingIdx: fi, weight });
        } else {
          // Previous check has higher weight — mark current for removal
          toRemove.push({ resultIdx: ri, findingIdx: fi });
        }
      } else {
        seen.set(key, { resultIdx: ri, findingIdx: fi, weight });
      }
    }
  }

  // Group by resultIdx, sort findingIdx descending, then splice safely
  const grouped = new Map();
  for (const { resultIdx, findingIdx } of toRemove) {
    if (!grouped.has(resultIdx)) grouped.set(resultIdx, []);
    grouped.get(resultIdx).push(findingIdx);
  }
  for (const [ri, indices] of grouped) {
    indices.sort((a, b) => b - a);
    for (const fi of indices) {
      results[ri].findings.splice(fi, 1);
    }
  }
}

/**
 * Slugify a finding title into a stable ID component.
 * "env file found but NOT in .gitignore" → "env-file-found-but-not-in-gitignore"
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Assign findingId to all findings that don't already have one.
 * Convention: {checkId}/{slugified-title}
 */
export function assignFindingIds(results) {
  for (const r of results) {
    for (const f of r.findings) {
      if (!f.findingId) {
        f.findingId = `${r.id}/${slugify(f.title || 'unknown')}`;
      }
    }
  }
}

/**
 * Suppress findings whose title matches any of the given patterns (case-insensitive).
 * Recalculates each affected check's score after removal.
 */
export function suppressFindings(results, patterns) {
  if (!patterns || patterns.length === 0) return;

  for (const r of results) {
    const before = r.findings.length;
    r.findings = r.findings.filter((f) => {
      const title = (f.title || '').toLowerCase();
      return !patterns.some((p) => title.includes(p.toLowerCase()));
    });
    if (r.findings.length !== before) {
      r.score = calculateCheckScore(r.findings);
    }
  }
}

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

      // Validate result shape: must have numeric score and findings array
      if (!result || typeof result.score !== 'number' || !Array.isArray(result.findings)) {
        return {
          id: check.id,
          name: check.name,
          category: check.category,
          weight: WEIGHTS[check.id] || check.weight || 0,
          score: 0,
          findings: [{
            severity: 'critical',
            title: `Check "${check.id}" returned invalid result`,
            detail: 'Expected { score: number, findings: Array } but got an invalid shape.',
          }],
        };
      }

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

  // Split checks into pass 1 (default) and pass 2 (receive priorResults)
  const pass1Checks = checks.filter(c => !c.pass || c.pass === 1);
  const pass2Checks = checks.filter(c => c.pass === 2);

  // Pass 1: Run all regular checks
  const results = await runChecks(pass1Checks, context, options);

  // Pass 2: Run checks that consume prior results (coherence, network-exposure, etc.)
  if (pass2Checks.length > 0) {
    const pass2Filtered = options.checkFilter
      ? pass2Checks.filter(c => c.id === options.checkFilter)
      : pass2Checks;
    if (pass2Filtered.length > 0) {
      const pass2Context = { ...context, priorResults: structuredClone(results) };
      const pass2Results = await runChecks(pass2Filtered, pass2Context, {});
      results.push(...pass2Results);
    }
  }

  // Deduplicate findings across checks — keep finding from higher-weighted check
  deduplicateFindings(results);

  // Assign stable finding IDs
  assignFindingIds(results);

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

  return { score: overallScore, results, config };
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
      process.stderr.write(`rigscore: could not read directory ${dir}: ${err.message}\n`);
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
        process.stderr.write(`rigscore: could not read directory ${subPath}: ${err.message}\n`);
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

  const failUnder = options.failUnder || 70;
  const allPassed = projects.every((p) => p.score >= failUnder);

  return { score: avgScore, projects, worstProject, allPassed };
}
