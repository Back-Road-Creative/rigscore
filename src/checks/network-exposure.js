import path from 'node:path';
import YAML from 'yaml';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, AI_SERVICE_PORTS, MCP_SSE_PORT_RANGE } from '../constants.js';
import { readFileSafe, readJsonSafe, execSafe } from '../utils.js';

const DEFAULT_SAFE_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// MCP client config paths (subset — full list used only as fallback)
const MCP_CONFIG_PATHS = [
  ['.mcp.json', 'cwd'],
  ['.vscode/mcp.json', 'cwd'],
  ['.claude/claude_desktop_config.json', 'home'],
  ['.cursor/mcp.json', 'home'],
  ['.cline/mcp_settings.json', 'home'],
  ['.continue/config.json', 'home'],
  ['.windsurf/mcp.json', 'home'],
  ['.amp/mcp.json', 'home'],
];

const COMPOSE_PATTERNS = [
  'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
];

/**
 * Check if a hostname is considered safe (loopback).
 */
function isSafeHost(host, safeHosts) {
  return safeHosts.includes(host);
}

/**
 * Parse port from a URL string. Returns null on failure.
 */
function parseUrlHost(urlStr) {
  try {
    const url = new URL(urlStr);
    return { hostname: url.hostname, port: parseInt(url.port, 10) || null };
  } catch {
    return null;
  }
}

/**
 * Check MCP config URLs for non-loopback SSE/streamable-http hosts.
 * Prefers priorResults from mcp-config check; falls back to direct config read.
 */
async function checkMcpConfigUrls(context) {
  const { cwd, homedir, config, priorResults } = context;
  const safeHosts = config?.network?.safeHosts || DEFAULT_SAFE_HOSTS;
  const findings = [];
  const mcpServers = [];

  // Try to use priorResults from mcp-config check
  const mcpResult = priorResults?.find(r => r.id === 'mcp-config');

  if (mcpResult && mcpResult.findings) {
    // Re-examine the raw configs to find SSE URLs with non-loopback hosts
    // mcp-config flags network transport as a general risk;
    // we specifically flag the *host* being non-loopback
    // Fall through to direct config read since priorResults don't expose raw URLs
  }

  // Read MCP configs directly to extract SSE/HTTP URLs
  const configPaths = MCP_CONFIG_PATHS.map(([rel, base]) =>
    path.join(base === 'cwd' ? cwd : homedir, rel),
  );

  if (config?.paths?.mcpConfig) {
    configPaths.push(...config.paths.mcpConfig);
  }

  for (const configPath of configPaths) {
    const mcpConfig = await readJsonSafe(configPath);
    if (!mcpConfig) continue;

    const servers = mcpConfig.mcpServers || {};
    const relPath = path.relative(cwd, configPath) || configPath;

    for (const [name, server] of Object.entries(servers)) {
      const transport = server.transport || 'stdio';
      const url = server.url || '';

      if (transport === 'stdio' && !url) continue;

      const parsed = parseUrlHost(url);
      if (!parsed) {
        if (url) {
          findings.push({
            findingId: 'network-exposure/mcp-url-malformed',
            severity: 'info',
            title: `MCP server "${name}": malformed URL skipped`,
            detail: `Could not parse URL "${url}" in ${relPath}.`,
            context: { serverName: name, url, file: relPath },
          });
        }
        continue;
      }

      mcpServers.push({ name, host: parsed.hostname, port: parsed.port, configPath: relPath });

      if (!isSafeHost(parsed.hostname, safeHosts)) {
        findings.push({
          findingId: 'network-exposure/mcp-non-loopback-host',
          severity: 'critical',
          title: `MCP server "${name}" SSE endpoint on non-loopback host`,
          detail: `Server "${name}" in ${relPath} targets ${parsed.hostname}:${parsed.port || '(default)'}. Non-loopback MCP endpoints are reachable from the network.`,
          remediation: 'Bind MCP SSE servers to 127.0.0.1 instead of 0.0.0.0 or a public IP.',
          context: { serverName: name, host: parsed.hostname, port: parsed.port, file: relPath },
        });
      }
    }
  }

  return { findings, data: mcpServers };
}

/**
 * Check Docker compose port bindings for AI service ports without explicit loopback bind.
 * Prefers priorResults from docker-security; falls back to lightweight compose parse.
 */
