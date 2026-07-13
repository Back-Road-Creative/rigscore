import path from 'node:path';
import https from 'node:https';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
import { readJsonSafe, readFileSafe, fileExists } from '../utils.js';
import { KNOWN_MCP_SERVERS, findTyposquatMatch, levenshtein } from '../known-mcp-servers.js';
import { readRepoServers, loadState, loadCommittedState, saveState, STATE_VERSION, STATE_FILENAME } from '../state.js';
import { fetchRegistry, findRegistryTyposquatMatch, getDefaultCachePath } from '../mcp-registry.js';
import { mcpConfigPaths, mcpServersIn } from '../clients.js';

const SENSITIVE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'SLACK_TOKEN',
];

const DEFAULT_SAFE_HOSTS = ['127.0.0.1', 'localhost', '::1'];

const SENSITIVE_PATHS = ['/', '/home', '/etc', '/root', '/var', '/opt', '/usr'];

const UNSAFE_PERMISSION_FLAGS = [
  '--allow-all', '--no-sandbox', '--unsafe', '--allow-tools', '--disable-security',
  '--privileged', '--unrestricted', '--dangerously-skip-permissions',
];

const DANGEROUS_HOOK_PATTERNS = [
  /\bcurl\b/, /\bwget\b/, /\brm\s+-rf\b/, /\beval\b/, /\bbase64\s+-d\b/,
  /\bnc\b/, /\/dev\/tcp/, /\bpython\s+-c\b/, /\bnode\s+-e\b/,
];

const UNSTABLE_TAGS = new Set([
  'latest', 'next', 'main', 'dev', 'nightly', 'canary', 'beta', 'alpha', 'rc',
]);

// Return the first non-flag arg in the args list, skipping -y and --yes.
// Used to locate the package-position arg in an `npx` invocation so that
// version-pin detection does not accidentally match `@` characters inside
// unrelated flag values (e.g. `--token=@abc123`).
export function findPackagePositionArg(args) {
  if (!Array.isArray(args)) return null;
  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (a === '-y' || a === '--yes') continue;
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

// True iff the given arg carries a stable (non-unstable-tag) version pin of the
// form `pkg@1.0.0` or `@scope/pkg@1.0.0`.
export function argHasStableVersionPin(a) {
  if (typeof a !== 'string') return false;
  let versionPart = null;
  if (a.startsWith('@')) {
    const slashIdx = a.indexOf('/');
    if (slashIdx === -1) return false;
    const atIdx = a.indexOf('@', slashIdx + 1);
    if (atIdx === -1) return false;
    versionPart = a.slice(atIdx + 1);
  } else {
    const atIdx = a.indexOf('@');
    if (atIdx === -1) return false;
    versionPart = a.slice(atIdx + 1);
  }
  return Boolean(versionPart) && !UNSTABLE_TAGS.has(versionPart.toLowerCase());
}

function extractPathsFromArgs(args) {
  const paths = [];
  const flagPatterns = ['--directory', '--root', '--path', '--allowed-directories', '--dir'];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Handle --flag=value syntax
    for (const flag of flagPatterns) {
      if (arg.startsWith(flag + '=')) {
        const value = arg.slice(flag.length + 1);
        // May be comma-separated
        paths.push(...value.split(',').map(p => p.trim()));
      }
    }

    // Handle --flag value syntax
    if (flagPatterns.includes(arg) && i + 1 < args.length) {
      const value = args[i + 1];
      // May be comma-separated
      paths.push(...value.split(',').map(p => p.trim()));
    }

    // Standalone path args (starts with / but not --)
    if (arg.startsWith('/') && !arg.startsWith('--')) {
      paths.push(arg);
    }
  }

  return paths;
}

function extractHost(urlOrTransport) {
  try {
    const url = new URL(urlOrTransport);
    return url.hostname;
  } catch {
    return null;
  }
}

// Cap the npm registry response we'll buffer before aborting. A typical
// package document is a few KB; anything over half a megabyte is either a
// transport-level surprise (compressed-and-bombed tarball metadata, hung
// connection feeding garbage, malicious redirect target) or a registry
// outage returning HTML. Abort rather than grow an unbounded string.
export const MAX_REGISTRY_BYTES = 512 * 1024;

// Drain a response into a string, aborting if it exceeds `maxBytes`.
// Resolves to the body on success or null on overflow / stream error.
function streamCappedBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    let data = '';
    let bytesRead = 0;
    let aborted = false;
    res.on('data', (chunk) => {
      if (aborted) return;
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        aborted = true;
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk;
    });
    res.on('end', () => { if (!aborted) resolve(data); });
    res.on('error', () => { if (!aborted) resolve(null); });
  });
}

// Convert an npm registry JSON body into a finding (or null).
function npmRegistryBodyToFinding(packageName, statusCode, body) {
  if (statusCode === 404) {
    return {
      findingId: 'mcp-config/npm-package-not-found',
      severity: 'critical',
      title: `MCP package "${packageName}" not found on npm`,
      detail: 'This package does not exist on the npm registry. It may be a private package or a typo.',
      remediation: 'Verify the package name and source.',
      context: { packageName },
    };
  }
  if (statusCode !== 200) return null;
  let pkg;
  try { pkg = JSON.parse(body); } catch { return null; }
  if (!pkg.time?.created) return null;
  const daysSinceCreated = (Date.now() - Date.parse(pkg.time.created)) / (1000 * 60 * 60 * 24);
  if (daysSinceCreated < 30) {
    return {
      findingId: 'mcp-config/npm-package-very-new',
      severity: 'warning',
      title: `MCP package "${packageName}" is very new (${Math.round(daysSinceCreated)} days old)`,
      detail: 'New packages have less community vetting and could be malicious.',
      remediation: 'Review the package source code and maintainer reputation before using.',
      context: { packageName, daysSinceCreated: Math.round(daysSinceCreated) },
    };
  }
  return null;
}

