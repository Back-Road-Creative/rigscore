import fs from 'node:fs';
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

export async function fileExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
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

const COMMENT_PREFIXES = ['#', '//', '<!--', '--', '/*', '*'];

/**
 * Scan a single line for secret patterns.
 * Returns { matched: boolean, severity: 'critical'|'info', pattern?: RegExp }
 */
export function scanLineForSecrets(line, trimmed) {
  const isComment = COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
  const isExample = /\b(example|placeholder|demo|sample|template|your_?key|xxx|changeme|replace_?me)\b/i.test(line);

  for (const pattern of KEY_PATTERNS) {
    if (pattern.test(line)) {
      const severity = isComment || isExample ? 'info' : 'critical';
      return { matched: true, severity, pattern };
    }
  }
  return { matched: false };
}
