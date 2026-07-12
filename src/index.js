import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive, suppressFindings } from './scanner.js';
import { calculateOverallScore } from './scoring.js';
import { resolveWeights } from './config.js';
import { NOT_APPLICABLE_SCORE } from './constants.js';
import { formatTerminal, formatTerminalRecursive, formatJson, formatBadge } from './reporter.js';
import { formatSarif, formatSarifMulti } from './sarif.js';
import { findApplicableFixes, applyFixes } from './fixer.js';
import { PROFILE_HINTS } from './config.js';
import { ConfigParseError } from './utils.js';

/**
 * Parse rigscore's CLI argument vector into a normalized options object.
 *
 * Recognized flags (subset; see `--help` for the full list): --json,
 * --sarif, --badge, --ci (implies --sarif/--no-color/--no-cta), --check
 * <id>, --recursive/-r, --depth <N> (implies --recursive), --deep,
 * --online, --refresh-mcp-registry (implies --online), --fail-under <N>
 * (clamped 0-100), --profile <name>, --fix, --yes/-y, --init-hook,
 * --watch, --ignore <comma-list>, --baseline <path>.
 *
 * A bare positional argument is treated as the target directory; only
 * the last positional wins. Unknown flags are ignored (subcommands like
 * `init`, `explain`, `diff` are dispatched in bin/rigscore.js before
 * parseArgs sees them).
 *
 * @param {string[]} args - argv slice (typically `process.argv.slice(2)`).
 * @returns {Options} Normalized options with defaults filled in.
 */
export function parseArgs(args) {
  const options = {
    json: false,
    badge: false,
    sarif: false,
    fix: false,
    yes: false,
    noColor: false,
    noCta: true,
    verbose: false,
    report: null,
    checkFilter: null,
    cwd: null,
    recursive: false,
    depth: 1,
    deep: false,
    online: false,
    refreshMcpRegistry: false,
    includeHomeSkills: false,
    failUnder: 70,
    profile: null,
    initHook: false,
    watch: false,
    ignore: null,
    baseline: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const def = FLAG_DEFS[arg];
    if (def) {
      if (def.takesValue) {
        // Match prior behavior: a value-taking flag at the end of argv
        // with no following arg is silently ignored, not errored.
        if (i + 1 >= args.length) continue;
        def.handler(options, args[++i]);
      } else {
        def.handler(options);
      }
    } else if (!arg.startsWith('-')) {
      // Bare positional → target directory; last positional wins.
      options.cwd = arg;
    }
    // Unknown --flag is silently ignored (preserves the prior contract;
    // forward-compat for CI scripts that pass through extra flags).
  }

  return options;
}

/**
 * Flag dispatch table for parseArgs. Replaces a 21-branch if/else chain
 * with O(1) lookup keyed by literal arg. Each entry exposes:
 *   - `takesValue` (optional bool): consumes the next argv slot as `v`
 *   - `handler(options[, value])`: applies the flag's effect, including
 *      any implication chains (e.g., `--ci` → sarif + noColor + noCta).
 *
 * Aliases (`--verbose`/`-v`, `--recursive`/`-r`, `--yes`/`-y`) share a
 * handler object reference so they remain trivially in sync.
 */
const FLAG_DEFS = (() => {
  const setTrue = (key) => (o) => { o[key] = true; };
  const setStr = (key) => (o, v) => { o[key] = v; };

  const verbose = { handler: setTrue('verbose') };
  const recursive = { handler: setTrue('recursive') };
  const yes = { handler: setTrue('yes') };

  return {
    // Plain booleans
    '--json':                 { handler: setTrue('json') },
    '--badge':                { handler: setTrue('badge') },
    '--sarif':                { handler: setTrue('sarif') },
    '--no-color':             { handler: setTrue('noColor') },
    '--no-cta':               { handler: setTrue('noCta') },
    '--cta':                  { handler: (o) => { o.noCta = false; } },
    '--deep':                 { handler: setTrue('deep') },
    '--online':               { handler: setTrue('online') },
    '--include-home-skills':  { handler: setTrue('includeHomeSkills') },
    '--fix':                  { handler: setTrue('fix') },
    '--init-hook':            { handler: setTrue('initHook') },
    '--watch':                { handler: setTrue('watch') },

    // Aliased booleans
    '--verbose': verbose, '-v': verbose,
    '--recursive': recursive, '-r': recursive,
    '--yes': yes, '-y': yes,

    // Implication chains
    '--refresh-mcp-registry': { handler: (o) => { o.refreshMcpRegistry = true; o.online = true; } },
    '--ci':                   { handler: (o) => { o.sarif = true; o.noColor = true; o.noCta = true; } },

    // String-value flags
    '--check':                { takesValue: true, handler: setStr('checkFilter') },
    '--profile':              { takesValue: true, handler: setStr('profile') },
    '--baseline':             { takesValue: true, handler: setStr('baseline') },
    '--report':               { takesValue: true, handler: setStr('report') },
    '--ignore':               { takesValue: true, handler: (o, v) => {
      o.ignore = v.split(',').map((s) => s.trim()).filter(Boolean);
    } },
    '--depth':                { takesValue: true, handler: (o, v) => {
      o.depth = parseInt(v, 10) || 1;
      o.recursive = true; // --depth implies --recursive
    } },
    '--fail-under':           { takesValue: true, handler: (o, v) => {
      const parsed = parseInt(v, 10);
      o.failUnder = Math.max(0, Math.min(100, Number.isNaN(parsed) ? 70 : parsed));
    } },
  };
})();