export function checkNpmRegistry(packageName, options = {}) {
  const httpGet = options.httpGet || https.get;
  const maxBytes = options.maxBytes || MAX_REGISTRY_BYTES;
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);
    const done = (v) => { clearTimeout(timeout); resolve(v); };

    const req = httpGet(url, { timeout: 5000 }, async (res) => {
      const body = await streamCappedBody(req, res, maxBytes);
      if (body === null) { done(null); return; }
      done(npmRegistryBodyToFinding(packageName, res.statusCode, body));
    });

    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
  });
}

/**
 * Per-server extractions from run(). Wave 13a phase of the mcp-config
 * god-function decomposition (Complexity #1, critical). Each helper takes
 * the raw server object plus its name + relPath label and returns the
 * findings array. Behavior is bit-identical to the inline blocks they
 * replace — same finding IDs, severities, evidence, learnMore URLs.
 */

/**
 * Transport-type detection. SSE / HTTP / explicit url field counts as a
 * network transport; localhost targets get an INFO note instead of the
 * larger-attack-surface WARNING. Returns `hasNetworkTransport` so the
 * outer loop can roll it up into the check's `data` block.
 */
export function checkTransportType(server, name, relPath, safeHosts) {
  const findings = [];
  let hasNetworkTransport = false;

  const transport = server.transport || 'stdio';
  if (transport === 'sse' || transport === 'http' || server.url) {
    const targetUrl = server.url || '';
    const host = extractHost(targetUrl);
    const isLocal = host && safeHosts.includes(host);

    if (isLocal) {
      findings.push({
        findingId: 'mcp-config/localhost-server',
        severity: 'info',
        title: `MCP server "${name}" is a localhost server`,
        detail: `Server uses ${transport || 'network'} transport targeting ${host} in ${relPath}.`,
      });
    } else {
      hasNetworkTransport = true;
      findings.push({
        findingId: 'mcp-config/network-transport',
        severity: 'warning',
        title: `MCP server "${name}" uses network transport`,
        detail: `Server uses ${transport || 'network'} transport in ${relPath}. Network-based MCP servers have a larger attack surface than stdio.`,
        remediation: 'Prefer stdio transport for local MCP servers. If network transport is required, ensure authentication and TLS.',
        learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-permissions',
      });
    }
  }

  return { findings, hasNetworkTransport };
}

/**
 * Sensitive-env passthrough. >=3 distinct sensitive keys upgrades to
 * CRITICAL ("wildcard" passthrough); 1-2 keys is a WARNING that asks the
 * user to verify the server actually needs them.
 */
export function checkSensitiveEnv(server, name, relPath) {
  const env = server.env || {};
  const envKeys = Object.keys(env);
  const sensitiveKeys = envKeys.filter((k) => SENSITIVE_ENV_KEYS.includes(k));
  if (sensitiveKeys.length === 0) return [];
  if (sensitiveKeys.length >= 3) {
    return [{
      findingId: 'mcp-config/env-wildcard-sensitive-vars',
      severity: 'critical',
      title: `MCP server "${name}" receives ${sensitiveKeys.length} sensitive env vars`,
      detail: `Sensitive environment variables (${sensitiveKeys.join(', ')}) are passed to this server.`,
      remediation: 'Only pass environment variables that the server actually needs.',
    }];
  }
  return [{
    findingId: 'mcp-config/env-sensitive-vars',
    severity: 'warning',
    title: `MCP server "${name}" receives sensitive env var(s): ${sensitiveKeys.join(', ')}`,
    detail: `Sensitive keys passed in ${relPath}.`,
    remediation: 'Verify this server needs these credentials.',
  }];
}

/**
 * CVE-2026-21852: ANTHROPIC_BASE_URL/API_BASE redirect in the MCP server
 * env. Co-disclosed with CVE-2025-59536 in the Checkpoint writeup; see
 * the comment on `learnMore` for why the URL slug names the other CVE.
 */
/**
 * Pull the npm package name out of an MCP server's args list. Skips flags,
 * matches the first arg that looks like a package spec, and strips any
 * trailing @version suffix while preserving the scope prefix for scoped
 * packages (`@scope/pkg`). Returns null when no plausible package found.
 */
export function extractPackageName(args) {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('-')) continue;
    if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(@.+)?$/.test(arg)) continue;
    if (arg.startsWith('@')) {
      const slashIdx = arg.indexOf('/');
      if (slashIdx !== -1) {
        const afterSlash = arg.slice(slashIdx + 1);
        const atIdx = afterSlash.indexOf('@');
        return atIdx !== -1 ? arg.slice(0, slashIdx + 1 + atIdx) : arg;
      }
      return arg;
    }
    const atIdx = arg.indexOf('@');
    return atIdx !== -1 ? arg.slice(0, atIdx) : arg;
  }
  return null;
}

/**
 * Offline typosquat detection against the hand-curated KNOWN_MCP_SERVERS
 * list. Returns `{ findings, hadCuratedMatch }` so the outer loop can
 * skip the registry-based check when a curated match already fired.
 */