async function checkDockerPortBindings(context) {
  const { cwd, config } = context;
  const safeHosts = config?.network?.safeHosts || DEFAULT_SAFE_HOSTS;
  const findings = [];
  const dockerPorts = [];

  // Find compose files
  const composeCandidates = COMPOSE_PATTERNS.map(p => path.join(cwd, p));
  if (config?.paths?.dockerCompose) {
    composeCandidates.push(...config.paths.dockerCompose);
  }

  for (const candidate of composeCandidates) {
    const content = await readFileSafe(candidate);
    if (!content) continue;

    let compose;
    try {
      compose = YAML.parse(content);
    } catch {
      continue;
    }

    const services = compose?.services || {};
    const sourceLabel = path.basename(candidate);

    for (const [name, service] of Object.entries(services)) {
      if (!service || typeof service !== 'object') continue;
      const ports = service.ports || [];

      for (const portMapping of ports) {
        const portStr = typeof portMapping === 'string' ? portMapping : formatPortObject(portMapping);
        if (!portStr) continue;

        const parsed = parsePortMapping(portStr);
        if (!parsed) continue;

        // Only flag AI service ports
        if (!AI_SERVICE_PORTS.has(parsed.hostPort)) continue;

        const serviceName = AI_SERVICE_PORTS.get(parsed.hostPort);
        dockerPorts.push({ container: name, hostPort: parsed.hostPort, bindAddr: parsed.bindAddr, service: serviceName, source: sourceLabel });

        if (parsed.bindAddr && isSafeHost(parsed.bindAddr, safeHosts)) {
          // Explicitly bound to loopback — safe
          continue;
        }

        findings.push({
          findingId: 'network-exposure/docker-port-no-loopback-bind',
          severity: 'warning',
          title: `Docker port ${parsed.hostPort} (${serviceName}) exposed without loopback bind`,
          detail: `Container "${name}" in ${sourceLabel} maps port ${parsed.hostPort} without explicit 127.0.0.1 bind. It will listen on all interfaces.`,
          remediation: `Change "${portStr}" to "127.0.0.1:${parsed.hostPort}:${parsed.containerPort}" in ${sourceLabel}.`,
          context: { container: name, hostPort: parsed.hostPort, service: serviceName, file: sourceLabel },
        });
      }
    }
  }

  return { findings, data: dockerPorts };
}

/**
 * Format a compose port object (long syntax) to string.
 */
function formatPortObject(portObj) {
  if (!portObj || typeof portObj !== 'object') return null;
  const host = portObj.host_ip ? `${portObj.host_ip}:` : '';
  return `${host}${portObj.published || ''}:${portObj.target || ''}`;
}

/**
 * Parse a Docker compose port mapping string.
 * Formats: "hostPort:containerPort", "bindAddr:hostPort:containerPort"
 */
function parsePortMapping(portStr) {
  const parts = portStr.split(':');
  if (parts.length === 2) {
    return { bindAddr: null, hostPort: parseInt(parts[0], 10), containerPort: parseInt(parts[1], 10) };
  }
  if (parts.length === 3) {
    return { bindAddr: parts[0], hostPort: parseInt(parts[1], 10), containerPort: parseInt(parts[2], 10) };
  }
  return null;
}

/**
 * Check for Ollama configuration that binds to all interfaces.
 */
async function checkOllamaConfig(context) {
  const { homedir } = context;
  const findings = [];
  const ollamaConfig = [];

  // Check systemd override
  const systemdPaths = [
    '/etc/systemd/system/ollama.service.d/override.conf',
    '/etc/systemd/system/ollama.service.d/environment.conf',
  ];

  for (const p of systemdPaths) {
    const content = await readFileSafe(p);
    if (!content) continue;
    ollamaConfig.push({ source: p, content });

    if (/OLLAMA_HOST\s*=\s*0\.0\.0\.0/i.test(content)) {
      findings.push({
        findingId: 'network-exposure/ollama-systemd-all-interfaces',
        severity: 'warning',
        title: 'Ollama systemd override binds to all interfaces',
        detail: `OLLAMA_HOST=0.0.0.0 found in ${p}. Ollama will accept connections from any network interface.`,
        remediation: 'Change OLLAMA_HOST to 127.0.0.1 or remove the override to use the default (localhost).',
        context: { source: p },
      });
    }
  }

  // Check ~/.ollama/.env or ~/.ollama/config
  const ollamaEnvPaths = [
    path.join(homedir, '.ollama', '.env'),
    path.join(homedir, '.ollama', 'environment'),
  ];

  for (const p of ollamaEnvPaths) {
    const content = await readFileSafe(p);
    if (!content) continue;
    ollamaConfig.push({ source: p, content });

    if (/OLLAMA_HOST\s*=\s*0\.0\.0\.0/i.test(content)) {
      findings.push({
        findingId: 'network-exposure/ollama-config-all-interfaces',
        severity: 'warning',
        title: 'Ollama config binds to all interfaces',
        detail: `OLLAMA_HOST=0.0.0.0 found in ${p}. Ollama will accept connections from any network interface.`,
        remediation: 'Change OLLAMA_HOST to 127.0.0.1 or remove the setting to use the default.',
        context: { source: p },
      });
    }
  }

  return { findings, data: ollamaConfig };
}

/**
 * Check live TCP listeners for AI service ports on non-loopback addresses.
 * Tries ss (Linux) then lsof (macOS). Degrades gracefully if neither available.
 */
