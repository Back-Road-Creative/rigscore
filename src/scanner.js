import fs from 'node:fs';
import path from 'node:path';
import { loadChecks } from './checks/index.js';
import { calculatePracticeScore, scoreScan } from './scoring.js';
import { NOT_APPLICABLE_SCORE } from './constants.js';
import { loadConfig, resolveWeights } from './config.js';
import { governanceFiles, repoMcpRelPaths } from './clients.js';
import {
  deduplicateFindings,
  assignFindingIds,
  suppressFindings,
} from './findings.js';
import { runChecks } from './runner.js';

// Re-export findings utilities so existing
// `import { suppressFindings } from './scanner.js'` paths keep working.
export { deduplicateFindings, assignFindingIds, suppressFindings };

// Re-export runChecks so existing `import { runChecks } from './scanner.js'`
// paths (e.g. test/scanner.test.js) keep working.
export { runChecks };

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

  const context = {
    cwd,
    homedir,
    config,
    deep: options.deep || false,
    online: options.online || false,
    // Opt-in `--semantic` tool-description judge. The semantic-tools check is a
    // no-op returning N/A (zero external calls) unless this is true.
    semantic: options.semantic || false,
    refreshMcpRegistry: options.refreshMcpRegistry || false,
    includeHomeSkills: options.includeHomeSkills || false,
    // Absolute host paths the windows-security WSL-guest arm reads (`/etc/wsl.conf`,
    // `/proc/sys/kernel/osrelease`). Injectable — like `homedir` — so a scan is never
    // at the mercy of whether the machine running it happens to be a WSL guest; the
    // check supplies the production defaults when these are undefined.
    wslConfPath: options.wslConfPath,
    wslOsReleasePath: options.wslOsReleasePath,
    // The one write a scan makes (the mcp-config TOFU pin). Default ON: the pin
    // IS the rug-pull detection substrate, so opting out has to be deliberate
    // (`--no-state-write`), and mcp-config discloses the run that opted out.
    writeState: options.writeState !== false,
  };

  // Split checks into pass 1 (default) and pass 2 (receive priorResults)
  const pass1Checks = checks.filter(c => !c.pass || c.pass === 1);
  const pass2Checks = checks.filter(c => c.pass === 2);

  // Resolve weights ONCE, up front — the runner stamps `result.weight` from
  // this map so a check disabled in `.rigscorerc.json` (weight 0) renders as
  // 0, not its full static weight. Both passes get it; scoring reuses it.
  const weights = resolveWeights(config);

  // Pass 1: Run all regular checks
  const results = await runChecks(pass1Checks, context, { ...options, resolvedWeights: weights });

  // Pass 2: Run checks that consume prior results (coherence, network-exposure, etc.)
  if (pass2Checks.length > 0) {
    const pass2Filtered = options.checkFilter
      ? pass2Checks.filter(c => c.id === options.checkFilter)
      : pass2Checks;
    if (pass2Filtered.length > 0) {
      const pass2Context = { ...context, priorResults: structuredClone(results) };
      const pass2Results = await runChecks(pass2Filtered, pass2Context, { resolvedWeights: weights });
      results.push(...pass2Results);
    }
  }

  // Deduplicate findings across checks — keep finding from higher-weighted check
  deduplicateFindings(results);

  // Assign stable finding IDs
  assignFindingIds(results);

  // Single scorer for every path (see scoreScan). `notApplicable` is true when a
  // --check filter selected only N/A checks: nothing to score → `null`, not a 0.
  const { score: overallScore, notApplicable } = scoreScan(results, weights, options.checkFilter);

  return {
    score: overallScore,
    notApplicable,
    results,
    config,
    // Second axis; `null` when the repo has no practice surface. A getter, not
    // a snapshot: the CLI suppresses findings AFTER scan() returns, rewriting
    // per-check scores in place — a plain value would go stale in exactly that
    // path. JSON.stringify invokes it, so `--json` carries it for free.
    get practiceScore() {
      return calculatePracticeScore(results);
    },
  };
}

// Build/language/secret markers that are not AI-client governance (stay listed).
const BUILD_MARKERS = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
  '.env', '.sops.yaml',
];

// Files that indicate a directory is a scannable project. The AI-client markers
// (governance files + committed MCP configs) are DERIVED from the client registry
// (RS-8) so a newly-registered client (GEMINI.md, QWEN.md, CRUSH.md, opencode.json,
// ...) makes its directory a recognized project automatically. Only single-segment
// (top-level) registry names can be matched by the flat readdir below; nested paths
// like `.cursor/mcp.json` are recognized via their parent build files, not a basename.
const PROJECT_MARKERS = [...new Set([
  ...BUILD_MARKERS,
  ...governanceFiles(),
  ...repoMcpRelPaths(),
].filter((m) => !m.includes('/')))];

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
          notApplicable: result.notApplicable,
          results: result.results,
          // The project's OWN config — the CLI needs it to honor that project's
          // `suppress:` and rescore. Without it the recursive escape hatch was inert.
          config: result.config,
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