export function checkTyposquatCurated(name, packageName) {
  if (!packageName || KNOWN_MCP_SERVERS.includes(packageName)) {
    return { findings: [], hadCuratedMatch: false };
  }
  const match = findTyposquatMatch(packageName);
  if (!match) return { findings: [], hadCuratedMatch: false };
  return {
    findings: [{
      findingId: 'mcp-config/typosquat-curated',
      severity: 'warning',
      title: `MCP server "${name}": package "${packageName}" is similar to known "${match}"`,
      detail: `Levenshtein distance 1-2 from an official MCP server package. This could be a typosquat.`,
      remediation: `Verify the package name is correct. Did you mean "${match}"?`,
    }],
    hadCuratedMatch: true,
  };
}

/**
 * Online typosquat detection against the MCP registry mirror. Bails out
 * silently when no `packageName`, when the registry fetch produced no
 * usable server list, or when a curated match already fired upstream.
 */
export function checkTyposquatRegistry(name, packageName, registryResult, hadCuratedMatch) {
  if (!packageName || hadCuratedMatch) return [];
  if (!registryResult || !Array.isArray(registryResult.servers) || registryResult.servers.length === 0) return [];
  const regMatch = findRegistryTyposquatMatch(packageName, registryResult.servers, levenshtein);
  if (!regMatch) return [];
  return [{
    findingId: 'mcp-config/typosquat-registry',
    severity: 'critical',
    title: `MCP server "${name}": package "${packageName}" typosquats registry server "${regMatch}"`,
    detail: `Package name is 1-2 edits from "${regMatch}" in the official MCP registry at https://registry.modelcontextprotocol.io. Source: MCP registry.`,
    remediation: `Verify the package name is correct. Did you mean "${regMatch}"?`,
    learnMore: 'https://registry.modelcontextprotocol.io/v0/servers',
  }];
}

/**
 * Scan `.claude/settings.json` (project + homedir) for two classes of
 * danger:
 *  1. `enableAllProjectMcpServers: true` — auto-approves every server
 *     in `.mcp.json` without user consent (CRITICAL).
 *  2. `hooks[*][*].command` matching DANGEROUS_HOOK_PATTERNS — hooks
 *     run on every collaborator on clone (CRITICAL).
 *
 * Returns `{ findings, autoApproveEnabled }` so the downstream
 * CVE-2025-59536 compound detection can reuse the parse without
 * re-reading the settings files.
 */
export async function checkClaudeSettings(cwd, homedir) {
  const findings = [];
  let autoApproveEnabled = false;
  const settingsPaths = [
    path.join(cwd, '.claude', 'settings.json'),
    path.join(homedir, '.claude', 'settings.json'),
  ];
  for (const settingsPath of settingsPaths) {
    const settings = await readJsonSafe(settingsPath);
    if (!settings) continue;

    const relPath = path.relative(cwd, settingsPath) || settingsPath;

    if (settings.enableAllProjectMcpServers === true) {
      autoApproveEnabled = true;
      findings.push({
        findingId: 'mcp-config/mcp-auto-approve-enabled',
        severity: 'critical',
        title: `MCP auto-approve enabled in ${relPath}`,
        detail: 'enableAllProjectMcpServers is true — all project MCP servers are auto-approved without user consent.',
        remediation: 'Remove enableAllProjectMcpServers or set it to false.',
        context: { file: relPath },
      });
    }

    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const [hookName, hookList] of Object.entries(settings.hooks)) {
        const hooks = Array.isArray(hookList) ? hookList : [];
        for (const hook of hooks) {
          const cmd = hook?.command || '';
          for (const pattern of DANGEROUS_HOOK_PATTERNS) {
            if (pattern.test(cmd)) {
              findings.push({
                findingId: 'mcp-config/dangerous-hook-command',
                severity: 'critical',
                title: `Dangerous hook command in ${relPath} (${hookName})`,
                detail: `Hook "${hookName}" runs a potentially dangerous command: ${cmd.slice(0, 80)}`,
                remediation: 'Review and remove dangerous hook commands. Hooks execute on every collaborator who clones this project.',
                context: { file: relPath, hookName },
              });
              break;
            }
          }
        }
      }
    }
  }
  return { findings, autoApproveEnabled };
}

/**
 * CVE-2025-59536: compound detection. A repo-level `.mcp.json` plus a
 * `.claude/settings.json` with `enableAllProjectMcpServers: true` means
 * every collaborator who clones the project auto-approves every server
 * on first run — a settings-bypass RCE channel.
 *
 * Pure helper; consumes the flags already computed by run() (whether
 * a repo `.mcp.json` was found) and checkClaudeSettings (whether
 * auto-approve is enabled anywhere on the settings path).
 */
export function checkCve2025_59536(hasRepoMcpJson, autoApproveEnabled) {
  if (!hasRepoMcpJson || !autoApproveEnabled) return [];
  return [{
    findingId: 'mcp-config/cve-2025-59536-auto-approve-on-clone',
    severity: 'critical',
    title: 'CVE-2025-59536: repo MCP servers auto-approved on clone',
    detail: 'This project has .mcp.json with MCP servers AND enableAllProjectMcpServers is true in settings. Anyone cloning this repo will auto-approve all MCP servers without consent — a compound settings bypass vulnerability.',
    remediation: 'Set enableAllProjectMcpServers to false. Review .mcp.json servers individually before approving.',
    learnMore: 'https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/',
  }];
}

/**
 * Cross-client drift detection. Walks the per-client `clientServers`
 * map and flags any server whose args / env-key set / transport differs
 * between two or more clients (WARNING `cross-client-drift`). Also
 * emits an INFO finding for servers configured in only one client
 * when 2+ clients are detected — useful coverage signal.
 *
 * Returns the drift flag so the outer loop can surface it in `data`.
 */
