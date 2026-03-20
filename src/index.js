import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive } from './scanner.js';
import { formatTerminal, formatTerminalRecursive, formatJson, formatBadge } from './reporter.js';
import { formatSarif, formatSarifMulti } from './sarif.js';
import { findApplicableFixes, applyFixes } from './fixer.js';

export function parseArgs(args) {
  const options = {
    json: false,
    badge: false,
    sarif: false,
    fix: false,
    yes: false,
    noColor: false,
    noCta: false,
    verbose: false,
    checkFilter: null,
    cwd: null,
    recursive: false,
    depth: 1,
    deep: false,
    online: false,
    failUnder: 70,
    profile: null,
    initHook: false,
    watch: false,
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

  if (options.initHook) {
    const path = await import('node:path');
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

    if (existing.includes('rigscore')) {
      process.stderr.write('rigscore hook already installed in .git/hooks/pre-commit\n');
      process.exit(0);
    }

    // Create hooks dir if needed
    fs.mkdirSync(hooksDir, { recursive: true });

    const hookContent = '#!/bin/sh\nnpx rigscore --fail-under 70 --no-cta || exit 1\n';

    if (existing) {
      // Append to existing hook
      fs.appendFileSync(hookPath, '\n# rigscore hygiene check\n' + 'npx rigscore --fail-under 70 --no-cta || exit 1\n');
    } else {
      fs.writeFileSync(hookPath, hookContent);
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
    profile: options.profile,
  };

  if (options.recursive) {
    const result = await scanRecursive({ ...scanOptions, depth: options.depth });

    if (result.error) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }

    if (options.sarif) {
      // SARIF for recursive: one run per project
      process.stdout.write(JSON.stringify(formatSarifMulti(result.projects), null, 2) + '\n');
    } else if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else {
      process.stdout.write(formatTerminalRecursive(result, cwd, { noCta: options.noCta }) + '\n');
    }

    process.exit(result.score >= options.failUnder ? 0 : 1);
  } else {
    const result = await scan(scanOptions);

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

    if (options.watch) {
      const { startWatching } = await import('./watcher.js');
      await startWatching(cwd, args, options);
    } else {
      process.exit(result.score >= options.failUnder ? 0 : 1);
    }
  }
}
