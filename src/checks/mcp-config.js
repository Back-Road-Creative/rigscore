import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readJsonSafe } from '../utils.js';

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

function extractHost(urlOrTransport) {
  try {
    const url = new URL(urlOrTransport);
    return url.hostname;
  } catch {
    return null;
  }
}

export default {
  id: 'mcp-config',
  name: 'MCP server configuration',
  category: 'supply-chain',
  weight: 15,

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

    for (const configPath of configPaths) {
      const mcpConfig = await readJsonSafe(configPath);
      if (!mcpConfig) continue;

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
            findings.push({
              severity: 'warning',
              title: `MCP server "${name}" uses network transport`,
              detail: `Server uses ${transport || 'network'} transport in ${relPath}. Network-based MCP servers have a larger attack surface than stdio.`,
              remediation: 'Prefer stdio transport for local MCP servers. If network transport is required, ensure authentication and TLS.',
            });
          }
        }

        // Check for root filesystem access in args
        const args = server.args || [];
        const argsStr = args.join(' ');
        // Match standalone "/" as an arg (root filesystem access)
        if (args.includes('/') || argsStr.includes(' / ') || argsStr.endsWith(' /')) {
          findings.push({
            severity: 'critical',
            title: `MCP server "${name}" has root filesystem access`,
            detail: `Server can read/write the entire filesystem. Found in ${relPath}.`,
            remediation: 'Scope filesystem access to your project directory only.',
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
        const keyPatterns = [/sk-ant-/, /AKIA/, /ghp_/, /xoxb-/];
        for (const pattern of keyPatterns) {
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
      }
    }

    if (!foundAny) {
      findings.push({
        severity: 'info',
        title: 'No MCP configuration found',
        detail: 'No MCP server configuration files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
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
    };
  },
};
