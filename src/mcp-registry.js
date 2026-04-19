/**
 * Official MCP registry client.
 *
 * Fetches the list of known MCP servers from the Model Context Protocol
 * community registry and caches the response on disk so subsequent scans
 * don't hit the network. The registry augments — never replaces — the
 * hand-curated list in `src/known-mcp-servers.js`.
 *
 * Design notes:
 *   - All network and filesystem I/O is injectable (`fetchImpl`, `cachePath`)
 *     so tests don't touch the real network or the real XDG cache dir.
 *   - Schema tolerance: forward-compat. We pick out known fields, preserve
 *     unknowns in the on-disk cache, and never crash on unexpected shape.
 *   - Cache TTL: 24 hours. If refetch fails, stale cache is still used and
 *     the caller surfaces an INFO finding.
 *   - No hard dependency on Node's global `fetch` (Node 18+ has it, but
 *     the tests always pass in a mock — so we never actually hit the
 *     network in CI).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default XDG-style cache path: `$XDG_CACHE_HOME/rigscore/mcp-registry.json`
 * falling back to `~/.cache/rigscore/mcp-registry.json`.
 */
export function getDefaultCachePath(homedir = os.homedir()) {
  const xdg = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim();
  const cacheRoot = xdg ? xdg : path.join(homedir, '.cache');
  return path.join(cacheRoot, 'rigscore', 'mcp-registry.json');
}

/**
 * Normalize a registry server name to its base form for typosquat comparison.
 * Examples:
 *   'io.modelcontextprotocol/filesystem' -> 'filesystem'
 *   'io.github.someone/My-Server'        -> 'my-server'
 *   'filesystem'                          -> 'filesystem'
 */
export function normalizeRegistryServerName(name) {
  if (typeof name !== 'string' || !name) return '';
  const slashIdx = name.lastIndexOf('/');
  const base = slashIdx >= 0 ? name.slice(slashIdx + 1) : name;
  return base.toLowerCase();
}

/**
 * Extract the known fields from a raw registry server record.
 * Unknown fields are intentionally discarded at the normalization layer.
 */
function pickKnownFields(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!name) return null;
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : null,
    version: typeof raw.version === 'string' ? raw.version : null,
    repository: raw.repository && typeof raw.repository === 'object' && typeof raw.repository.url === 'string'
      ? { url: raw.repository.url }
      : null,
  };
}

/**
 * Parse a registry response payload into a canonical array of server records.
 * Returns [] if the payload doesn't look like a registry response.
 */
