import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { hashTools } from '../mcp-hash.js';
import { loadState, saveState, STATE_VERSION, STATE_FILENAME } from '../state.js';
import { readJsonSafe, readFileSafe } from '../utils.js';
import { repoMcpRelPaths, readMcpConfig, mcpServersIn } from '../clients.js';
import { fetchToolList, buildChildEnv, DEFAULT_CONNECT_TIMEOUT_MS } from '../lib/mcp-connect.js';

// Exit codes beyond the existing 2 (usage), 3 (no pin), 4 (drift).
const EXIT_CONNECT_FAILED = 5;

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

/**
 * Split `--connect` / `--yes` out of a subcommand's argv. Everything else is a
 * positional. `--connect` and consent are per-invocation flags only: no config
 * file, environment variable or default can turn them on.
 */
function parseConnectFlags(args) {
  const out = { connect: false, yes: false, positionals: [] };
  for (const a of args) {
    if (a === '--connect') out.connect = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else out.positionals.push(a);
  }
  return out;
}

function fail(message, code = 2) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Find `serverName` in the project's committed MCP configs and turn it into a
 * launch plan. Only local stdio servers qualify. A relative command path is
 * resolved through symlinks and must stay inside the project.
 */
async function resolveLaunchPlan(serverName, cwd) {
  let spec = null;
  let source = null;
  for (const rel of repoMcpRelPaths()) {
    const config = await readMcpConfig(path.join(cwd, rel), { readJson: readJsonSafe, readText: readFileSafe });
    const servers = mcpServersIn(rel, config);
    if (Object.prototype.hasOwnProperty.call(servers, serverName) && servers[serverName]
        && typeof servers[serverName] === 'object') {
      spec = servers[serverName];
      source = rel;
      break;
    }
  }
  if (!spec) fail(`no MCP server named "${serverName}" in this project's MCP config files`);
  // Normalise the two shapes: `command` string + `args` (most clients) and
  // opencode's `command` array (program first) with variables under `environment`.
  let rawCommand = spec.command;
  let rawArgs = Array.isArray(spec.args) ? spec.args : [];
  if (Array.isArray(rawCommand)) {
    rawArgs = [...rawCommand.slice(1), ...rawArgs];
    rawCommand = rawCommand[0];
  }
  if (typeof rawCommand !== 'string' || !rawCommand || spec.url) {
    fail(`"${serverName}" is not a local stdio server (it declares a url or no command); --connect only launches local stdio servers`);
  }

  // A relative command, or a relative script argument (`node ./srv.js`), that resolves
  // through symlinks outside the project is refused: a committed symlink must not
  // smuggle in a program from elsewhere.
  let root;
  try { root = fs.realpathSync(cwd); } catch { root = cwd; }
  const outside = (what, value) =>
    fail(`${what} "${value}" for "${serverName}" resolves outside the project (symlink); refusing to launch it`);

  let command = rawCommand;
  if (/[\\/]/.test(command) && !path.isAbsolute(command)) {
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(cwd, command));
    } catch {
      fail(`command "${command}" for "${serverName}" does not exist`);
    }
    if (!isInside(root, resolved)) outside('command', command);
    command = resolved;
  }

  const args = rawArgs.map((a) => String(a));
  for (const a of args) {
    if (a.startsWith('-') || path.isAbsolute(a)) continue;
    let resolved;
    // Only an existing FILE can be a script the interpreter runs; a directory arg is data.
    try {
      resolved = fs.realpathSync(path.resolve(cwd, a));
      if (!fs.statSync(resolved).isFile()) continue;
    } catch { continue; } // not a path on disk
    if (!isInside(root, resolved)) outside('argument', a);
  }
  const declaredEnv = [spec.env, spec.environment].find((e) => e && typeof e === 'object' && !Array.isArray(e)) || {};
  return {
    source,
    command,
    args,
    cwd,
    envKeys: Object.keys(declaredEnv).filter((k) => typeof declaredEnv[k] === 'string').sort(),
    env: buildChildEnv(declaredEnv),
  };
}

function describePlan(serverName, plan) {
  const argv = [plan.command, ...plan.args].map((a) => JSON.stringify(a)).join(' ');
  return (
    `rigscore will LAUNCH this program from ${plan.source} to read its tool list:\n` +
    `  server:  ${serverName}\n` +
    `  argv:    ${argv}\n` +
    `  cwd:     ${plan.cwd}\n` +
    `  env:     minimal (PATH, HOME, ...) plus declared keys: ${plan.envKeys.length ? plan.envKeys.join(', ') : '(none)'}\n` +
    `The repository chose this command. Only continue if you trust it.\n`
  );
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
    rl.on('close', () => resolve(false));
  });
}

/**
 * Show the exact launch plan, obtain consent for THIS run (--yes, or an
 * interactive yes on a terminal), then launch the server and return its tool
 * list. Without consent the process exits 2 and nothing is spawned.
 */
