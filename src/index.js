import fs from 'node:fs';
import os from 'node:os';
import { scan, scanRecursive } from './scanner.js';
import { formatTerminal, formatTerminalRecursive, formatJson, formatBadge } from './reporter.js';

function parseArgs(args) {
  const options = {
    json: false,
    badge: false,
    noColor: false,
    noCta: false,
    checkFilter: null,
    cwd: null,
    recursive: false,
    depth: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--badge') {
      options.badge = true;
    } else if (arg === '--no-color') {
      options.noColor = true;
    } else if (arg === '--no-cta') {
      options.noCta = true;
    } else if (arg === '--check' && i + 1 < args.length) {
      options.checkFilter = args[++i];
    } else if (arg === '--recursive' || arg === '-r') {
      options.recursive = true;
    } else if (arg === '--depth' && i + 1 < args.length) {
      options.depth = parseInt(args[++i], 10) || 1;
      options.recursive = true; // --depth implies --recursive
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

  if (options.noColor) {
    // Chalk respects the NO_COLOR env var
    process.env.NO_COLOR = '1';
  }

  const scanOptions = {
    cwd,
    homedir: os.homedir(),
    checkFilter: options.checkFilter,
  };

  if (options.recursive) {
    const result = await scanRecursive({ ...scanOptions, depth: options.depth });

    if (result.error) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }

    if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else {
      process.stdout.write(formatTerminalRecursive(result, cwd, { noCta: options.noCta }) + '\n');
    }

    process.exit(result.score >= 70 ? 0 : 1);
  } else {
    const result = await scan(scanOptions);

    if (options.json) {
      process.stdout.write(formatJson(result) + '\n');
    } else if (options.badge) {
      process.stdout.write(formatBadge(result) + '\n');
    } else {
      process.stdout.write(formatTerminal(result, cwd, { noCta: options.noCta }) + '\n');
    }

    process.exit(result.score >= 70 ? 0 : 1);
  }
}
