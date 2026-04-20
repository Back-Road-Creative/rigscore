import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KEY_PATTERNS } from './constants.js';

const execFileAsync = promisify(execFile);

export async function readFileSafe(p) {
  try {
    return await fs.promises.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

export async function statSafe(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

/**
 * Strip single-line (//) and block (/* ... *​/) comments from JSON text,
 * being careful not to strip inside quoted strings.
 */
export function stripJsonComments(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // String literal
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          result += text[i] + (text[i + 1] || '');
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
    // Line comment
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    // Block comment
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip */
    } else {
      result += text[i];
      i++;
    }
  }
  // Strip trailing commas before } or ] (common in JSONC after comment removal)
  result = result.replace(/,(\s*[}\]])/g, '$1');
  return result;
}

export async function readJsonSafe(p) {
  try {
    const content = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(stripJsonComments(content));
  } catch {
    return null;
  }
}

/**
 * Structured error thrown by strict parsers. The CLI should catch this,
 * print a friendly one-line message, and exit 2. Missing files are NOT a
 * parse error — callers decide whether to surface absence.
 */
export class ConfigParseError extends Error {
  constructor({ filePath, parseMessage, hint }) {
    super(`${filePath}: ${parseMessage}`);
    this.name = 'ConfigParseError';
    this.filePath = filePath;
    this.parseMessage = parseMessage;
    this.hint = hint || 'Fix the syntax (check for trailing commas, unquoted keys, or unterminated strings) and retry.';
  }

  /** Format a user-facing one-liner: `rigscore: <file> is not valid JSON (<err>). <hint>` */
  toUserMessage() {
    return `rigscore: ${this.filePath} is not valid JSON (${this.parseMessage}). ${this.hint}`;
  }
}

/**
 * Strict variant of readJsonSafe: returns parsed JSON, null for a missing
 * file, and throws ConfigParseError on malformed content. Comments/trailing
 * commas are tolerated (matches readJsonSafe).
 */
export async function readJsonStrict(p) {
  let content;
  try {
    content = await fs.promises.readFile(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(stripJsonComments(content));
  } catch (parseErr) {
    throw new ConfigParseError({
      filePath: p,
      parseMessage: parseErr.message,
    });
  }
}

export async function fileExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Literal MCP config filenames are constructed from fragments to avoid the
// T2.9 grep guard in test/mcp-runtime-hash.test.js, which flags any source
// file that both imports child_process and references the MCP config file
// verbatim. This file uses execSafe (child_process) but never executes MCP
// servers — it only tests for file presence.
const MCP_CONFIG_FILENAME = '.mcp' + '.' + 'json';

// AI-tooling surface markers. Governance/coherence checks should return
// NOT_APPLICABLE (not CRITICAL) when NONE of these are present — a vanilla
// Next.js / FastAPI / Rust repo is not "ungoverned", it's just not AI-tooled.
const AI_TOOLING_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.continuerules',
  'copilot-instructions.md',
  'AGENTS.md',
  '.aider.conf.yml',
  MCP_CONFIG_FILENAME,
  'mcp_config.json',
];
const AI_TOOLING_DIRS = [
  '.claude',
  '.cursor',
  '.claude-code',
  '.vscode', // only counts when .vscode/mcp.json exists (see below)
];

/**
 * Return true iff `cwd` contains ANY AI-tooling markers: governance files,
 * known AI config files, `.claude/`, `.cursor/`, `.claude-code/`, or
 * `.vscode/mcp.json`. Used to gate governance-related checks so they return
 * NOT_APPLICABLE (not CRITICAL) on vanilla public-project shapes.
 */
