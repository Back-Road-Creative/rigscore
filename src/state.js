import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonSafe, execSafe } from './utils.js';
import { repoMcpPaths, mcpServersIn } from './clients.js';

export const STATE_FILENAME = '.rigscore-state.json';
export const STATE_VERSION = 1;

/**
 * Normalize an MCP server entry to the *shape* rigscore pins:
 *   { command, args, envKeys, url, headerKeys }
 *
 * Env VALUES are intentionally excluded — state file gets committed to git,
 * and hashing values would leak secrets. Env KEYS are sorted for stability.
 * Args preserve order (reorder is a meaningful change).
 *
 * `url` + `headerKeys` cover REMOTE MCP servers (sse/http transports declare a
 * `url` and an optional `headers` map, not `command`/`args`). Without them a
 * url-only server hashed to the SAME digest as any other url-only server, so a
 * URL swap between scans never drifted — the exact CVE-2025-54136 rug-pull the
 * pin exists to catch, but for remote servers. Header VALUES are excluded for
 * the same secret-leak reason as env values; only the key set is pinned.
 *
 * `url`/`headerKeys` are added ONLY when present, so a plain stdio server
 * ({command,args,env}) hashes EXACTLY as before — existing committed pins stay
 * valid across this upgrade; only remote servers gain the new, distinguishing bytes.
 *
 * Split out of computeServerHash (payload unchanged) so verifyState() can
 * print the exact shape that was hashed. One normalization, one hash — a gate
 * that hashed differently from the pin would manufacture phantom drift.
 *
 * @param {{command?: string, args?: any[], env?: Record<string, any>,
 *   url?: string, headers?: Record<string, any>}} server
 * @returns {{command: string, args: string[], envKeys: string[],
 *   url?: string, headerKeys?: string[]}}
 */
export function serverShape(server) {
  const shape = {
    command: typeof server?.command === 'string' ? server.command : '',
    args: Array.isArray(server?.args) ? server.args.map((a) => String(a)) : [],
    envKeys: server?.env && typeof server.env === 'object' ? Object.keys(server.env).sort() : [],
  };
  if (typeof server?.url === 'string' && server.url) shape.url = server.url;
  if (server?.headers && typeof server.headers === 'object') {
    const headerKeys = Object.keys(server.headers).sort();
    if (headerKeys.length > 0) shape.headerKeys = headerKeys;
  }
  return shape;
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
  return parseState(raw);
}

