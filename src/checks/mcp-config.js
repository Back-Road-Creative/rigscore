import path from 'node:path';
import https from 'node:https';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
import { readJsonSafe, readFileSafe } from '../utils.js';
import { KNOWN_MCP_SERVERS, findTyposquatMatch } from '../known-mcp-servers.js';

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

function checkNpmRegistry(packageName) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          if (res.statusCode === 404) {
            resolve({
              severity: 'critical',
              title: `MCP package "${packageName}" not found on npm`,
              detail: 'This package does not exist on the npm registry. It may be a private package or a typo.',
              remediation: 'Verify the package name and source.',
            });
            return;
          }
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          const pkg = JSON.parse(data);
          const created = new Date(pkg.time?.created);
          const now = new Date();
          const daysSinceCreated = (now - created) / (1000 * 60 * 60 * 24);

          if (daysSinceCreated < 30) {
            resolve({
              severity: 'warning',
              title: `MCP package "${packageName}" is very new (${Math.round(daysSinceCreated)} days old)`,
              detail: 'New packages have less community vetting and could be malicious.',
              remediation: 'Review the package source code and maintainer reputation before using.',
            });
            return;
          }

          resolve(null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

export default {
  id: 'mcp-config',
  name: 'MCP server configuration',
  category: 'supply-chain',

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];
    const safeHosts = config?.network?.safeHosts || DEFAULT_SAFE_HOSTS;

    // Locations to scan for MCP config — all known AI clients
    const configPaths = [
      // Claude
      path.join(cwd, '.mcp.json'),
      path.join(cwd, '.vscode', 'mcp.json'),
      path.join(homedir, '.claude', 'claude_desktop_config.json'),
      // Cursor
      path.join(homedir, '.cursor', 'mcp.json'),
      // Cline
      path.join(homedir, '.cline', 'mcp_settings.json'),
      // Continue
      path.join(homedir, '.continue', 'config.json'),
      // Windsurf
      path.join(homedir, '.windsurf', 'mcp.json'),
      // Zed
      path.join(homedir, '.config', 'zed', 'settings.json'),
      // Amp
      path.join(homedir, '.amp', 'mcp.json'),
    ];

    // Add config-specified paths
    if (config?.paths?.mcpConfig) {
      for (const p of config.paths.mcpConfig) {
        configPaths.push(p);
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

    for (const configPath of configPaths) {
      const mcpConfig = await readJsonSafe(configPath);
      if (!mcpConfig) continue;

      // Read raw text to detect wildcard env passthrough (e.g. ...process.env)
      const rawText = await readFileSafe(configPath);
      if (rawText && /process\.env\b/.test(rawText)) {
        const relPath = path.relative(cwd, configPath) || configPath;
        findings.push({
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
      const servers = mcpConfig.mcpServers || {};
      const relPath = path.relative(cwd, configPath) || configPath;
      clientServers.set(relPath, servers);
      clientCount++;
      serverCount += Object.keys(servers).length;

      for (const [name, server] of Object.entries(servers)) {
        // Check transport type
        const transport = server.transport || 'stdio';
        if (transport === 'sse' || transport === 'http' || server.url) {
          const targetUrl = server.url || '';
          const host = extractHost(targetUrl);
          const isLocal = host && safeHosts.includes(host);

          if (isLocal) {
            findings.push({
              severity: 'info',
              title: `MCP server "${name}" is a localhost server`,
              detail: `Server uses ${transport || 'network'} transport targeting ${host} in ${relPath}.`,
            });
          } else {
            hasNetworkTransport = true;
            findings.push({
              severity: 'warning',
              title: `MCP server "${name}" uses network transport`,
              detail: `Server uses ${transport || 'network'} transport in ${relPath}. Network-based MCP servers have a larger attack surface than stdio.`,
              remediation: 'Prefer stdio transport for local MCP servers. If network transport is required, ensure authentication and TLS.',
              learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-permissions',
            });
          }
        }

        // Check for sensitive filesystem access in args
        const args = server.args || [];
        const extractedPaths = extractPathsFromArgs(args);
        const sensitivePaths = extractedPaths.filter(p => SENSITIVE_PATHS.includes(p));

        if (sensitivePaths.length > 0) {
          hasBroadFilesystemAccess = true;
          findings.push({
            severity: 'critical',
            title: `MCP server "${name}" has broad filesystem access: ${sensitivePaths.join(', ')}`,
            detail: `Server can access sensitive path(s). Found in ${relPath}.`,
            remediation: 'Scope filesystem access to your project directory only.',
            learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-permissions',
          });
        }

        // Check for relative path traversal in args
        const hasTraversal = args.some(a => typeof a === 'string' && a.includes('../'));
        if (hasTraversal) {
          findings.push({
            severity: 'warning',
            title: `MCP server "${name}" uses relative path traversal`,
            detail: `Arguments contain "../" which may escape project scope. Found in ${relPath}.`,
            remediation: 'Use absolute paths scoped to your project directory.',
          });
        }

        // Check for overly broad permission flags
        for (const arg of args) {
          const lowerArg = typeof arg === 'string' ? arg.toLowerCase() : '';
          if (UNSAFE_PERMISSION_FLAGS.some(flag => lowerArg.startsWith(flag))) {
            findings.push({
              severity: 'warning',
              title: `MCP server "${name}" uses unsafe permission flag: ${arg}`,
              detail: `Overly broad permissions detected in ${relPath}.`,
              remediation: 'Use granular permission flags instead of blanket allow-all.',
            });
            break;
          }
        }

        // Check for sensitive env passthrough
        const env = server.env || {};
        const envKeys = Object.keys(env);
        const sensitiveKeys = envKeys.filter((k) => SENSITIVE_ENV_KEYS.includes(k));
        if (sensitiveKeys.length >= 3) {
          findings.push({
            severity: 'critical',
            title: `MCP server "${name}" receives ${sensitiveKeys.length} sensitive env vars`,
            detail: `Sensitive environment variables (${sensitiveKeys.join(', ')}) are passed to this server.`,
            remediation: 'Only pass environment variables that the server actually needs.',
          });
        } else if (sensitiveKeys.length > 0) {
          findings.push({
            severity: 'warning',
            title: `MCP server "${name}" receives sensitive env var(s): ${sensitiveKeys.join(', ')}`,
            detail: `Sensitive keys passed in ${relPath}.`,
            remediation: 'Verify this server needs these credentials.',
          });
        }

        // CVE-2026-21852: ANTHROPIC_BASE_URL redirect in MCP server env
        const envBaseUrl = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE || '';
        if (envBaseUrl && !envBaseUrl.includes('api.anthropic.com') && !envBaseUrl.includes('127.0.0.1') && !envBaseUrl.includes('localhost')) {
          findings.push({
            severity: 'critical',
            title: `ANTHROPIC_BASE_URL redirect in MCP server "${name}" env`,
            detail: `MCP server "${name}" sets API base to ${envBaseUrl.slice(0, 60)} — this can exfiltrate API keys and intercept requests (CVE-2026-21852). Found in ${relPath}.`,
            remediation: 'Remove ANTHROPIC_BASE_URL/ANTHROPIC_API_BASE from MCP server env, or set it to https://api.anthropic.com.',
          });
        }

        // Check for unpinned versions (unstable distribution tags)
        for (const arg of args) {
          if (typeof arg !== 'string') continue;
          const atIdx = arg.lastIndexOf('@');
          if (atIdx > 0) {
            const tag = arg.slice(atIdx + 1).toLowerCase();
            if (UNSTABLE_TAGS.has(tag)) {
              findings.push({
                severity: 'warning',
                title: `MCP server "${name}" uses unpinned version (@${tag})`,
                detail: 'Unstable distribution tags can introduce breaking changes or supply chain attacks.',
                remediation: 'Pin MCP server packages to specific versions.',
                learnMore: 'https://headlessmode.com/tools/rigscore/#mcp-supply-chain',
              });
              break;
            }
          }
        }

        // Unpinned npx: command is 'npx' and no arg has a version pin
        // A version pin looks like pkg@1.0.0 or @scope/pkg@1.0.0
        // Scoped packages (@scope/pkg) without @version are NOT pinned
        // Unstable tags (@latest, @next, @dev, etc.) are NOT pins
        const hasVersionPin = args.some(a => {
          if (typeof a !== 'string') return false;
          let versionPart = null;
          if (a.startsWith('@')) {
            // @scope/pkg@version — extract version after the scope
            const slashIdx = a.indexOf('/');
            if (slashIdx === -1) return false;
            const atIdx = a.indexOf('@', slashIdx + 1);
            if (atIdx === -1) return false;
            versionPart = a.slice(atIdx + 1);
          } else {
            // pkg@version — extract version after @
            const atIdx = a.indexOf('@');
            if (atIdx === -1) return false;
            versionPart = a.slice(atIdx + 1);
          }
          // Reject unstable distribution tags as version pins
          return versionPart && !UNSTABLE_TAGS.has(versionPart.toLowerCase());
        });
        if ((server.command === 'npx' || server.command === 'npx.cmd') &&
            args.length > 0 && !hasVersionPin) {
          findings.push({
            severity: 'warning',
            title: `MCP server "${name}" uses unpinned npx package`,
            detail: `npx without a version pin (e.g. @1.0.0) runs whatever version is latest. Found in ${relPath}.`,
            remediation: 'Pin the package version: npx package@1.0.0',
          });
        }

        // Check for inline credentials in args or command
        const fullCommand = [server.command || '', ...args].join(' ');
        for (const pattern of KEY_PATTERNS) {
          if (pattern.test(fullCommand)) {
            findings.push({
              severity: 'critical',
              title: `MCP server "${name}" has inline credentials in command`,
              detail: 'API keys or tokens are embedded directly in the MCP server command.',
              remediation: 'Use environment variables instead of inline credentials.',
            });
            break;
          }
        }

        // Extract package name from args for supply chain checks
        let packageName = null;
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith('-')) continue;
          // Package names: @scope/name or name (may have @version suffix)
          if (/^(@[a-z0-9-]+\/)?[a-z0-9-]+(@.+)?$/.test(arg)) {
            // Strip version suffix (@1.0.0, @latest) while preserving scoped @
            if (arg.startsWith('@')) {
              const slashIdx = arg.indexOf('/');
              if (slashIdx !== -1) {
                const afterSlash = arg.slice(slashIdx + 1);
                const atIdx = afterSlash.indexOf('@');
                packageName = atIdx !== -1 ? arg.slice(0, slashIdx + 1 + atIdx) : arg;
              } else {
                packageName = arg;
              }
            } else {
              const atIdx = arg.indexOf('@');
              packageName = atIdx !== -1 ? arg.slice(0, atIdx) : arg;
            }
            break;
          }
        }

        // Typosquatting detection (offline)
        if (packageName && !KNOWN_MCP_SERVERS.includes(packageName)) {
          const match = findTyposquatMatch(packageName);
          if (match) {
            findings.push({
              severity: 'warning',
              title: `MCP server "${name}": package "${packageName}" is similar to known "${match}"`,
              detail: `Levenshtein distance 1-2 from an official MCP server package. This could be a typosquat.`,
              remediation: `Verify the package name is correct. Did you mean "${match}"?`,
            });
          }
        }

        // Online npm registry check (--online flag)
        if (packageName && context.online) {
          const registryResult = await checkNpmRegistry(packageName);
          if (registryResult) {
            findings.push(registryResult);
          }
        }
      }
    }

    if (!foundAny) {
      findings.push({
        severity: 'info',
        title: 'No MCP configuration found',
        detail: 'No MCP server configuration files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings, data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false, serverCount: 0, clientCount: 0, driftDetected: false } };
    }

    // Scan .claude/settings.json for dangerous patterns
    const settingsPaths = [
      path.join(cwd, '.claude', 'settings.json'),
      path.join(homedir, '.claude', 'settings.json'),
    ];
    for (const settingsPath of settingsPaths) {
      const settings = await readJsonSafe(settingsPath);
      if (!settings) continue;

      const relPath = path.relative(cwd, settingsPath) || settingsPath;

      // Check enableAllProjectMcpServers
      if (settings.enableAllProjectMcpServers === true) {
        findings.push({
          severity: 'critical',
          title: `MCP auto-approve enabled in ${relPath}`,
          detail: 'enableAllProjectMcpServers is true — all project MCP servers are auto-approved without user consent.',
          remediation: 'Remove enableAllProjectMcpServers or set it to false.',
        });
      }

      // Check hooks for dangerous commands
      if (settings.hooks && typeof settings.hooks === 'object') {
        for (const [hookName, hookList] of Object.entries(settings.hooks)) {
          const hooks = Array.isArray(hookList) ? hookList : [];
          for (const hook of hooks) {
            const cmd = hook?.command || '';
            for (const pattern of DANGEROUS_HOOK_PATTERNS) {
              if (pattern.test(cmd)) {
                findings.push({
                  severity: 'critical',
                  title: `Dangerous hook command in ${relPath} (${hookName})`,
                  detail: `Hook "${hookName}" runs a potentially dangerous command: ${cmd.slice(0, 80)}`,
                  remediation: 'Review and remove dangerous hook commands. Hooks execute on every collaborator who clones this project.',
                });
                break;
              }
            }
          }
        }
      }
    }

    // CVE-2025-59536: compound detection — repo .mcp.json + auto-approve = RCE on clone
    if (hasRepoMcpJson) {
      for (const settingsPath of settingsPaths) {
        const settings = await readJsonSafe(settingsPath);
        if (settings?.enableAllProjectMcpServers === true) {
          findings.push({
            severity: 'critical',
            title: 'CVE-2025-59536: repo MCP servers auto-approved on clone',
            detail: 'This project has .mcp.json with MCP servers AND enableAllProjectMcpServers is true in settings. Anyone cloning this repo will auto-approve all MCP servers without consent — a compound settings bypass vulnerability.',
            remediation: 'Set enableAllProjectMcpServers to false. Review .mcp.json servers individually before approving.',
            learnMore: 'https://headlessmode.com/tools/rigscore/#cve-2025-59536',
          });
          break;
        }
      }
    }

    // Cross-client drift detection
    if (clientServers.size >= 2) {
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
          // Check for divergent args/env/transport
          const signatures = configs.map(c => JSON.stringify({
            args: c.server.args || [],
            env: Object.keys(c.server.env || {}).sort(),
            transport: c.server.transport || 'stdio',
          }));
          const unique = new Set(signatures);
          if (unique.size > 1) {
            driftDetected = true;
            findings.push({
              severity: 'warning',
              title: `Cross-client drift: "${serverName}" configured differently across clients`,
              detail: `Server "${serverName}" has divergent configurations in: ${configs.map(c => c.clientPath).join(', ')}.`,
              remediation: 'Align MCP server configurations across all AI clients.',
            });
          }
        } else if (configs.length === 1) {
          findings.push({
            severity: 'info',
            title: `MCP server "${serverName}" only configured in ${configs[0].clientPath}`,
            detail: 'This server is not configured in all detected AI clients.',
          });
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'MCP server configuration looks secure',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: { hasNetworkTransport, hasBroadFilesystemAccess, serverCount, clientCount, driftDetected },
    };
  },
};
