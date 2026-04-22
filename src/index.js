import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive, suppressFindings } from './scanner.js';
import { formatTerminal, formatTerminalRecursive, formatJson, formatBadge } from './reporter.js';
import { formatSarif, formatSarifMulti } from './sarif.js';
import { findApplicableFixes, applyFixes } from './fixer.js';
import { PROFILE_HINTS } from './config.js';
import { ConfigParseError } from './utils.js';

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
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--badge') {
      options.badge = true;
    } else if (arg === '--sarif') {
      options.sarif = true;
    } else if (arg === '--no-color') {
      options.noColor = true;
    } else if (arg === '--no-cta') {
      options.noCta = true;
    } else if (arg === '--cta') {
      options.noCta = false;
    } else if (arg === '--check' && i + 1 < args.length) {
      options.checkFilter = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--recursive' || arg === '-r') {
      options.recursive = true;
    } else if (arg === '--depth' && i + 1 < args.length) {
      options.depth = parseInt(args[++i], 10) || 1;
      options.recursive = true; // --depth implies --recursive
    } else if (arg === '--deep') {
      options.deep = true;
    } else if (arg === '--online') {
      options.online = true;
    } else if (arg === '--refresh-mcp-registry') {
      options.refreshMcpRegistry = true;
      options.online = true; // implies --online
    } else if (arg === '--include-home-skills') {
      options.includeHomeSkills = true;
    } else if (arg === '--fail-under' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      options.failUnder = Math.max(0, Math.min(100, Number.isNaN(parsed) ? 70 : parsed));
    } else if (arg === '--profile' && i + 1 < args.length) {
      options.profile = args[++i];
    } else if (arg === '--fix') {
      options.fix = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--init-hook') {
      options.initHook = true;
    } else if (arg === '--watch') {
      options.watch = true;
    } else if (arg === '--ignore' && i + 1 < args.length) {
      options.ignore = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--baseline' && i + 1 < args.length) {
      options.baseline = args[++i];
    } else if (arg === '--ci') {
      options.sarif = true;
      options.noColor = true;
      options.noCta = true;
    } else if (!arg.startsWith('-')) {
      options.cwd = arg;
    }
  }

  return options;
}

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
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    const version = pkg.version;

    const hooksDir = path.default.join(cwd, '.git', 'hooks');
    const hookPath = path.default.join(hooksDir, 'pre-commit');

    // Check if .git exists
    try {
      fs.statSync(path.default.join(cwd, '.git'));
    } catch {
      process.stderr.write('Error: No .git directory found. Run git init first.\n');
      process.exit(1);
    }

    // Check if hook already has rigscore
    let existing = '';
    try { existing = fs.readFileSync(hookPath, 'utf8'); } catch {}

    // Detect an older pinned version and nudge the user to re-init rather
    // than silently appending a second line that shadows the first.
    const pinnedMatch = existing.match(/rigscore@v(\d+\.\d+\.\d+)/);
    if (existing.includes('rigscore')) {
      if (pinnedMatch && pinnedMatch[1] !== version) {
        process.stderr.write(
          `rigscore hook already installed (pinned to v${pinnedMatch[1]}; ` +
          `current version v${version}). Re-run 'rigscore --init-hook' after ` +
          `editing the old line out of .git/hooks/pre-commit to re-pin.\n`,
        );
      } else {
        process.stderr.write('rigscore hook already installed in .git/hooks/pre-commit\n');
      }
      process.exit(0);
    }

    // Create hooks dir if needed
    fs.mkdirSync(hooksDir, { recursive: true });

    // Pin to the release tag matching the currently-installed rigscore
    // version. An unpinned npx github:… install would let any default-branch
    // compromise propagate to every adopter on their next commit.
    const pinnedCmd = `npx -y github:Back-Road-Creative/rigscore@v${version} --fail-under 70 --no-cta || exit 1`;
    const pinnedComment = `# rigscore pinned to v${version}. Re-run 'rigscore --init-hook' after upgrading to re-pin.`;

    if (existing) {
      // Append to existing hook
      fs.appendFileSync(hookPath, `\n${pinnedComment}\n${pinnedCmd}\n`);
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh\n${pinnedComment}\n${pinnedCmd}\n`);
    }

    fs.chmodSync(hookPath, 0o755);
    process.stderr.write('Installed rigscore pre-commit hook in .git/hooks/pre-commit\n');
    process.exit(0);
  }

  if (options.noColor) {
    // Chalk respects the NO_COLOR env var
    process.env.NO_COLOR = '1';
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

  // Surface malformed user config as a friendly one-liner + exit 2, rather
  // than a Node stack trace. Anything else bubbles up as-is.
  const handleFatal = (err) => {
    if (err instanceof ConfigParseError) {
      process.stderr.write(err.toUserMessage() + '\n');
      process.exit(2);
    }
    throw err;
  };

  if (options.recursive) {
    let result;
    try {
      result = await scanRecursive({ ...scanOptions, depth: options.depth });
    } catch (err) {
      handleFatal(err);
      return; // unreachable — handleFatal either exits or rethrows
    }

    if (result.error) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(2);
    }

    if (options.sarif) {
      // SARIF for recursive: one run per project
      process.stdout.write(JSON.stringify(formatSarifMulti(result.projects), null, 2) + '\n');
    } else if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else {
      process.stdout.write(formatTerminalRecursive(result, cwd, { noCta: options.noCta }) + '\n');
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
      if (err instanceof ConfigParseError) {
        process.stderr.write(err.toUserMessage() + '\n');
        process.exit(2);
      }
      process.stderr.write(`Error: scan failed: ${err.message}\n`);
      process.exit(2);
    }

    // Apply suppress/ignore patterns
    const suppressPatterns = [...(result.config?.suppress || []), ...(options.ignore || [])];
    if (suppressPatterns.length > 0) {
      suppressFindings(result.results, suppressPatterns);
    }

    if (options.sarif) {
      process.stdout.write(JSON.stringify(formatSarif(result), null, 2) + '\n');
    } else if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else if (options.badge) {
      process.stdout.write(formatBadge(result) + '\n');
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

    // Baseline mode: on first run write baseline + exit 0; on subsequent
    // runs compare and gate exit code on the count of NEW findings.
    if (options.baseline) {
      const { buildBaseline, loadBaseline, writeBaseline, diffFindings, flattenFindings } =
        await import('./cli/baseline.js');
      const existing = loadBaseline(options.baseline);
      if (!existing) {
        const newBaseline = buildBaseline(result);
        writeBaseline(options.baseline, newBaseline);
        process.stderr.write(
          `rigscore: wrote new baseline to ${options.baseline} ` +
          `(${newBaseline.findings.length} findings pinned).\n`,
        );
        process.exit(0);
      }
      const currentFindings = flattenFindings(result.results);
      const added = diffFindings(existing.findings, currentFindings);
      if (added.length === 0) {
        process.stderr.write(`rigscore: no new findings vs baseline (${existing.findings.length} pinned).\n`);
        process.exit(0);
      }
      process.stderr.write(
        `rigscore: ${added.length} new findings vs baseline ` +
        `(baseline timestamp: ${existing.timestamp}):\n`,
      );
      for (const f of added) {
        process.stderr.write(`  [${f.severity}] ${f.findingId} — ${f.title}\n`);
      }
      // Gate on new findings count vs fail-under interpreted as "max new".
      // failUnder default is 70 (score-based); for baseline semantics we
      // treat any new finding as failing unless the user passes an
      // explicit non-default. Matches the "exit on new findings" contract.
      process.exit(added.length > 0 ? 1 : 0);
    }

    if (options.watch) {
      // Fail fast on initial scan — watch loop is warn-only
      if (result.score < options.failUnder) {
        process.exit(1);
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