/** Parse a state-file body. @returns {{state: object|null, corrupt: boolean}} */
function parseState(raw) {
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
 * True when `startDir` — or any ancestor — carries a `.git` marker (a directory
 * for a normal clone, a plain file for a worktree/submodule). Cheap, synchronous,
 * and independent of the git binary, so it distinguishes "this is a git repo whose
 * git binary we cannot run" from "this is simply not a git repo".
 */
function hasGitDir(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Load the pin from the COMMITTED tree — `git show HEAD:<prefix>/.rigscore-state.json`.
 *
 * Provenance is the entire value of a pin: it is evidence only if a human committed
 * and reviewed it. A normal `rigscore .` scan mints a trust-on-first-use pin from
 * whatever `.mcp.json` is in the WORKING TREE, and `action.yml` runs a scan BEFORE the
 * `--verify-state` step. So an attacker who rewrites `.mcp.json` and deletes (or
 * corrupts) the pin gets the scan to re-approve their own config, and the gate goes
 * green on a compromised repo. Reading HEAD makes that structurally impossible.
 *
 * `cwd` may be a SUBDIRECTORY of the repo, so the pin path is resolved through
 * `rev-parse --show-prefix`. Return values:
 *   - `null`                     — `cwd` is NOT inside a git repo: no commit
 *                                  provenance exists, so the caller falls back to
 *                                  the working tree (unchanged behavior).
 *   - `{ gitUnavailable: true }` — `cwd` IS inside a git repo (`.git` present) but
 *                                  the git BINARY could not run. Falling back to the
 *                                  working-tree pin here would launder exactly the
 *                                  unreviewed pin the HEAD-read prevents, so the
 *                                  caller must fail closed rather than "verify".
 *   - `{state, corrupt, present}` — the committed pin (or its absence at HEAD).
 *
 * @returns {Promise<{state: object|null, corrupt: boolean, present: boolean}
 *   | {gitUnavailable: true} | null>}
 */
export async function loadCommittedState(cwd) {
  const prefix = await execSafe('git', ['rev-parse', '--show-prefix'], { cwd });
  if (prefix === null) {
    // git gave no answer. If a `.git` marker is on disk this IS a git repo whose
    // binary we cannot run — fail closed. Otherwise it is genuinely not a repo.
    if (hasGitDir(cwd)) return { gitUnavailable: true };
    return null;
  }
  const raw = await execSafe('git', ['show', `HEAD:${prefix.trim()}${STATE_FILENAME}`], { cwd });
  if (raw === null) return { state: null, corrupt: false, present: false };
  return { ...parseState(raw), present: true };
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
 * Hash every MCP server in EVERY committed repo-level config (`repoMcpPaths()` — the 15
 * committed client configs). Home-dir configs stay excluded: per-user, not committed,
 * unreachable from a pull request.
 *
 * This read `<cwd>/.mcp.json` alone, which made the other fourteen a rug-pull blind spot: no
 * pin was minted, so verifyState() compared an empty set against an empty pin and passed.
 * checks/mcp-config.js mints the pin from THIS function, so minting and verification cannot
 * drift apart.
 *
 * COLLISIONS. The pin is a flat name→hash map (format unchanged, STATE_VERSION 1). When two
 * configs declare the same name, the first in `repoMcpPaths()` order keeps the bare name and
 * each later one is pinned as `<name>@<relpath>` — both covered, so a rug-pull in the
 * shadowed copy still drifts instead of hiding behind a first-wins map. `config` rides along
 * so the drift report names the file that actually changed.
 *
 * @returns {Promise<Record<string, {hash: string, shape: object, config: string}>>}
 */
export async function readRepoServers(cwd) {
  const out = {};
  for (const configPath of repoMcpPaths(cwd)) {
    const servers = mcpServersIn(configPath, await readJsonSafe(configPath));
    const config = path.relative(cwd, configPath);
    for (const [name, server] of Object.entries(servers)) {
      const key = name in out ? `${name}@${config}` : name;
      out[key] = { hash: computeServerHash(server), shape: serverShape(server), config };
    }
  }
  return out;
}

/**
 * Read-only drift gate behind `rigscore --verify-state` (CVE-2025-54136 /
 * MCPoison). Compares today's shapes — from every committed repo-level MCP config
 * (readRepoServers) — against the hashes pinned in `.rigscore-state.json`. Zero network, and
 * — critically — zero writes. A normal scan REWRITES the pin, which would
 * silently erase the drift this gate exists to catch.
 *
 * The pin is read from HEAD (see loadCommittedState) — a working-tree pin a scan
 * minted moments earlier is NOT an approval, so a scan cannot launder this gate.
 * Today's working-tree configs are still what get compared: those are the configs
 * that would actually run; only the PIN's provenance is in question.
 *
 * verified (0) | drift (1) | unpinned (2) | uncommitted (2) | corrupt (2) |
 * not-applicable (0). ADDED / REMOVED are reported but do NOT fail — only a *pinned*
 * server mutating under an already-approved name is a rug-pull. Each case is justified
 * in docs/checks/mcp-config.md § "CI gate: rigscore --verify-state".
 */
export async function verifyState(cwd) {
  const current = await readRepoServers(cwd);
  const committed = await loadCommittedState(cwd);
  const working = await loadState(cwd);

  // Inside a git repo whose git binary we could not run: the HEAD-committed pin —
  // the only laundering-proof provenance this gate trusts — is unreadable. Refuse
  // (2) rather than silently fall back to the working-tree pin.
  if (committed && committed.gitUnavailable) {
    return { changed: [], added: [], removed: [], matched: [], status: 'git-unavailable', exitCode: 2 };
  }

  // A pin the working tree carries but HEAD does not is exactly the pin a scan mints
  // (or an attacker plants). Nobody reviewed it, so it verifies nothing — refuse (2)
  // rather than "verify" the attacker's own config against itself.
  if (committed !== null && !committed.present && Object.keys(current).length > 0
    && (working.state !== null || working.corrupt)) {
    return { changed: [], added: [], removed: [], matched: [], status: 'uncommitted', exitCode: 2 };
  }

  // Outside a git repo — or inside one with no pin at HEAD — the working tree is all
  // there is, and there is no provenance to lose by reading it.
  const { state, corrupt } = committed?.present ? committed : working;
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
  for (const [name, { hash, shape, config }] of Object.entries(current)) {
    const prev = pinned[name];
    if (typeof prev !== 'string') result.added.push({ name, currentHash: hash, shape, config });
    else if (prev !== hash) result.changed.push({ name, pinnedHash: prev, currentHash: hash, shape, config });
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
  unpinned: `This repo's committed MCP config(s) declare servers but ${STATE_FILENAME} pins none — nothing is being verified. Pin with \`rigscore .\` and commit it.`,
  uncommitted: `${STATE_FILENAME} exists in the working tree but is not committed at HEAD — an uncommitted pin proves nothing. A scan mints one from whatever MCP config is sitting there, so verifying against it would just check the current config against itself. Review this repo's committed MCP config(s), then commit ${STATE_FILENAME}.`,
  'git-unavailable': `This is a git repo (a .git marker is present) but the git binary could not be run, so the HEAD-committed pin — the only provenance this gate trusts — is unreadable. Falling back to the working-tree pin would verify an unreviewed config against itself. Install/repair git on this machine (CI runner included), then re-run \`rigscore --verify-state\`.`,
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
  for (const { name, pinnedHash, currentHash, shape, config } of r.changed) {
    lines.push(
      `DRIFT         "${name}" changed shape since it was pinned (possible rug-pull, CVE-2025-54136)`,
      `                declared in: ${config}`,
      `                pinned  sha256:${pinnedHash.slice(0, 16)}   current sha256:${currentHash.slice(0, 16)}`,
      `                current command: ${shape.command}   args: ${JSON.stringify(shape.args)}   envKeys: ${JSON.stringify(shape.envKeys)}`,
      `                current url: ${shape.url || '(none)'}   headerKeys: ${JSON.stringify(shape.headerKeys || [])}`,
      `                Old shape is not stored (hash only) — diff ${path.join(cwd, config)} against version control.`,
    );
  }
  for (const a of r.added) lines.push(`ADDED         "${a.name}" (${a.config}) is not pinned — a new server is re-approved by the host, not rug-pulled. Re-pin to cover it.`);
  for (const x of r.removed) lines.push(`REMOVED       "${x.name}" is pinned but gone from this repo's MCP configs — stale pin; a removed server cannot execute.`);
  for (const name of r.matched) lines.push(`OK            "${name}" matches its pin.`);

  lines.push('');
  if (r.exitCode === 1) lines.push(`FAIL: ${r.changed.length} pinned MCP server(s) changed shape. Review the diff before trusting this repo.`);
  else if (r.exitCode === 2) lines.push('FAIL: cannot verify — see above. This gate refuses to report success on a repo whose pin it cannot trust.');
  else lines.push(`PASS: ${r.matched.length} pinned MCP server(s) verified.`);
  return lines.join('\n');
}

// ── Score history / trend ───────────────────────────────────────────────────
// Recorded in a SEPARATE file from the MCP pin: the pin is rewritten wholesale
// by checks/mcp-config.js on every drift (which would clobber history), and many
// state tests assert the pin file's exact shape. A dedicated history file keeps
// both concerns independent. Opt-in write (`--record-score`) so a default scan
// still writes exactly one file (the pin) and never dirties a repo unasked.
export const HISTORY_FILENAME = '.rigscore-history.json';
export const MAX_HISTORY_ENTRIES = 100;

/** Load the recorded score history array (oldest → newest). Empty on missing/corrupt. */
export async function loadScoreHistory(cwd) {
  let raw;
  try {
    raw = await fs.promises.readFile(path.join(cwd, HISTORY_FILENAME), 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.history) ? parsed.history : [];
  } catch {
    return [];
  }
}

/**
 * Append one `{date, score, grade?}` entry to the score history and persist it
 * (atomic tmp+rename, capped at MAX_HISTORY_ENTRIES). Returns the trimmed history.
 */
export async function recordScoreHistory(cwd, entry) {
  const history = await loadScoreHistory(cwd);
  history.push({
    date: entry.date || new Date().toISOString(),
    score: entry.score,
    ...(entry.grade ? { grade: entry.grade } : {}),
  });
  const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
  const p = path.join(cwd, HISTORY_FILENAME);
  const body = JSON.stringify({ version: STATE_VERSION, history: trimmed }, null, 2) + '\n';
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = `${p}.${process.pid}.${rand}.tmp`;
  try {
    await fs.promises.writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tmp, p);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
  return trimmed;
}

/** Render a compact, CI-log-friendly score trend with per-step and net deltas. */
export function formatTrend(history, { limit = 10 } = {}) {
  if (!history || history.length === 0) {
    return `rigscore score history (${HISTORY_FILENAME}) — no scores recorded yet.\n`
      + 'Run `rigscore . --record-score` to start a trend.';
  }
  const recent = history.slice(-limit);
  const lines = [`rigscore score history (${HISTORY_FILENAME}) — last ${recent.length} of ${history.length}:`, ''];
  let prev = null;
  for (const e of recent) {
    const score = typeof e.score === 'number' ? e.score : null;
    let delta = '';
    if (prev !== null && score !== null) {
      const d = score - prev;
      delta = d === 0 ? '  (=)' : d > 0 ? `  (up +${d})` : `  (down ${d})`;
    }
    const scoreStr = score === null ? 'n/a' : `${score}/100`;
    lines.push(`  ${e.date}   ${scoreStr}${delta}`);
    if (score !== null) prev = score;
  }
  const nums = recent.filter((e) => typeof e.score === 'number').map((e) => e.score);
  if (nums.length >= 2) {
    const net = nums[nums.length - 1] - nums[0];
    lines.push('', `  Net change over window: ${net >= 0 ? '+' : ''}${net}`);
  }
  return lines.join('\n');
}