export function checkCrossClientDrift(clientServers) {
  const findings = [];
  let driftDetected = false;
  if (clientServers.size < 2) return { findings, driftDetected };

  const allServerNames = new Set();
  for (const servers of clientServers.values()) {
    for (const name of Object.keys(servers)) {
      allServerNames.add(name);
    }
  }

  for (const serverName of allServerNames) {
    const configs = [];
    for (const [clientPath, servers] of clientServers.entries()) {
      if (servers[serverName]) {
        configs.push({ clientPath, server: servers[serverName] });
      }
    }

    if (configs.length >= 2) {
      const signatures = configs.map((c) => JSON.stringify({
        args: c.server.args || [],
        env: Object.keys(c.server.env || {}).sort(),
        transport: c.server.transport || 'stdio',
      }));
      const unique = new Set(signatures);
      if (unique.size > 1) {
        driftDetected = true;
        findings.push({
          findingId: 'mcp-config/cross-client-drift',
          severity: 'warning',
          title: `Cross-client drift: "${serverName}" configured differently across clients`,
          detail: `Server "${serverName}" has divergent configurations in: ${configs.map((c) => c.clientPath).join(', ')}.`,
          remediation: 'Align MCP server configurations across all AI clients.',
          context: { serverName, clients: configs.map((c) => c.clientPath) },
        });
      }
    } else if (configs.length === 1) {
      findings.push({
        findingId: 'mcp-config/single-client-server',
        severity: 'info',
        title: `MCP server "${serverName}" only configured in ${configs[0].clientPath}`,
        detail: 'This server is not configured in all detected AI clients.',
        context: { serverName, client: configs[0].clientPath },
      });
    }
  }

  return { findings, driftDetected };
}

/**
 * The non-empty `servers` map (runtime tool-hash pins written by `rigscore mcp-pin`)
 * carried by a state object, or null when there is nothing to carry.
 */
function runtimePinsIn(state) {
  const servers = (state && state.servers && typeof state.servers === 'object') ? state.servers : null;
  return servers && Object.keys(servers).length > 0 ? servers : null;
}

/**
 * True when the on-disk pin already says exactly what a rewrite would say.
 * Values are hex digests and `servers` is carried over by reference, so the
 * only thing that can differ is the `mcpServers` name→hash map itself.
 */
function pinIsUpToDate(state, currentHashes) {
  const pinned = (state && state.version === STATE_VERSION && state.mcpServers && typeof state.mcpServers === 'object')
    ? state.mcpServers
    : null;
  if (!pinned) return false;
  const names = Object.keys(currentHashes);
  return Object.keys(pinned).length === names.length
    && names.every((name) => pinned[name] === currentHashes[name]);
}

/**
 * Hash-pinning / rug-pull detection (CVE-2025-54136 / "MCPoison" class).
 * Compares current repo-level MCP server config-shape hashes against the
 * on-disk state file. Diff rules:
 *   - hash changed on existing entry → WARN
 *   - new entries → silently record
 *   - removed entries → silently drop
 *   - missing state file → first scan, no warnings
 *   - corrupt state file → reset, recovering the runtime tool pins from HEAD (INFO) or
 *     disclosing that they are gone and only a human can re-pin them (WARNING)
 *
 * The state write ESTABLISHES or EXTENDS the pin — it never destroys it. Two
 * cases are therefore never written, and each is a real bug the unconditional
 * rewrite used to cause:
 *
 *   - DRIFT. Re-pinning the changed hash re-approves, on the spot, the rug-pull
 *     this function just reported: the WARNING fires once, the next scan is
 *     silent, and `--verify-state` goes green on a compromised repo. The pin is
 *     the detection substrate — the detector must not eat it. Acceptance stays
 *     an explicit human act (drop the entry, re-scan), which is also what the
 *     drift remediation now says.
 *   - NO CHANGE. An identical-content rewrite still reformats a hand-committed
 *     pin and bumps its mtime, so a read-only scan dirties every working tree
 *     and CI checkout it runs in.
 *
 * Still written: first scan (trust-on-first-use pin), corrupt-state reset, and
 * added/removed servers. Every rewrite carries the `state.servers` map (runtime
 * tool-hash pins written by `rigscore mcp-pin`) over — from the working tree, or
 * from the copy committed at HEAD when the working-tree copy is corrupt.
 *
 * `writeState: false` (CLI `--no-state-write`) suppresses the write outright —
 * and SAYS SO. A scan that has stopped pinning must not look like a scan that is
 * pinning, so the opt-out always emits `mcp-config/state-write-disabled`. Its
 * severity is keyed on the same predicate as the write itself: WARNING when the
 * flag actually suppressed a pin (drift detection is now off, or off for the
 * servers that would have been added), INFO when the pin was already current and
 * the write would have been a no-op regardless — a warning there would be crying
 * wolf about a run that lost nothing.
 */
