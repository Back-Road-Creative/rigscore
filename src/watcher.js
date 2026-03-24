import fs from 'node:fs';
import path from 'node:path';
import { scan } from './scanner.js';
import { formatTerminal } from './reporter.js';
import os from 'node:os';

const WATCH_PATTERNS = [
  'CLAUDE.md', '.cursorrules', '.windsurfrules', '.clinerules', '.continuerules',
  'copilot-instructions.md', 'AGENTS.md', '.aider.conf.yml',
  '.mcp.json', '.env', 'compose.yml', 'compose.yaml',
  'docker-compose.yml', 'docker-compose.yaml',
  'Dockerfile', '.rigscorerc.json',
];

const WATCH_DIRS = ['.git/hooks', '.claude', '.husky'];

function shouldTrigger(filename) {
  if (!filename) return true; // some platforms don't provide filename
  const base = path.basename(filename);
  const dir = path.dirname(filename);

  if (WATCH_PATTERNS.some(p => base === p || base.startsWith('.env'))) return true;
  if (base.startsWith('Dockerfile')) return true;
  if (base.endsWith('.yml') || base.endsWith('.yaml')) {
    if (base.startsWith('compose') || base.startsWith('docker-compose')) return true;
  }
  if (WATCH_DIRS.some(d => filename.startsWith(d))) return true;

  return false;
}

export function createDebouncer(fn, delay = 500) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
}

export { shouldTrigger };

/**
 * Build a rescan function for the watch loop.
 * Warns on stderr when score drops below failUnder (never exits — warn-only in loop).
 */
export function buildRescan({ cwd, scanOptions, options }) {
  return async () => {
    // Clear terminal
    process.stdout.write('\x1B[2J\x1B[0f');

    try {
      const result = await scan(scanOptions);
      process.stdout.write(formatTerminal(result, cwd, { noCta: options.noCta, verbose: options.verbose }) + '\n');

      if (options.failUnder && result.score < options.failUnder) {
        process.stderr.write(`\nWarning: score ${result.score} is below --fail-under ${options.failUnder}\n`);
      }
    } catch (err) {
      process.stderr.write(`Scan error: ${err.message}\n`);
    }

    process.stderr.write('\nWatching for changes... (Ctrl+C to stop)\n');
  };
}

export async function startWatching(cwd, args, options) {
  process.stderr.write('\nWatching for changes... (Ctrl+C to stop)\n');

  const scanOptions = {
    cwd,
    homedir: os.homedir(),
    checkFilter: options.checkFilter,
    deep: options.deep,
    online: options.online,
    profile: options.profile,
  };

  const rescan = buildRescan({ cwd, scanOptions, options });

  const debouncedRescan = createDebouncer(rescan, 500);

  try {
    const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
      if (shouldTrigger(filename)) {
        debouncedRescan();
      }
    });

    // Keep process alive
    await new Promise(() => {});
  } catch (err) {
    process.stderr.write(`Watch error: ${err.message}\n`);
    process.exit(1);
  }
}
