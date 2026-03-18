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

export async function readJsonSafe(p) {
  try {
    const content = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(content);
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