export function extractServers(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const servers = Array.isArray(payload.servers) ? payload.servers : null;
  if (!servers) return [];
  const out = [];
  for (const raw of servers) {
    const rec = pickKnownFields(raw);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Load the on-disk registry cache, returning { fetchedAt, data } or null.
 * Null is returned for missing, unreadable, or corrupt files.
 */
export async function loadRegistryCache(cachePath) {
  try {
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.fetchedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save the registry cache atomically-ish (tmp write + rename).
 * `data` is the raw registry payload — unknown fields are preserved for
 * forward compatibility.
 */
export async function saveRegistryCache(cachePath, data) {
  const dir = path.dirname(cachePath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    // ignore — write will fail informatively
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    data,
  };
  const tmpPath = cachePath + '.tmp';
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, cachePath);
  return payload;
}

function isFresh(fetchedAt, now = Date.now()) {
  if (typeof fetchedAt !== 'string') return false;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  return (now - t) < CACHE_TTL_MS;
}

function defaultFetch(url) {
  if (typeof globalThis.fetch !== 'function') {
    return Promise.reject(new Error('fetch is not available in this runtime'));
  }
  return globalThis.fetch(url);
}

/**
 * Primary entry point.
 *
 * Returns:
 *   {
 *     servers: [{ name, description?, version?, repository? }, ...],
 *     fetchedAt: ISO string (from cache or fresh fetch),
 *     fromCache: boolean,
 *     stale?: boolean,       // true when using an expired cache after failed refetch
 *     warning?: string,      // human-readable note for the caller to surface as INFO
 *   }
 */
export async function fetchRegistry(options = {}) {
  const cachePath = options.cachePath || getDefaultCachePath();
  const fetchImpl = options.fetchImpl || defaultFetch;
  const url = options.url || REGISTRY_URL;
  const force = options.force === true;

  const cached = await loadRegistryCache(cachePath);

  // Cache hit (not forced, fresh) — skip network.
  if (!force && cached && isFresh(cached.fetchedAt)) {
    return {
      servers: extractServers(cached.data),
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    };
  }

  // Attempt network fetch.
  let response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    // Network error. If we have a stale cache, use it.
    if (cached) {
      const when = cached.fetchedAt.slice(0, 10);
      return {
        servers: extractServers(cached.data),
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: true,
        warning: `MCP registry refetch failed, using stale cache from ${when}`,
      };
    }
    return {
      servers: [],
      fetchedAt: null,
      fromCache: false,
      warning: `MCP registry unreachable: ${err.message || 'unknown error'}`,
    };
  }

  if (!response || !response.ok) {
    const status = response && typeof response.status === 'number' ? response.status : '?';
    if (cached) {
      const when = cached.fetchedAt.slice(0, 10);
      return {
        servers: extractServers(cached.data),
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: true,
        warning: `MCP registry returned status ${status}, using stale cache from ${when}`,
      };
    }
    return {
      servers: [],
      fetchedAt: null,
      fromCache: false,
      warning: `MCP registry returned status ${status}`,
    };
  }

  // Try to parse JSON; tolerate malformed responses.
  let data;
  try {
    data = await response.json();
  } catch (err) {
    if (cached) {
      const when = cached.fetchedAt.slice(0, 10);
      return {
        servers: extractServers(cached.data),
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: true,
        warning: `MCP registry response was not valid JSON, using stale cache from ${when}`,
      };
    }
    return {
      servers: [],
      fetchedAt: null,
      fromCache: false,
      warning: `MCP registry response was invalid JSON (parse error): ${err.message || 'unknown error'}`,
    };
  }

  // Persist cache (best-effort).
  let fetchedAt;
  try {
    const saved = await saveRegistryCache(cachePath, data);
    fetchedAt = saved.fetchedAt;
  } catch {
    fetchedAt = new Date().toISOString();
  }

  return {
    servers: extractServers(data),
    fetchedAt,
    fromCache: false,
  };
}

/**
 * Find a registry server whose normalized base name is 1-2 edits from
 * the input package name's base. Used as an augmentation to the
 * hand-curated typosquat matcher.
 *
 * Reuses the same Levenshtein thresholds as the hand-curated matcher:
 *   - length delta > 3     → skip
 *   - base length ≤ 12     → max distance 1
 *   - base length > 12     → max distance 2
 */
export function findRegistryTyposquatMatch(packageName, registryServers, levenshtein) {
  if (typeof packageName !== 'string' || !packageName) return null;
  if (!Array.isArray(registryServers) || registryServers.length === 0) return null;
  if (typeof levenshtein !== 'function') return null;

  const slashIdx = packageName.lastIndexOf('/');
  const inputBase = (slashIdx >= 0 ? packageName.slice(slashIdx + 1) : packageName).toLowerCase();
  if (!inputBase) return null;

  for (const srv of registryServers) {
    const knownBase = normalizeRegistryServerName(srv.name);
    if (!knownBase) continue;
    if (knownBase === inputBase) return null; // exact match → not a typosquat
    if (Math.abs(inputBase.length - knownBase.length) > 3) continue;
    const maxDist = knownBase.length <= 12 ? 1 : 2;
    const dist = levenshtein(inputBase, knownBase);
    if (dist >= 1 && dist <= maxDist) {
      return srv.name;
    }
  }
  return null;
}