async function connectForTools(serverName, yes) {
  const plan = await resolveLaunchPlan(serverName, process.cwd());
  process.stderr.write(describePlan(serverName, plan));
  if (!yes) {
    if (!(process.stdin.isTTY && process.stderr.isTTY)) {
      fail('consent required: --connect launches a program the repository chose. Re-run with --yes to consent for this run (nothing was launched).');
    }
    if (!(await askYesNo('Launch it? [y/N] '))) {
      fail('consent not given; nothing was launched.');
    }
  }
  const envTimeout = Number(process.env.RIGSCORE_CONNECT_TIMEOUT_MS);
  try {
    return await fetchToolList(plan, {
      timeoutMs: Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    return fail(`could not read the tool list from "${serverName}": ${err.message}`, EXIT_CONNECT_FAILED);
  }
}

/** Persist a runtime tool hash for a server (shared by mcp-pin and mcp-pin --connect). */
async function writePin(serverName, hashHex) {
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
}

function checkServerName(serverName) {
  // Constrain to printable shell-safe characters and block prototype keys
  // (`__proto__`, `constructor`, `prototype`) that would otherwise mutate
  // Object.prototype when set on `merged.servers`. Real MCP server names
  // in the wild use underscores (e.g. `mcp_server_foo`), so the regex
  // permits them; the explicit blocklist handles the dangerous cases.
  const PROTO_BLOCKLIST = new Set(['__proto__', 'constructor', 'prototype']);
  if (!/^[A-Za-z0-9._@/_-]+$/.test(serverName)
      || serverName.length > 256
      || PROTO_BLOCKLIST.has(serverName)) {
    process.stderr.write(`Error: invalid server name "${serverName}" — must match /^[A-Za-z0-9._@/_-]+$/, be ≤256 chars, and not be a prototype-pollution key\n`);
    process.exit(2);
  }
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
 * `rigscore mcp-hash --connect <server> [--yes]`
 *   Opt in to launching the named local stdio server (after showing its exact
 *   argv and obtaining consent for this run) and hash its live tool list.
 */
export async function runMcpHash(args = process.argv.slice(3)) {
  const flags = parseConnectFlags(args);
  if (flags.connect) {
    if (flags.positionals.length !== 1) fail('Usage: rigscore mcp-hash --connect <serverName> [--yes]');
    checkServerName(flags.positionals[0]);
    const tools = await connectForTools(flags.positionals[0], flags.yes);
    process.stdout.write(hashTools(tools) + '\n');
    process.exit(0);
  }
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
 * `rigscore mcp-pin <serverName> --connect [--yes]`
 *   Persist the runtime tool hash for a server in .rigscore-state.json.
 *   Preserves any existing Round 2 `mcpServers` top-level map (configHash).
 */
export async function runMcpPin(args) {
  const flags = parseConnectFlags(args);
  if (flags.connect) {
    if (flags.positionals.length !== 1) {
      fail('Usage: rigscore mcp-pin <serverName> --connect [--yes]   (--connect takes no pasted hash)');
    }
    const [name] = flags.positionals;
    checkServerName(name);
    const tools = await connectForTools(name, flags.yes);
    await writePin(name, hashTools(tools));
    process.exit(0);
  }
  const [serverName, hashHex] = args;
  if (!serverName || !hashHex) {
    process.stderr.write('Usage: rigscore mcp-pin <serverName> <hashHex>   |   rigscore mcp-pin <serverName> --connect [--yes]\n');
    process.exit(2);
  }
  checkServerName(serverName);
  if (!/^[a-f0-9]{64}$/i.test(hashHex)) {
    process.stderr.write(`Error: hash must be a 64-character lowercase hex sha256 digest (got "${hashHex.slice(0, 16)}...")\n`);
    process.exit(2);
  }
  await writePin(serverName, hashHex);
  process.exit(0);
}

/**
 * `rigscore mcp-verify <serverName>`
 *   Read a tools/list JSON from stdin, hash it, compare to stored pin.
 *   Exit 0 on match, non-zero otherwise.
 */
export async function runMcpVerify(args) {
  const flags = parseConnectFlags(args);
  const [serverName] = flags.positionals;
  if (!serverName || flags.positionals.length > 1) {
    process.stderr.write('Usage: rigscore mcp-verify <serverName>   (reads JSON from stdin)\n       rigscore mcp-verify <serverName> --connect [--yes]\n');
    process.exit(2);
  }

  let currentHash;
  if (flags.connect) {
    checkServerName(serverName);
    currentHash = hashTools(await connectForTools(serverName, flags.yes));
  } else {
    const raw = await readStdin();
    const parsed = parseStdinJson(raw);
    if (!parsed.ok) {
      process.stderr.write(`Error: invalid JSON on stdin: ${parsed.error.message}\n`);
      process.exit(2);
    }
    currentHash = hashTools(parsed.value);
  }

  const cwd = process.cwd();
  const { state } = await loadState(cwd);
  const entry = state && state.servers && state.servers[serverName];
  const storedHash = entry && typeof entry.runtimeToolHash === 'string' ? entry.runtimeToolHash : null;
  const pinnedAt = entry && typeof entry.runtimeToolPinnedAt === 'string' ? entry.runtimeToolPinnedAt : null;

  if (!storedHash) {
    process.stderr.write(
      `Error: no runtime tool hash pinned for server "${serverName}".\n` +
      `Remediation: generate a pin with:\n` +
      `  npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin ${serverName}\n` +
      `or, to let rigscore launch the configured local server (explicit consent each run):\n` +
      `  rigscore mcp-pin ${serverName} --connect\n`
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