export async function checkHashPinning(cwd, currentHashes, writeState) {
  const findings = [];
  if (Object.keys(currentHashes).length === 0) return findings;

  const { state, corrupt } = await loadState(cwd);

  // A corrupt state file is UNPARSEABLE, so `state` is null and the rewrite below is about
  // to drop the `servers` map with it. The two halves of the file are NOT symmetric: the
  // config-shape pins (`mcpServers`) are re-minted from `.mcp.json` for free, but the runtime
  // tool pins are not regenerable by any scan — rigscore refuses to execute an MCP server, so
  // only a human holding its `tools/list` output can recreate them, and losing them turns OFF
  // CVE-2025-54136 rug-pull detection (`rigscore mcp-verify <name>` then exits 3). The copy
  // committed at HEAD is the one place they may survive a merge-conflicted working tree, so
  // try it — and key the finding on the OUTCOME, exactly as `state-write-disabled` below does.
  let recoveredServers = null;
  if (corrupt) {
    const committed = await loadCommittedState(cwd); // null outside a git repo
    recoveredServers = runtimePinsIn(committed?.state);
    findings.push(recoveredServers
      ? {
        findingId: 'mcp-config/state-file-corrupted',
        severity: 'info',
        title: `Corrupted ${STATE_FILENAME} — reset, runtime tool pins recovered from git`,
        detail: `Could not parse the rigscore state file (a merge conflict in the pin leaves conflict markers behind). Rewriting with current MCP server hashes; the runtime tool pins were recovered from the copy committed at HEAD, so rug-pull detection stays armed.`,
        remediation: `No action needed — the file was regenerated and your runtime tool pins were recovered from HEAD. Commit the rewritten ${STATE_FILENAME}.`,
      }
      : {
        findingId: 'mcp-config/state-file-corrupted',
        severity: 'warning',
        title: `Corrupted ${STATE_FILENAME} — reset, runtime tool pins LOST`,
        detail: `Could not parse the rigscore state file, and no copy committed at HEAD could supply its runtime tool pins. The config-shape pins are re-minted by this scan, but runtime tool pins are NOT regenerable by a scan — rigscore never executes an MCP server. Any server that had one is now unpinned at runtime, so CVE-2025-54136 rug-pull detection is OFF for it and \`rigscore mcp-verify <name>\` exits 3. (If this repo never ran \`rigscore mcp-pin\`, nothing was lost — the corrupt file cannot be read to tell.)`,
        remediation: `Restore ${STATE_FILENAME} from version control if you can. Otherwise re-pin each server from its own tool list: \`npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin <name>\`. Then commit the file — no scan can regenerate these pins for you.`,
        learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-supply-chain',
      });
  }

  const previousHashes = (state && state.version === STATE_VERSION && state.mcpServers && typeof state.mcpServers === 'object')
    ? state.mcpServers
    : null;

  let drifted = false;
  if (previousHashes) {
    for (const [name, hash] of Object.entries(currentHashes)) {
      const prev = previousHashes[name];
      if (typeof prev === 'string' && prev !== hash) {
        drifted = true;
        findings.push({
          findingId: 'mcp-config/server-hash-drift',
          severity: 'warning',
          title: `MCP server "${name}" changed shape between scans (possible rug-pull)`,
          detail: `The configured command/args/env-key-set for "${name}" differs from the recorded hash in ${STATE_FILENAME}. This is how MCPoison-class attacks (CVE-2025-54136) pivot trusted MCP servers.`,
          remediation: `Review the diff in ${path.join(cwd, '.mcp.json')} against version control. rigscore keeps the ORIGINAL pin — scanning never re-approves a changed server, so this warning persists until you act on it. If the change is intentional, accept it explicitly: delete "${name}" from the mcpServers map in ${STATE_FILENAME}, then re-run rigscore to re-pin it.`,
          learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-supply-chain',
          context: { serverName: name, prevHash: prev, currentHash: hash },
        });
      }
    }
  }

  // The pin write and the opt-out disclosure share ONE predicate: a write is due
  // iff the pin is neither drifted nor already current. Deriving both from it is
  // what keeps the disclosure honest — it can never claim a loss the run did not
  // take, nor stay quiet about one it did.
  const writeDue = !drifted && !pinIsUpToDate(state, currentHashes);

  if (writeState === false) {
    const names = Object.keys(currentHashes).join(', ');
    findings.push(writeDue
      ? {
        findingId: 'mcp-config/state-write-disabled',
        severity: 'warning',
        title: `MCP config-shape pinning is DISABLED for this scan (--no-state-write)`,
        detail: `No pin was established or extended in ${STATE_FILENAME}, so rug-pull drift (CVE-2025-54136) on ${names} cannot be detected on the next scan, and \`rigscore --verify-state\` has nothing to verify. This scan checked less than a default scan does.`,
        remediation: `Drop --no-state-write and commit ${STATE_FILENAME} — it stores hashes only (never env values), so it is safe to commit and it is what makes drift detection work in CI. Keep the flag only if you accept losing rug-pull detection.`,
        learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-supply-chain',
        context: { serverNames: Object.keys(currentHashes) },
      }
      : {
        findingId: 'mcp-config/state-write-disabled',
        severity: 'info',
        title: 'MCP config-shape pinning suppressed (--no-state-write) — pin already current',
        detail: `Every repo-level MCP server is already pinned in ${STATE_FILENAME} (or a pinned server has drifted, which also blocks re-pinning), so this scan would not have written the file anyway. Drift detection is intact.`,
        context: { serverNames: Object.keys(currentHashes) },
      });
  }

  // Preserve the `servers` map (runtime tool-hash pins) — from the working tree normally,
  // from HEAD when the working-tree copy was corrupt.
  const preservedServers = runtimePinsIn(state) || recoveredServers || undefined;
  if (writeState !== false && writeDue) {
    const nextState = { version: STATE_VERSION, mcpServers: currentHashes };
    if (preservedServers) nextState.servers = preservedServers;
    await saveState(cwd, nextState);
  }

  return findings;
}

/**
 * Runtime tool-hash pin status. Default-on INFO per repo-level MCP
 * server, suppressible via `.rigscorerc.json` key
 * `mcpConfig.surfaceRuntimeHashStatus: false`. Surfaces whether the user
 * has pinned a snapshot of the server's `tools/list` JSON via
 * `rigscore mcp-pin`, which is what the CVE-2025-54136 drift detection
 * needs as a baseline.
 */
