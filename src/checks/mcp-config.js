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
  weight: 12,

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
    ];

    // Add config-specified paths
    if (config?.paths?.mcpConfig) {
      for (const p of config.paths.mcpConfig) {
        configPaths.push(p);
      }
    }

    let foundAny = false;
    let hasNetworkTransport = false;
    let hasBroadFilesystemAccess = false;

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
      const servers = mcpConfig.mcpServers || {};
      const relPath = path.relative(cwd, configPath) || configPath;

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

        // Check for unpinned versions
        for (const arg of args) {
          if (arg.includes('@latest')) {
            findings.push({
              severity: 'warning',
              title: `MCP server "${name}" uses unpinned version (@latest)`,
              detail: 'Unpinned versions can introduce breaking changes or supply chain attacks.',
              remediation: 'Pin MCP server packages to specific versions.',
            });
            break;
          }
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
      return { score: NOT_APPLICABLE_SCORE, findings, data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false } };
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
      data: { hasNetworkTransport, hasBroadFilesystemAccess },
    };
  },
};
