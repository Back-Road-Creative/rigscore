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
  },
  network: {
    safeHosts: ['127.0.0.1', 'localhost', '::1'],
  },
  profile: null,
  weights: {},
  checks: { disabled: [] },
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

const VALID_CHECK_IDS = new Set(Object.keys(WEIGHTS));

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

  // Apply weight overrides
  if (config?.weights) {
    for (const [key, value] of Object.entries(config.weights)) {
      if (!VALID_CHECK_IDS.has(key)) {
        throw new Error(`Invalid check ID in weights: "${key}". Valid IDs: ${[...VALID_CHECK_IDS].join(', ')}`);
      }
      resolved[key] = value;
    }
  }

  // Zero out disabled checks
  if (config?.checks?.disabled) {
    for (const id of config.checks.disabled) {
      if (!VALID_CHECK_IDS.has(id)) {
        throw new Error(`Invalid check ID in disabled: "${id}". Valid IDs: ${[...VALID_CHECK_IDS].join(', ')}`);
      }
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
        result.paths[key] = userConfig.paths[key];
      }
    }
  }

  if (userConfig.network) {
    if (Array.isArray(userConfig.network.safeHosts)) {
      result.network.safeHosts = userConfig.network.safeHosts;
    }
  }

  if (userConfig.profile) {
    result.profile = userConfig.profile;
  }
  if (userConfig.weights && typeof userConfig.weights === 'object') {
    result.weights = userConfig.weights;
  }
  if (userConfig.checks) {
    if (Array.isArray(userConfig.checks.disabled)) {
      result.checks.disabled = userConfig.checks.disabled;
    }
  }

  return result;
}