export async function checkRuntimeToolPinStatus(cwd, currentHashes, surfaceRuntime) {
  const findings = [];
  if (!surfaceRuntime || Object.keys(currentHashes).length === 0) return findings;

  const { state: pinState } = await loadState(cwd);
  const serversMap = (pinState && pinState.servers && typeof pinState.servers === 'object')
    ? pinState.servers
    : {};

  for (const name of Object.keys(currentHashes)) {
    const entry = serversMap[name] || {};
    const pinnedAt = typeof entry.runtimeToolPinnedAt === 'string' ? entry.runtimeToolPinnedAt : null;
    const hasRuntimeHash = typeof entry.runtimeToolHash === 'string';
    if (hasRuntimeHash && pinnedAt) {
      const date = pinnedAt.slice(0, 10); // ISO YYYY-MM-DD
      findings.push({
        findingId: 'mcp-config/runtime-tool-pin-recorded',
        severity: 'info',
        title: `MCP server "${name}": runtime tool pin recorded ${date}`,
        detail: `Runtime tool hash pinned (pinnedAt ${pinnedAt}). Verify before trusting tool descriptions with: rigscore mcp-verify ${name}.`,
        context: { serverName: name, pinnedAt },
      });
    } else {
      findings.push({
        findingId: 'mcp-config/runtime-tool-pin-missing',
        severity: 'info',
        title: `MCP server "${name}": runtime tool pin not recorded`,
        detail: 'Pin a snapshot of the server\'s tool descriptions to detect CVE-2025-54136-class drift between scans. rigscore does NOT execute the server — user must pipe tools/list JSON into stdin.',
        remediation: `Run: npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin ${name}`,
        context: { serverName: name },
      });
    }
  }
  return findings;
}

const ANTHROPIC_BASE_URL_ALLOWED_HOSTS = new Set([
  'api.anthropic.com',
  '127.0.0.1',
  'localhost',
  '::1',
]);

export function checkAnthropicBaseUrl(server, name, relPath) {
  const env = server.env || {};
  const envBaseUrl = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE || '';
  if (!envBaseUrl) return [];
  const host = extractHost(envBaseUrl);
  if (host && ANTHROPIC_BASE_URL_ALLOWED_HOSTS.has(host)) {
    return [];
  }
  return [{
    findingId: 'mcp-config/anthropic-base-url-redirect',
    severity: 'critical',
    title: `ANTHROPIC_BASE_URL redirect in MCP server "${name}" env`,
    detail: `MCP server "${name}" sets API base to ${envBaseUrl.slice(0, 60)} — this can exfiltrate API keys and intercept requests (CVE-2026-21852). Found in ${relPath}.`,
    remediation: 'Remove ANTHROPIC_BASE_URL/ANTHROPIC_API_BASE from MCP server env, or set it to https://api.anthropic.com.',
    learnMore: 'https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/',
  }];
}

/**
 * Broad-filesystem-access detection. Pulls path args from the server's args
 * list and flags any that match SENSITIVE_PATHS exactly (`/`, `/home`,
 * `/etc`, `/root`, `/var`, `/opt`, `/usr`). Returns `hasBroadFilesystemAccess`
 * so the outer loop can roll it into the check's `data` block.
 */
export function checkBroadFilesystemAccess(server, name, relPath) {
  const args = server.args || [];
  const extractedPaths = extractPathsFromArgs(args);
  const sensitivePaths = extractedPaths.filter((p) => SENSITIVE_PATHS.includes(p));
  if (sensitivePaths.length === 0) return { findings: [], hasBroadFilesystemAccess: false };
  return {
    findings: [{
      findingId: 'mcp-config/broad-filesystem-access',
      severity: 'critical',
      title: `MCP server "${name}" has broad filesystem access: ${sensitivePaths.join(', ')}`,
      detail: `Server can access sensitive path(s). Found in ${relPath}.`,
      remediation: 'Scope filesystem access to your project directory only.',
      learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-permissions',
    }],
    hasBroadFilesystemAccess: true,
  };
}

/** Relative-path-traversal detection (`../` inside any arg). */
export function checkPathTraversal(server, name, relPath) {
  const args = server.args || [];
  const hasTraversal = args.some((a) => typeof a === 'string' && a.includes('../'));
  if (!hasTraversal) return [];
  return [{
    findingId: 'mcp-config/relative-path-traversal',
    severity: 'warning',
    title: `MCP server "${name}" uses relative path traversal`,
    detail: `Arguments contain "../" which may escape project scope. Found in ${relPath}.`,
    remediation: 'Use absolute paths scoped to your project directory.',
  }];
}

/** Unsafe permission-flag detection — first-match wins. */
export function checkUnsafePermissionFlag(server, name, relPath) {
  const args = server.args || [];
  for (const arg of args) {
    const lowerArg = typeof arg === 'string' ? arg.toLowerCase() : '';
    if (UNSAFE_PERMISSION_FLAGS.some((flag) => lowerArg.startsWith(flag))) {
      return [{
        findingId: 'mcp-config/unsafe-permission-flag',
        severity: 'warning',
        title: `MCP server "${name}" uses unsafe permission flag: ${arg}`,
        detail: `Overly broad permissions detected in ${relPath}.`,
        remediation: 'Use granular permission flags instead of blanket allow-all.',
      }];
    }
  }
  return [];
}

/** Unpinned-version (unstable distribution tag) detection — first-match wins. */
export function checkUnpinnedVersion(server, name, relPath) {
  const args = server.args || [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const atIdx = arg.lastIndexOf('@');
    if (atIdx > 0) {
      const tag = arg.slice(atIdx + 1).toLowerCase();
      if (UNSTABLE_TAGS.has(tag)) {
        return [{
          findingId: 'mcp-config/unpinned-unstable-tag',
          severity: 'warning',
          title: `MCP server "${name}" uses unpinned version (@${tag})`,
          detail: 'Unstable distribution tags can introduce breaking changes or supply chain attacks.',
          remediation: 'Pin MCP server packages to specific versions.',
          learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-supply-chain',
        }];
      }
    }
  }
  return [];
}

