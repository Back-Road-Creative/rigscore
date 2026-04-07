import path from 'node:path';
import { readJsonSafe } from './utils.js';
import { WEIGHTS } from './constants.js';

const DEFAULTS = {
  paths: {
    claudeMd: [],
    dockerCompose: [],
    mcpConfig: [],
    hookDirs: [],
    skillFiles: [],
    immutableDirs: [],
  },
  network: {
    safeHosts: ['127.0.0.1', 'localhost', '::1'],
  },
  sites: [],
  profile: null,
  weights: {},
  checks: { disabled: [] },
  suppress: [],
};

export const PROFILES = {
  default: { ...WEIGHTS },
  minimal: {
    'mcp-config': 30,
    'coherence': 30,
    'skill-files': 20,
    'claude-md': 20,
    'deep-secrets': 0,
    'env-exposure': 0,
    'docker-security': 0,
    'git-hooks': 0,
    'permissions-hygiene': 0,
  },
  ci: { ...WEIGHTS },
};

/**
 * Resolve final weights from config: profile → overrides → disabled checks.
 */
export function resolveWeights(config) {
  const profileName = config?.profile || 'default';
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown profile: "${profileName}". Valid profiles: ${Object.keys(PROFILES).join(', ')}`);
  }

  const resolved = { ...profile };

  // Apply weight overrides (including plugin weights) with validation
  if (config?.weights) {
    for (const [key, value] of Object.entries(config.weights)) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        process.stderr.write(`rigscore: ignoring non-numeric weight for "${key}": ${value}\n`);
        continue;
      }
      if (value < 0) {
        process.stderr.write(`rigscore: clamping negative weight for "${key}" to 0\n`);
        resolved[key] = 0;
        continue;
      }
      if (value > 100) {
        process.stderr.write(`rigscore: clamping weight for "${key}" from ${value} to 100\n`);
        resolved[key] = 100;
        continue;
      }
      resolved[key] = value;
    }
  }

  // Zero out disabled checks
  if (config?.checks?.disabled) {
    for (const id of config.checks.disabled) {
      resolved[id] = 0;
    }
  }

  return resolved;
}

/**
 * Load optional .rigscorerc.json from cwd, then homedir.
 * cwd takes precedence. Returns merged config with defaults.
 */
export async function loadConfig(cwd, homedir) {
  const cwdConfig = await readJsonSafe(path.join(cwd, '.rigscorerc.json'));
  if (cwdConfig) return mergeConfig(cwdConfig);

  const homeConfig = await readJsonSafe(path.join(homedir, '.rigscorerc.json'));
  if (homeConfig) return mergeConfig(homeConfig);

  return structuredClone(DEFAULTS);
}

function mergeConfig(userConfig) {
  const result = structuredClone(DEFAULTS);

  if (userConfig.paths) {
    for (const key of Object.keys(result.paths)) {
      if (Array.isArray(userConfig.paths[key])) {
        // Concatenate and deduplicate arrays instead of replacing
        result.paths[key] = [...new Set([...result.paths[key], ...userConfig.paths[key]])];
      }
    }
  }

  if (userConfig.network) {
    if (Array.isArray(userConfig.network.safeHosts)) {
      // Concatenate and deduplicate
      result.network.safeHosts = [...new Set([...result.network.safeHosts, ...userConfig.network.safeHosts])];
    }
  }

  if (userConfig.profile) {
    result.profile = userConfig.profile;
  }
  if (userConfig.weights && typeof userConfig.weights === 'object') {
    result.weights = { ...result.weights, ...userConfig.weights };
  }
  if (userConfig.checks) {
    if (Array.isArray(userConfig.checks.disabled)) {
      result.checks.disabled = userConfig.checks.disabled;
    }
  }

  if (Array.isArray(userConfig.suppress)) {
    result.suppress = userConfig.suppress;
  }

  if (Array.isArray(userConfig.sites)) {
    result.sites = [...new Set([...result.sites, ...userConfig.sites])];
  }

  return result;
}
