import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonSafe } from './utils.js';

export const STATE_FILENAME = '.rigscore-state.json';
export const STATE_VERSION = 1;

/**
 * Normalize an MCP server entry to the *shape* rigscore pins:
 *   { command, args, envKeys }
 *
 * Env VALUES are intentionally excluded — state file gets committed to git,
 * and hashing values would leak secrets. Env KEYS are sorted for stability.
 * Args preserve order (reorder is a meaningful change).
 *
 * Split out of computeServerHash (payload unchanged) so verifyState() can
 * print the exact shape that was hashed. One normalization, one hash — a gate
 * that hashed differently from the pin would manufacture phantom drift.
 *
 * @param {{command?: string, args?: any[], env?: Record<string, any>}} server
 * @returns {{command: string, args: string[], envKeys: string[]}}
 */
export function serverShape(server) {
  return {
    command: typeof server?.command === 'string' ? server.command : '',
    args: Array.isArray(server?.args) ? server.args.map((a) => String(a)) : [],
    envKeys: server?.env && typeof server.env === 'object' ? Object.keys(server.env).sort() : [],
  };
}

/** SHA-256 hex digest of an MCP server's shape. @param {object} server */
export function computeServerHash(server) {
  return crypto.createHash('sha256').update(JSON.stringify(serverShape(server))).digest('hex');
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

/**
 * Hash each server in the repo-level `.mcp.json`. Same scope checks/mcp-config.js
 * pins: repo `.mcp.json` only — home-dir client configs are per-user, never pinned.
 * @returns {Promise<Record<string, {hash: string, shape: object}>>}
 */
async function readRepoServers(cwd) {
  const cfg = await readJsonSafe(path.join(cwd, '.mcp.json'));
  const servers = (cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object') ? cfg.mcpServers : {};
  const out = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = { hash: computeServerHash(server), shape: serverShape(server) };
  }
  return out;
}

/**
 * Read-only drift gate behind `rigscore --verify-state` (CVE-2025-54136 /
 * MCPoison). Compares today's `.mcp.json` shapes against the hashes pinned in
 * `.rigscore-state.json`. Pure function of two local files: zero network, and
 * — critically — zero writes. A normal scan REWRITES the pin, which would
 * silently erase the drift this gate exists to catch.
 *
 * verified (0) | drift (1) | unpinned (2) | corrupt (2) | not-applicable (0).
 * ADDED / REMOVED are reported but do NOT fail — only a *pinned* server
 * mutating under an already-approved name is a rug-pull. Each case is justified
 * in docs/checks/mcp-config.md § "CI gate: rigscore --verify-state".
 */
export async function verifyState(cwd) {
  const current = await readRepoServers(cwd);
  const { state, corrupt } = await loadState(cwd);
  const raw = (state && state.version === STATE_VERSION && state.mcpServers && typeof state.mcpServers === 'object')
    ? state.mcpServers
    : null;
  const pinned = raw && Object.keys(raw).length > 0 ? raw : null;

  const base = { changed: [], added: [], removed: [], matched: [] };
  if (corrupt) return { ...base, status: 'corrupt', exitCode: 2 };
  if (!pinned) {
    // Servers but no pin: the gate is blind, so it refuses to report success (2).
    // No servers and no pin: genuinely nothing to protect (0).
    return Object.keys(current).length > 0
      ? { ...base, status: 'unpinned', exitCode: 2 }
      : { ...base, status: 'not-applicable', exitCode: 0 };
  }

  const result = { ...base };
  for (const [name, { hash, shape }] of Object.entries(current)) {
    const prev = pinned[name];
    if (typeof prev !== 'string') result.added.push({ name, currentHash: hash, shape });
    else if (prev !== hash) result.changed.push({ name, pinnedHash: prev, currentHash: hash, shape });
    else result.matched.push(name);
  }
  for (const name of Object.keys(pinned)) {
    if (!current[name]) result.removed.push({ name, pinnedHash: pinned[name] });
  }

  const drift = result.changed.length > 0;
  return { ...result, status: drift ? 'drift' : 'verified', exitCode: drift ? 1 : 0 };
}

const UNVERIFIABLE_REASON = {
  corrupt: `${STATE_FILENAME} is unreadable or not version ${STATE_VERSION} — re-pin with \`rigscore .\` and commit it.`,
  unpinned: `.mcp.json declares MCP servers but ${STATE_FILENAME} pins none — nothing is being verified. Pin with \`rigscore .\` and commit it.`,
  'not-applicable': 'No repo-level MCP servers and no pin — nothing to verify.',
};

/** Render a verifyState() result as plain, CI-log-friendly text. */
export function formatVerifyStateReport(r, cwd) {
  const lines = [`rigscore --verify-state — MCP config-shape pin (${STATE_FILENAME})`, ''];
  const reason = UNVERIFIABLE_REASON[r.status];
  if (reason) lines.push(`${r.exitCode === 0 ? 'OK          ' : 'UNVERIFIABLE'}  ${reason}`);

  // Print BOTH hashes and the current shape — "drift" with no diff is not actionable.
  // The pin stores only a hash (state file is committed to git), so the OLD shape is not
  // recoverable from it; point the operator at version control for that half.
  for (const { name, pinnedHash, currentHash, shape } of r.changed) {
    lines.push(
      `DRIFT         "${name}" changed shape since it was pinned (possible rug-pull, CVE-2025-54136)`,
      `                pinned  sha256:${pinnedHash.slice(0, 16)}   current sha256:${currentHash.slice(0, 16)}`,
      `                current command: ${shape.command}   args: ${JSON.stringify(shape.args)}   envKeys: ${JSON.stringify(shape.envKeys)}`,
      `                Old shape is not stored (hash only) — diff ${path.join(cwd, '.mcp.json')} against version control.`,
    );
  }
  for (const a of r.added) lines.push(`ADDED         "${a.name}" is not pinned — a new server is re-approved by the host, not rug-pulled. Re-pin to cover it.`);
  for (const x of r.removed) lines.push(`REMOVED       "${x.name}" is pinned but gone from .mcp.json — stale pin; a removed server cannot execute.`);
  for (const name of r.matched) lines.push(`OK            "${name}" matches its pin.`);

  lines.push('');
  if (r.exitCode === 1) lines.push(`FAIL: ${r.changed.length} pinned MCP server(s) changed shape. Review the diff before trusting this repo.`);
  else if (r.exitCode === 2) lines.push('FAIL: cannot verify — see above. This gate refuses to report success on an unpinned repo.');
  else lines.push(`PASS: ${r.matched.length} pinned MCP server(s) verified.`);
  return lines.join('\n');
}