/**
 * Unpinned-npx detection. command=='npx'/'npx.cmd' AND the package-position
 * arg has no stable version pin (e.g. `pkg@1.0.0`). Flag values like
 * `--token=@abc123` do NOT satisfy the pin check — only the package-position arg.
 */
export function checkNpxPin(server, name, relPath) {
  const args = server.args || [];
  if (server.command !== 'npx' && server.command !== 'npx.cmd') return [];
  if (args.length === 0) return [];
  const packageArg = findPackagePositionArg(args);
  const hasVersionPin = packageArg !== null && argHasStableVersionPin(packageArg);
  if (hasVersionPin) return [];
  return [{
    findingId: 'mcp-config/unpinned-npx-package',
    severity: 'warning',
    title: `MCP server "${name}" uses unpinned npx package`,
    detail: `npx without a version pin (e.g. @1.0.0) runs whatever version is latest. Found in ${relPath}.`,
    remediation: 'Pin the package version: npx package@1.0.0',
  }];
}

/** Inline-credentials detection — KEY_PATTERNS scan over `[command, ...args].join(' ')`. */
export function checkInlineCredentials(server, name, relPath) {
  const args = server.args || [];
  // Remote servers (Zed's `url` + `headers` shape, and the same shape elsewhere) carry
  // their token in a header rather than the command line — scan both surfaces.
  const headers = (server.headers && typeof server.headers === 'object') ? Object.values(server.headers) : [];
  const haystack = [server.command || '', ...args, ...headers]
    .filter((v) => typeof v === 'string')
    .join(' ');
  for (const pattern of KEY_PATTERNS) {
    if (pattern.test(haystack)) {
      return [{
        findingId: 'mcp-config/inline-credentials',
        severity: 'critical',
        title: `MCP server "${name}" has inline credentials in command or headers`,
        detail: `API keys or tokens are embedded directly in the MCP server definition in ${relPath}.`,
        remediation: 'Use environment variables instead of inline credentials.',
      }];
    }
  }
  return [];
}