/**
 * Top-level CLI entrypoint. Parses args, validates the target directory,
 * applies profile hints (recursive/depth defaults from `monorepo` etc.),
 * dispatches to scan() or scanRecursive(), formats output (terminal /
 * JSON / SARIF / badge), applies suppress/ignore patterns, runs --fix
 * if requested, and exits with a status code derived from --fail-under.
 *
 * Exit codes:
 *   0 — clean (score ≥ failUnder, or baseline mode with no new findings)
 *   1 — score below --fail-under, or baseline mode with new findings
 *   2 — argument/config/scan error (delegated to handleFatal / the
 *       top-level unhandledRejection guard in bin/rigscore.js)
 *
 * Special modes that short-circuit normal flow:
 *   --init-hook  — install pre-commit hook and exit
 *   --baseline   — write or diff against baseline; never enters watch loop
 *   --watch      — enter the file-watcher loop; warns on initial below-
 *                  threshold scan instead of exiting (matches watcher.js:47
 *                  "warn-only" intent)
 *
 * @param {string[]} args - argv slice passed in from bin/rigscore.js.
 * @returns {Promise<void>} Resolves once the side effects (stdout/exit) complete.
 */
export async function run(args) {
  const options = parseArgs(args);

  const cwd = options.cwd || process.cwd();

  // Validate directory exists
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      process.stderr.write(`Error: ${cwd} is not a valid directory\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`Error: ${cwd} is not a valid directory\n`);
    process.exit(1);
  }

  // Apply profile hints (recursive / depth defaults from `monorepo` etc.)
  // CLI flags still win: only apply a hint if the user didn't pass the flag.
  // Profile precedence for hint lookup: CLI --profile → config file (read
  // later by scanner) → default. Hints only apply when --profile was set on
  // the CLI explicitly, matching documented monorepo usage.
  if (options.profile && PROFILE_HINTS[options.profile]) {
    const hints = PROFILE_HINTS[options.profile];
    if (hints.recursive === true && !args.includes('--recursive') && !args.includes('-r')) {
      options.recursive = true;
    }
    if (typeof hints.depth === 'number' && !args.includes('--depth')) {
      options.depth = hints.depth;
      options.recursive = true;
    }
  }

  if (options.initHook) {
    // Implementation lives in src/cli/init-hook.js — extracted from run()
    // for readability and to shrink run() under the complexity gate.
    const { runInitHook } = await import('./cli/init-hook.js');
    return runInitHook(cwd);
  }

  if (options.noColor) {
    // Chalk respects the NO_COLOR env var
    process.env.NO_COLOR = '1';
  }

  // A compliance report is a single-subject audit artifact: fail loud on an
  // unknown kind or a recursive run rather than print a lookalike.
  if (options.report && (options.report !== 'compliance' || options.recursive)) {
    const why = options.report !== 'compliance'
      ? `unknown --report kind "${options.report}" (supported: compliance)`
      : '--report cannot be combined with --recursive';
    process.stderr.write(`rigscore: ${why}\n`);
    process.exit(2);
  }

  const scanOptions = {
    cwd,
    homedir: os.homedir(),
    checkFilter: options.checkFilter,
    deep: options.deep,
    online: options.online,
    refreshMcpRegistry: options.refreshMcpRegistry,
    includeHomeSkills: options.includeHomeSkills,
    profile: options.profile,
  };

  // Surface scan failures as a friendly one-liner + exit 2, rather than a
  // Node stack trace. ConfigParseError gets its own user-facing message;
  // anything else is wrapped in a generic "scan failed" line so both the
  // recursive and non-recursive paths exit symmetrically.
  const handleFatal = (err) => {
    if (err instanceof ConfigParseError) {
      process.stderr.write(err.toUserMessage() + '\n');
      process.exit(2);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: scan failed: ${msg}\n`);
    process.exit(2);
  };

  if (options.recursive) {
    // Reject flag combinations that don't have a clean semantic in recursive
    // mode. Per-project --fix output is noisy; --baseline writes a single
    // file that can't represent N projects; --badge of an aggregate has no
    // meaningful score. Fail loud rather than silently no-op.
    const unsupportedRecursiveFlags = [];
    if (options.fix) unsupportedRecursiveFlags.push('--fix');
    if (options.baseline) unsupportedRecursiveFlags.push('--baseline');
    if (options.badge) unsupportedRecursiveFlags.push('--badge');
    if (unsupportedRecursiveFlags.length > 0) {
      process.stderr.write(`rigscore: ${unsupportedRecursiveFlags.join(', ')} not supported in --recursive mode\n`);
      process.exit(2);
    }

    let result;
    try {
      result = await scanRecursive({ ...scanOptions, depth: options.depth, failUnder: options.failUnder });
    } catch (err) {
      handleFatal(err);
      return; // unreachable — handleFatal either exits or rethrows
    }

    if (result.error) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(2);
    }

    // --ignore in recursive mode: apply per-project suppression before formatting.
    // Mirrors the non-recursive branch but doesn't recompute scores — recursive
    // formatters present per-project numbers as-scanned.
    if (options.ignore && options.ignore.length > 0) {
      for (const project of result.projects) {
        if (project.results) suppressFindings(project.results, options.ignore);
      }
    }

    if (options.sarif) {
      // SARIF for recursive: one run per project
      process.stdout.write(JSON.stringify(formatSarifMulti(result.projects), null, 2) + '\n');
    } else if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else {
      process.stdout.write(formatTerminalRecursive(result, cwd, { noCta: options.noCta, verbose: options.verbose }) + '\n');
    }

    // Fail if ANY project is below threshold (fail-fast on worst)
    const allPassed = result.projects.every((p) => p.score >= options.failUnder);
    // Use exitCode + return so Node flushes piped stdout before exiting.
    // On macOS Node 18.17/20, process.exit() truncates buffered JSON output.
    process.exitCode = allPassed ? 0 : 1;
    return;
  } else {
    let result;
    try {
      result = await scan(scanOptions);
    } catch (err) {
      handleFatal(err);
      return; // unreachable — handleFatal always exits
    }

    // Apply suppress/ignore patterns
    const suppressPatterns = [...(result.config?.suppress || []), ...(options.ignore || [])];
    if (suppressPatterns.length > 0) {
      suppressFindings(result.results, suppressPatterns);
      // Mirror scan()'s scoring branch so --check + suppress doesn't fall back
      // to weighted scoring (which dilutes the single-check score).
      if (options.checkFilter) {
        const applicable = result.results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
        const avg = applicable.length > 0
          ? applicable.reduce((sum, r) => sum + r.score, 0) / applicable.length
          : 0;
        result.score = Math.round(avg);
      } else {
        result.score = calculateOverallScore(result.results, resolveWeights(result.config));
      }
    }

    if (options.sarif) {
      process.stdout.write(JSON.stringify(formatSarif(result), null, 2) + '\n');
    } else if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else if (options.badge) {
      process.stdout.write(formatBadge(result) + '\n');
    } else if (options.report === 'compliance') {
      const { formatCompliance } = await import('./compliance.js');
      process.stdout.write(formatCompliance(result) + '\n');
    } else {
      process.stdout.write(formatTerminal(result, cwd, { noCta: options.noCta, verbose: options.verbose }) + '\n');
    }

    // --fix mode: find and apply safe auto-remediations
    if (options.fix) {
      const fixes = findApplicableFixes(result.results);
      if (fixes.length === 0) {
        process.stderr.write('No auto-fixable issues found.\n');
      } else if (!options.yes) {
        // Dry-run: show what would be fixed
        process.stderr.write('\nAuto-fixable issues (dry run):\n');
        for (const fix of fixes) {
          process.stderr.write(`  - ${fix.description}\n`);
        }
        process.stderr.write('\nRun with --fix --yes to apply.\n');
      } else {
        // Apply fixes
        const { applied, skipped } = await applyFixes(fixes, cwd, os.homedir());
        if (applied.length > 0) {
          process.stderr.write('\nFixed:\n');
          for (const a of applied) {
            process.stderr.write(`  \u2713 ${a}\n`);
          }
        }
        if (skipped.length > 0) {
          process.stderr.write('\nSkipped:\n');
          for (const s of skipped) {
            process.stderr.write(`  - ${s}\n`);
          }
        }
      }
    }

    // Baseline mode lives in src/cli/baseline.js (runBaselineMode);
    // extracted from run() for readability. Behavior unchanged.
    if (options.baseline) {
      const { runBaselineMode } = await import('./cli/baseline.js');
      runBaselineMode(result, options.baseline);
    }

    if (options.watch) {
      // Warn on initial below-threshold scan but enter the watch loop —
      // matches watcher.js:47 "warn-only in loop" intent. The previous
      // hard-exit(1) made --watch unusable on projects that started red,
      // even though that's exactly when you'd want to watch for fixes.
      if (options.failUnder && result.score < options.failUnder) {
        process.stderr.write(
          `\nWarning: score ${result.score} is below --fail-under ${options.failUnder} ` +
          '(entering watch mode anyway)\n',
        );
      }
      const { startWatching } = await import('./watcher.js');
      await startWatching(cwd, args, options);
    } else {
      // Use exitCode + return so Node flushes piped stdout before exiting.
      // On macOS Node 18.17/20, process.exit() truncates buffered JSON output.
      process.exitCode = result.score >= options.failUnder ? 0 : 1;
      return;
    }
  }
}
