import crypto from 'node:crypto';

/**
 * Runtime tool-description hashing for MCP servers.
 *
 * Architecture note (CRITICAL):
 *   rigscore NEVER executes an MCP server subprocess. Users invoke the server
 *   themselves and pipe the `tools/list` JSON response into
 *   `rigscore mcp-hash`. This avoids RCE-on-scan attacks from malicious MCP
 *   packages.
 *
 * Canonicalization rules (must be deterministic across hosts / JSON orderings):
 *   1. Extract the tools array. Accepts either a raw JSON-RPC envelope
 *      ({ result: { tools: [...] } }) or a bare { tools: [...] }.
 *   2. Sort tools by `name` (tools without a name sort last, stably).
 *   3. Deep-sort all object keys recursively (arrays keep their order, except
 *      the top-level tools array which we just sorted by name).
 *   4. JSON.stringify with no whitespace.
 *   5. SHA-256 hex digest.
 */

/**
 * Extract the tools array from a tools/list JSON-RPC response shape.
 * Accepts { result: { tools } } or { tools }. Returns [] if neither present.
 * @param {unknown} input
 * @returns {unknown[]}
 */
export function extractTools(input) {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input.tools)) return input.tools;
  if (input.result && typeof input.result === 'object' && Array.isArray(input.result.tools)) {
    return input.result.tools;
  }
  return [];
}

/**
 * Recursively sort object keys so that two semantically equal JSON values
 * serialize identically regardless of key insertion order.
 * Arrays are returned as-is; each element is recursed into.
 */
function deepSortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = deepSortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalize a tools/list response into a deterministic JSON string with
 * no whitespace. The top-level tools array is sorted by `name`.
 *
 * @param {unknown} input
 * @returns {string} Canonical JSON string of the tools array
 */
export function canonicalize(input) {
  const tools = extractTools(input);
  // Sort by name — tools with no name sort after named tools (stable fallback).
  const withNames = tools.map((t, i) => ({ t, i, name: t && typeof t === 'object' ? t.name : undefined }));
  withNames.sort((a, b) => {
    if (a.name === b.name) return a.i - b.i;
    if (a.name === undefined) return 1;
    if (b.name === undefined) return -1;
    return a.name < b.name ? -1 : 1;
  });
  const sortedTools = withNames.map(({ t }) => deepSortKeys(t));
  return JSON.stringify(sortedTools);
}

/**
 * SHA-256 hex digest of the canonicalized tools/list response.
 *
 * @param {unknown} input
 * @returns {string} 64-char lowercase hex digest
 */
export function hashTools(input) {
  const canonical = canonicalize(input);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