export default {
  id: 'mcp-config',
  enforcementGrade: 'mechanical',
  name: 'MCP server configuration',
  category: 'supply-chain',

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];
    const safeHosts = config?.network?.safeHosts || DEFAULT_SAFE_HOSTS;

    // Locations to scan for MCP config — all known AI clients (src/clients.js)
    const configPaths = mcpConfigPaths(cwd, homedir);

    // Add config-specified paths
    if (config?.paths?.mcpConfig) {
      for (const p of config.paths.mcpConfig) {
        configPaths.push(p);
      }
    }

    // MCP registry (online, augments hand-curated typosquat list).
    // Fetched lazily once per check run; cached on disk with 24h TTL.
    // Injection points (context.registryCachePath, context.registryFetch) exist for tests.
    let registryResult = null;
    if (context.online) {
      try {
        registryResult = await fetchRegistry({
          cachePath: context.registryCachePath || getDefaultCachePath(homedir),
          fetchImpl: context.registryFetch,
          force: context.refreshMcpRegistry === true,
        });
      } catch (err) {
        registryResult = { servers: [], warning: `MCP registry client error: ${err.message}` };
      }
    }

    let foundAny = false;
    let hasRepoMcpJson = false;
    let hasNetworkTransport = false;
    let hasBroadFilesystemAccess = false;
    let driftDetected = false;
    let serverCount = 0;
    let clientCount = 0;

    // Collect all servers per config file for cross-client drift detection
    const clientServers = new Map(); // configPath → { name → server }

    // Hash every server in every COMMITTED repo-level config for rug-pull detection
    // (CVE-2025-54136) — `.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`,
    // `opencode.json`. Minted by the SAME function `--verify-state` verifies against
    // (state.js readRepoServers), so the pin and the gate cannot disagree about scope;
    // hashing only `.mcp.json` here left the other three unpinned and the gate vacuous.
    // Home-dir configs stay unpinned: per-user, and no pull request can touch them.
    const currentHashes = Object.fromEntries(
      Object.entries(await readRepoServers(cwd)).map(([name, { hash }]) => [name, hash]),
    );

    for (const configPath of configPaths) {
      const mcpConfig = await readJsonSafe(configPath);
      if (!mcpConfig) {
        // readJsonSafe returns null for BOTH "absent" and "present but malformed". Skipping
        // on that alone let a config that IS there — and whose servers therefore cannot be
        // scanned or pinned — be reported as "No MCP configuration found". Absent stays a
        // clean skip; present-but-unparseable is disclosed, mirroring
        // claude-settings/settings-unparseable.
        if (await fileExists(configPath)) {
          const relPath = path.relative(cwd, configPath) || configPath;
          findings.push({
            findingId: 'mcp-config/config-unparseable',
            severity: 'warning',
            title: `Unparseable MCP configuration in ${relPath}`,
            detail: `${relPath} exists but does not parse as JSON, so the MCP servers it declares cannot be inspected — and, for a committed repo-level config, cannot be hash-pinned either, which leaves rug-pull detection (CVE-2025-54136) off for them.`,
            remediation: 'Fix the JSON syntax — rigscore already tolerates comments and trailing commas, so this is genuinely broken (unresolved merge-conflict markers, an unterminated string, a truncated write). Repair the file or remove it; leaving it in place means its servers are never scanned or pinned.',
          });
          foundAny = true;
        }
        continue;
      }

      // Read raw text to detect wildcard env passthrough (e.g. ...process.env)
      const rawText = await readFileSafe(configPath);
      if (rawText && /process\.env\b/.test(rawText)) {
        const relPath = path.relative(cwd, configPath) || configPath;
        findings.push({
          findingId: 'mcp-config/env-wildcard-passthrough',
          severity: 'warning',
          title: `Wildcard env passthrough detected in ${relPath}`,
          detail: 'Config references process.env which may pass all environment variables to MCP servers.',
          remediation: 'Pass only the specific environment variables each server needs.',
        });
      }

      foundAny = true;
      // Track whether a repo-level .mcp.json was found (for CVE-2025-59536 compound detection)
      if (configPath === path.join(cwd, '.mcp.json')) {
        hasRepoMcpJson = true;
      }
      const servers = mcpServersIn(configPath, mcpConfig);
      const relPath = path.relative(cwd, configPath) || configPath;
      clientServers.set(relPath, servers);
      clientCount++;
      serverCount += Object.keys(servers).length;

      for (const [name, server] of Object.entries(servers)) {
        // Transport-type detection — see checkTransportType().
        const transportResult = checkTransportType(server, name, relPath, safeHosts);
        findings.push(...transportResult.findings);
        if (transportResult.hasNetworkTransport) hasNetworkTransport = true;

        // Broad-filesystem / path-traversal / unsafe-flag / sensitive-env /
        // ANTHROPIC_BASE_URL / unpinned-version / unpinned-npx /
        // inline-credentials — see helpers.
        const fsResult = checkBroadFilesystemAccess(server, name, relPath);
        findings.push(...fsResult.findings);
        if (fsResult.hasBroadFilesystemAccess) hasBroadFilesystemAccess = true;
        findings.push(...checkPathTraversal(server, name, relPath));
        findings.push(...checkUnsafePermissionFlag(server, name, relPath));
        findings.push(...checkSensitiveEnv(server, name, relPath));
        findings.push(...checkAnthropicBaseUrl(server, name, relPath));
        findings.push(...checkUnpinnedVersion(server, name, relPath));
        findings.push(...checkNpxPin(server, name, relPath));
        findings.push(...checkInlineCredentials(server, name, relPath));

        // Supply-chain checks (typosquat curated + registry) — see helpers.
        const args = server.args || [];
        const packageName = extractPackageName(args);
        const curated = checkTyposquatCurated(name, packageName);
        findings.push(...curated.findings);
        findings.push(...checkTyposquatRegistry(name, packageName, registryResult, curated.hadCuratedMatch));

        // Online npm registry check (--online flag).
        // Rename the inner result so it doesn't shadow the outer
        // `registryResult` (the MCP-registry fetch result captured above);
        // the shadow made the registry-fallback INFO finding below
        // mistakenly evaluate this loop's last-iteration value.
        if (packageName && context.online) {
          const npmFinding = await checkNpmRegistry(packageName);
          if (npmFinding) {
            findings.push(npmFinding);
          }
        }
      }
    }

    // Surface registry status as an INFO finding when --online is requested.
    // These are advisory — they do not flip the check to critical and do not
    // materially move the score (floor applies for INFO-only).
    if (registryResult && registryResult.warning) {
      findings.push({
        findingId: 'mcp-config/registry-fallback',
        severity: 'info',
        title: registryResult.warning,
        detail: registryResult.stale
          ? 'Using cached MCP registry data from a previous successful fetch.'
          : 'Falling back to the hand-curated MCP server list for typosquat detection.',
      });
    }

    if (!foundAny) {
      findings.push({
        findingId: 'mcp-config/no-config-found',
        severity: 'info',
        title: 'No MCP configuration found',
        detail: 'No MCP server configuration files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings, data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false, serverCount: 0, clientCount: 0, driftDetected: false } };
    }

    // .claude/settings.json scan (auto-approve + dangerous hooks) and the
    // compound CVE-2025-59536 detection — see helpers. The settings parse
    // is reused so the CVE check doesn't re-read the files.
    const settingsResult = await checkClaudeSettings(cwd, homedir);
    findings.push(...settingsResult.findings);
    findings.push(...checkCve2025_59536(hasRepoMcpJson, settingsResult.autoApproveEnabled));

    // Cross-client drift, hash-pinning, and runtime tool-hash pin status —
    // see helpers. Each preserves the prior contract: drift flag rolled
    // up into `data`; hash-pinning only ever establishes or extends the pin
    // (it never overwrites a drifted or already-current one) and is gated on
    // `context.writeState !== false` (CLI `--no-state-write`), which suppresses
    // the write and discloses the resulting loss of coverage as a finding;
    // runtime pin surface controlled by config.mcpConfig.surfaceRuntimeHashStatus.
    const driftResult = checkCrossClientDrift(clientServers);
    findings.push(...driftResult.findings);
    if (driftResult.driftDetected) driftDetected = true;

    findings.push(...(await checkHashPinning(cwd, currentHashes, context.writeState)));

    const surfaceRuntime = config?.mcpConfig?.surfaceRuntimeHashStatus !== false;
    findings.push(...(await checkRuntimeToolPinStatus(cwd, currentHashes, surfaceRuntime)));

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'MCP server configuration looks secure',
      });
    }

    // Collect all discovered server names across all clients
    const serverNames = [];
    for (const servers of clientServers.values()) {
      for (const name of Object.keys(servers)) {
        if (!serverNames.includes(name)) {
          serverNames.push(name);
        }
      }
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: { hasNetworkTransport, hasBroadFilesystemAccess, serverCount, clientCount, driftDetected, serverNames },
    };
  },
};
