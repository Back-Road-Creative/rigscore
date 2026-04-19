import { hashTools } from '../mcp-hash.js';
import { loadState, saveState, STATE_VERSION, STATE_FILENAME } from '../state.js';

/**
 * Read all of process.stdin as UTF-8 and return it as a string.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseStdinJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * `rigscore mcp-hash`
 *   Read a tools/list JSON response from stdin; print SHA-256 hex to stdout.
 *   Exit 0 on success, 2 on invalid JSON.
 */
export async function runMcpHash() {
  const raw = await readStdin();
  const parsed = parseStdinJson(raw);
  if (!parsed.ok) {
    process.stderr.write(`Error: invalid JSON on stdin: ${parsed.error.message}\n`);
    process.exit(2);
  }
  const hash = hashTools(parsed.value);
  process.stdout.write(hash + '\n');
  process.exit(0);
}

/**
 * `rigscore mcp-pin <serverName> <hashHex>`
 *   Persist the runtime tool hash for a server in .rigscore-state.json.
 *   Preserves any existing Round 2 `mcpServers` top-level map (configHash).
 */
export async function runMcpPin(args) {
  const [serverName, hashHex] = args;
  if (!serverName || !hashHex) {
    process.stderr.write('Usage: rigscore mcp-pin <serverName> <hashHex>\n');
    process.exit(2);
  }
  if (!/^[a-f0-9]{64}$/i.test(hashHex)) {
    process.stderr.write(`Error: hash must be a 64-character lowercase hex sha256 digest (got "${hashHex.slice(0, 16)}...")\n`);
    process.exit(2);
  }

  const cwd = process.cwd();
  const { state, corrupt } = await loadState(cwd);
  const base = (!corrupt && state && typeof state === 'object') ? state : {};
  const merged = {
    ...base,
    version: STATE_VERSION,
    servers: { ...(base.servers || {}) },
  };
  merged.servers[serverName] = {
    ...(merged.servers[serverName] || {}),
    runtimeToolHash: hashHex.toLowerCase(),
    runtimeToolPinnedAt: new Date().toISOString(),
  };
  await saveState(cwd, merged);

  process.stdout.write(`Pinned runtime tool hash for "${serverName}" in ${STATE_FILENAME}\n`);
  process.exit(0);
}

/**
 * `rigscore mcp-verify <serverName>`
 *   Read a tools/list JSON from stdin, hash it, compare to stored pin.
 *   Exit 0 on match, non-zero otherwise.
 */
export async function runMcpVerify(args) {
  const [serverName] = args;
  if (!serverName) {
    process.stderr.write('Usage: rigscore mcp-verify <serverName>   (reads JSON from stdin)\n');
    process.exit(2);
  }

  const raw = await readStdin();
  const parsed = parseStdinJson(raw);
  if (!parsed.ok) {
    process.stderr.write(`Error: invalid JSON on stdin: ${parsed.error.message}\n`);
    process.exit(2);
  }
  const currentHash = hashTools(parsed.value);

  const cwd = process.cwd();
  const { state } = await loadState(cwd);
  const entry = state && state.servers && state.servers[serverName];
  const storedHash = entry && typeof entry.runtimeToolHash === 'string' ? entry.runtimeToolHash : null;
  const pinnedAt = entry && typeof entry.runtimeToolPinnedAt === 'string' ? entry.runtimeToolPinnedAt : null;

  if (!storedHash) {
    process.stderr.write(
      `Error: no runtime tool hash pinned for server "${serverName}".\n` +
      `Remediation: generate a pin with:\n` +
      `  npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin ${serverName}\n`
    );
    process.exit(3);
  }

  if (storedHash === currentHash) {
    process.stdout.write(`OK: runtime tool hash for "${serverName}" matches pin.\n`);
    process.exit(0);
  }

  process.stderr.write(
    `Drift detected for MCP server "${serverName}":\n` +
    `  stored:  ${storedHash.slice(0, 12)}... (pinned ${pinnedAt || 'unknown'}, pinnedAt above)\n` +
    `  current: ${currentHash.slice(0, 12)}...\n` +
    `The server's tool descriptions differ from the pinned snapshot. This is how\n` +
    `CVE-2025-54136-class runtime description attacks pivot trusted MCP servers.\n` +
    `If the change is intentional, re-pin with:\n` +
    `  npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin ${serverName}\n`
  );
  process.exit(4);
}