async function checkLiveListeners(context) {
  const { config } = context;
  const safeHosts = config?.network?.safeHosts || DEFAULT_SAFE_HOSTS;
  const findings = [];
  const liveServices = [];

  // Try ss first (Linux)
  let output = await execSafe('ss', ['-tlnp']);

  if (output) {
    const lines = output.split('\n').slice(1); // skip header
    for (const line of lines) {
      const match = line.match(/(\S+):(\d+)\s/);
      if (!match) continue;

      const addr = match[1];
      const port = parseInt(match[2], 10);

      if (!AI_SERVICE_PORTS.has(port) && !isInMcpRange(port)) continue;

      const serviceName = AI_SERVICE_PORTS.get(port) || `MCP SSE (port ${port})`;
      const normalizedAddr = normalizeAddress(addr);
      liveServices.push({ addr: normalizedAddr, port, service: serviceName, source: 'ss' });

      if (!isSafeAddress(normalizedAddr, safeHosts)) {
        findings.push({
          findingId: 'network-exposure/live-listener-non-loopback',
          severity: 'warning',
          title: `${serviceName} listening on ${normalizedAddr}:${port}`,
          detail: `Live listener detected on non-loopback address. This service is reachable from the network.`,
          remediation: `Configure ${serviceName} to bind to 127.0.0.1 instead of ${normalizedAddr}.`,
          context: { service: serviceName, addr: normalizedAddr, port, source: 'ss' },
        });
      }
    }
    return { findings, data: liveServices };
  }

  // Try lsof (macOS)
  output = await execSafe('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P']);

  if (output) {
    const lines = output.split('\n').slice(1); // skip header
    for (const line of lines) {
      // Match "TCP *:1234 (LISTEN)" or "TCP 127.0.0.1:1234 (LISTEN)"
      const match = line.match(/TCP\s+(\S+):(\d+)\s+\(LISTEN\)/);
      if (!match) continue;

      const addr = match[1];
      const port = parseInt(match[2], 10);

      if (!AI_SERVICE_PORTS.has(port) && !isInMcpRange(port)) continue;

      const serviceName = AI_SERVICE_PORTS.get(port) || `MCP SSE (port ${port})`;
      const normalizedAddr = normalizeAddress(addr);
      liveServices.push({ addr: normalizedAddr, port, service: serviceName, source: 'lsof' });

      if (!isSafeAddress(normalizedAddr, safeHosts)) {
        findings.push({
          findingId: 'network-exposure/live-listener-non-loopback',
          severity: 'warning',
          title: `${serviceName} listening on ${normalizedAddr}:${port}`,
          detail: `Live listener detected on non-loopback address. This service is reachable from the network.`,
          remediation: `Configure ${serviceName} to bind to 127.0.0.1 instead of ${normalizedAddr}.`,
          context: { service: serviceName, addr: normalizedAddr, port, source: 'lsof' },
        });
      }
    }
    return { findings, data: liveServices };
  }

  // Neither tool available — graceful degradation
  return { findings: [], data: [] };
}

/**
 * Check if a port falls within the MCP SSE heuristic range.
 */
function isInMcpRange(port) {
  return port >= MCP_SSE_PORT_RANGE[0] && port <= MCP_SSE_PORT_RANGE[1];
}

/**
 * Normalize address representations.
 */
function normalizeAddress(addr) {
  if (addr === '*' || addr === '[::]') return '0.0.0.0';
  return addr;
}

/**
 * Check if a normalized address is safe (loopback).
 */
function isSafeAddress(addr, safeHosts) {
  if (addr === '0.0.0.0') return false;
  return safeHosts.includes(addr);
}

export default {
  id: 'network-exposure',
  enforcementGrade: 'mechanical',
  name: 'Network exposure',
  category: 'isolation',
  pass: 2,

  async run(context) {
    const [mcpResult, dockerResult, ollamaResult, liveResult] = await Promise.all([
      checkMcpConfigUrls(context),
      checkDockerPortBindings(context),
      checkOllamaConfig(context),
      checkLiveListeners(context),
    ]);

    const allFindings = [
      ...mcpResult.findings,
      ...dockerResult.findings,
      ...ollamaResult.findings,
      ...liveResult.findings,
    ];

    // No findings at all — not applicable
    if (allFindings.length === 0) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'info', title: 'No AI service network exposure detected' }],
        data: {
          mcpServers: mcpResult.data,
          dockerPorts: dockerResult.data,
          ollamaConfig: ollamaResult.data,
          liveServices: liveResult.data,
        },
      };
    }

    return {
      score: calculateCheckScore(allFindings),
      findings: allFindings,
      data: {
        mcpServers: mcpResult.data,
        dockerPorts: dockerResult.data,
        ollamaConfig: ollamaResult.data,
        liveServices: liveResult.data,
      },
    };
  },
};
