import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATE_FILENAME = '.rigscore-state.json';
export const STATE_VERSION = 1;

/**
 * Compute a stable SHA-256 hash of an MCP server's *shape*:
 *   { command, args, envKeys }
 *
 * Env VALUES are intentionally excluded — state file gets committed to git,
 * and hashing values would leak secrets. Env KEYS are sorted for stability.
 * Args preserve order (reorder is a meaningful change).
 *
 * @param {{command?: string, args?: any[], env?: Record<string, any>}} server
 * @returns {string} sha256 hex digest
 */
export function computeServerHash(server) {
  const command = typeof server?.command === 'string' ? server.command : '';
  const args = Array.isArray(server?.args) ? server.args.map((a) => String(a)) : [];
  const envKeys = server?.env && typeof server.env === 'object'
    ? Object.keys(server.env).sort()
    : [];
  const payload = JSON.stringify({ command, args, envKeys });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Load state from <cwd>/.rigscore-state.json.
 * Returns { state, corrupt }:
 *   - state: parsed object or null if missing/corrupt
 *   - corrupt: true if the file exists but cannot be parsed
 */
export async function loadState(cwd) {
  const p = path.join(cwd, STATE_FILENAME);
  let raw;
  try {
    raw = await fs.promises.readFile(p, 'utf-8');
  } catch {
    return { state: null, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { state: null, corrupt: true };
    }
    return { state: parsed, corrupt: false };
  } catch {
    return { state: null, corrupt: true };
  }
}

/**
 * Write state to <cwd>/.rigscore-state.json atomically.
 *
 * A single `writeFile` is a truncate-then-write — a SIGINT mid-write (or a
 * concurrent scanner racing on the same file) leaves a zero-byte file and
 * silently drops pinned MCP hashes on the next load. Write to a sibling
 * `.tmp` file in the same directory (POSIX rename(2) is atomic only within
 * a single filesystem), then rename over the target. On any error, best-
 * effort unlink the tmp before propagating.
 *
 * A random suffix on the tmp name protects concurrent writers from
 * clobbering each other's in-flight payloads — last rename wins, no writer
 * ever sees a half-written file.
 */
export async function saveState(cwd, state) {
  const p = path.join(cwd, STATE_FILENAME);
  const body = JSON.stringify(state, null, 2) + '\n';
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = `${p}.${process.pid}.${rand}.tmp`;
  try {
    await fs.promises.writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tmp, p);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}
