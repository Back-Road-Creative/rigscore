import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scan } from './scanner.js';
import { formatTerminal } from './reporter.js';
import { governanceFiles, governanceDirDefaults } from './clients.js';
import { suppressAndRescore } from './index.js';

// Infra/config surfaces the scanner inspects (non-governance). Governance
// filenames are DERIVED from clients.js — the single source every check reads —
// so 2.1.0 surfaces (.roorules, .goosehints, QWEN.md, CRUSH.md,
// .junie/guidelines.md, GEMINI.md, ...) are watched automatically, never
// hand-maintained here and never drifting from what a scan actually reads.
const INFRA_FILES = [
  '.mcp.json', '.env', 'compose.yml', 'compose.yaml',
  'docker-compose.yml', 'docker-compose.yaml',
  'Dockerfile', '.rigscorerc.json',
];
const WATCH_PATTERNS = [...governanceFiles(), ...INFRA_FILES];

// Directory-form rule sets became default-scanned in 2.1.0 (.cursor/rules,
// .windsurf/rules, .clinerules, .github/instructions, .amazonq/rules,
// .kiro/steering); a change under any of them — or the hook/skill dirs — rescans.
const WATCH_DIRS = ['.git/hooks', '.claude', '.husky', ...governanceDirDefaults()];

function shouldTrigger(filename) {
  if (!filename) return true; // some platforms don't provide filename
  const norm = String(filename).split(path.sep).join('/');
  const base = path.basename(norm);

  if (base.startsWith('.env')) return true;
  if (base.startsWith('Dockerfile')) return true;
  if ((base.endsWith('.yml') || base.endsWith('.yaml'))
    && (base.startsWith('compose') || base.startsWith('docker-compose'))) return true;
  // Exact single-file surface. Path-form names (.junie/guidelines.md,
  // .github/copilot-instructions.md) match on the relative path too.
  if (WATCH_PATTERNS.some(p => p === base || p === norm || norm.endsWith('/' + p))) return true;
  // Anything under a watched directory (hooks, skills, directory-form rule sets).
  if (WATCH_DIRS.some(d => norm === d || norm.startsWith(d + '/'))) return true;

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
 * Build the full scan options for the watch loop. MUST mirror the one-shot
 * path (src/index.js) or --watch silently ignores flags. Notably `writeState`
 * honors --no-state-write (it was dropped, so `--watch --no-state-write` still
 * rewrote .rigscore-state.json on every rescan), and semantic /
 * includeHomeSkills / refreshMcpRegistry now pass through as well.
 */
export function buildScanOptions(cwd, options) {
  return {
    cwd,
    homedir: os.homedir(),
    checkFilter: options.checkFilter,
    deep: options.deep,
    online: options.online,
    semantic: options.semantic,
    refreshMcpRegistry: options.refreshMcpRegistry,
    includeHomeSkills: options.includeHomeSkills,
    profile: options.profile,
    writeState: !options.noStateWrite,
  };
}

/**
 * Build a rescan function for the watch loop.
 * Warns on stderr when score drops below failUnder (never exits — warn-only in loop).
 */
export function buildRescan({ cwd, scanOptions, options }) {
  return async () => {
    // Clear terminal
    process.stdout.write('\x1B[2J\x1B[0f');

    let result;
    try {
      result = await scan(scanOptions);
      // Rescans honor suppress:/--ignore too, via the same helper the one-shot
      // path uses (index.js) — else muted findings resurface on every rescan.
      suppressAndRescore(result, options.ignore, options.checkFilter);
      process.stdout.write(formatTerminal(result, cwd, { noCta: options.noCta, verbose: options.verbose }) + '\n');

      if (options.failUnder && result.score < options.failUnder) {
        process.stderr.write(`\nWarning: score ${result.score} is below --fail-under ${options.failUnder}\n`);
      }
    } catch (err) {
      process.stderr.write(`Scan error: ${err.message}\n`);
    }

    process.stderr.write('\nWatching for changes... (Ctrl+C to stop)\n');
    return result;
  };
}

/**
 * Create the fs watcher(s), returning an array of closable watchers.
 *
 * On Linux + Node < 19.1, `fs.watch(cwd, { recursive: true })` throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM — so --watch would crash despite
 * `engines.node` allowing >=18.17 and CI testing 18.17 on ubuntu. Rather than
 * drop Node 18 for the whole tool, degrade only --watch: fall back to a
 * non-recursive watch of the project root plus each governance dir, and say so.
 * (Changes nested deeper than one level under an unwatched dir may be missed.)
 */
export function setupWatchers(cwd, onTrigger) {
  const onCwd = (eventType, filename) => { if (shouldTrigger(filename)) onTrigger(); };
  try {
    return [fs.watch(cwd, { recursive: true }, onCwd)];
  } catch (err) {
    if (err.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err;
    process.stderr.write(
      'Note: recursive file watching is unavailable here (Linux needs Node >= 19.1). '
      + 'Falling back to a non-recursive watch of the project root and governance dirs; '
      + 'changes nested deeper than one level may be missed.\n',
    );
    const watchers = [fs.watch(cwd, onCwd)];
    for (const dir of WATCH_DIRS) {
      const full = path.join(cwd, dir);
      if (!fs.existsSync(full)) continue;
      try {
        watchers.push(fs.watch(full, () => onTrigger()));
      } catch { /* best-effort: skip dirs we cannot watch */ }
    }
    return watchers;
  }
}

export async function startWatching(cwd, args, options) {
  process.stderr.write('\nWatching for changes... (Ctrl+C to stop)\n');

  const scanOptions = buildScanOptions(cwd, options);
  const rescan = buildRescan({ cwd, scanOptions, options });
  const debouncedRescan = createDebouncer(rescan, 500);

  let watchers = [];
  try {
    watchers = setupWatchers(cwd, debouncedRescan);

    const cleanup = () => {
      for (const w of watchers) w.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Keep process alive until signal
    await new Promise(() => {});
  } catch (err) {
    for (const w of watchers) w.close();
    process.stderr.write(`Watch error: ${err.message}\n`);
    process.exit(1);
  }
}