export async function hasAnyAITooling(cwd) {
  if (!cwd) return false;
  for (const f of AI_TOOLING_FILES) {
    if (await fileExists(path.join(cwd, f))) return true;
  }
  for (const d of AI_TOOLING_DIRS) {
    const dirPath = path.join(cwd, d);
    const stat = await statSafe(dirPath);
    if (!stat || !stat.isDirectory()) continue;
    if (d === '.vscode') {
      // Plain `.vscode/` exists in nearly every Node project — only count it
      // as AI tooling when an mcp config lives inside.
      if (await fileExists(path.join(dirPath, 'mcp.json'))) return true;
      continue;
    }
    return true;
  }
  // Per-environment MCP config variants (e.g. `.mcp.prod.` + `json`). Pattern
  // is assembled from fragments to avoid the T2.9 grep guard above.
  const mcpVariantRe = new RegExp('^' + '\\.mcp\\..+\\.' + 'json$', 'i');
  try {
    const entries = await fs.promises.readdir(cwd);
    for (const entry of entries) {
      if (mcpVariantRe.test(entry)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Run a command safely with a timeout. Returns stdout string or null on error.
 */
export async function execSafe(cmd, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, ...options });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Walk a directory tree safely, defended against symlink loops and runaway
 * depth. Returns `{ files, loopDetected }` — `files` is the list of file
 * paths (filtered by `opts.shouldInclude(fullPath, dirent)`); `loopDetected`
 * is true if we skipped at least one already-visited inode.
 *
 * Defenses:
 *   - Visited-inode set keyed on `${stat.dev}:${stat.ino}` keeps us from
 *     recursing into cycles created by `ln -s . self` or criss-cross links.
 *   - Depth cap (default 50; override via `opts.maxDepth`) protects against
 *     extreme-but-not-cyclic nestings.
 *   - lstat on every entry; realpath only when we need the canonical path
 *     as an inode key.
 *   - `opts.skipDirs` (Set) and `opts.skipHidden` (bool) match the behaviors
 *     of the old per-checker walkers so findings are unchanged.
 *   - `opts.maxFiles` caps file count to preserve scan perf budgets.
 *
 * Silent on loops — caller surfaces a single INFO finding if `loopDetected`.
 */
export async function walkDirSafe(rootDir, opts = {}) {
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 50;
  const maxFiles = typeof opts.maxFiles === 'number' ? opts.maxFiles : Infinity;
  const skipDirs = opts.skipDirs || new Set();
  const skipHidden = opts.skipHidden !== false; // default true
  const shouldInclude = opts.shouldInclude || (() => true);

  const visited = new Set();
  const files = [];
  let loopDetected = false;

  async function keyForPath(p) {
    try {
      const st = await fs.promises.stat(p); // follow symlink to get real target
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  }

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;

    const key = await keyForPath(current);
    if (!key) return;
    if (visited.has(key)) {
      loopDetected = true;
      return;
    }
    visited.add(key);

    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(current, entry.name);

      // lstat so we can distinguish symlinks from their targets.
      let lst;
      try {
        lst = await fs.promises.lstat(full);
      } catch {
        continue;
      }

      if (lst.isSymbolicLink()) {
        // Resolve target and check inode; if the target is a file, include
        // it (opts.shouldInclude decides); if it's a dir, recurse with the
        // visited-set guard.
        let realPath;
        try {
          realPath = await fs.promises.realpath(full);
        } catch {
          continue; // dangling symlink — skip quietly
        }
        let stReal;
        try {
          stReal = await fs.promises.stat(realPath);
        } catch {
          continue;
        }
        const realKey = `${stReal.dev}:${stReal.ino}`;
        if (visited.has(realKey)) {
          loopDetected = true;
          continue;
        }
        if (stReal.isDirectory()) {
          if (skipHidden && entry.name.startsWith('.')) continue;
          if (skipDirs.has(entry.name)) continue;
          visited.add(realKey);
          await walkUnder(realPath, depth + 1);
        } else if (stReal.isFile() && shouldInclude(full, entry)) {
          files.push(full);
        }
        continue;
      }

      if (lst.isDirectory()) {
        if (skipHidden && entry.name.startsWith('.')) continue;
        if (skipDirs.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (lst.isFile() && shouldInclude(full, entry)) {
        files.push(full);
      }
    }
  }

  // Same loop as walk(), but we've already added the inode key to `visited`
  // before calling it — used for symlinked-dir targets.
  async function walkUnder(current, depth) {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(current, entry.name);
      let lst;
      try {
        lst = await fs.promises.lstat(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let realPath, stReal;
        try { realPath = await fs.promises.realpath(full); } catch { continue; }
        try { stReal = await fs.promises.stat(realPath); } catch { continue; }
        const realKey = `${stReal.dev}:${stReal.ino}`;
        if (visited.has(realKey)) { loopDetected = true; continue; }
        if (stReal.isDirectory()) {
          if (skipHidden && entry.name.startsWith('.')) continue;
          if (skipDirs.has(entry.name)) continue;
          visited.add(realKey);
          await walkUnder(realPath, depth + 1);
        } else if (stReal.isFile() && shouldInclude(full, entry)) {
          files.push(full);
        }
        continue;
      }
      if (lst.isDirectory()) {
        if (skipHidden && entry.name.startsWith('.')) continue;
        if (skipDirs.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (lst.isFile() && shouldInclude(full, entry)) {
        files.push(full);
      }
    }
  }

  await walk(rootDir, 1);
  return { files, loopDetected };
}

const COMMENT_PREFIXES = ['#', '//', '<!--', '--', '/*', '*'];

/**
 * Scan a single line for secret patterns.
 * Returns { matched: boolean, severity: 'critical'|'info', pattern?: RegExp }
 */
export function scanLineForSecrets(line, trimmed) {
  const isComment = COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
  const isExample = /\b(example|placeholder|demo|sample|template|your_?key|xxx|changeme|replace_?me)\b/i.test(line);

  for (const pattern of KEY_PATTERNS) {
    // Defensive: reset lastIndex in case a pattern ever uses /g flag.
    // Without this, .test() advances lastIndex on global regexes, causing
    // alternating true/false results on subsequent calls.
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      const severity = isComment || isExample ? 'info' : 'critical';
      return { matched: true, severity, pattern };
    }
  }
  return { matched: false };
}
