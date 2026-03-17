import path from 'node:path';
import { readJsonSafe } from './utils.js';

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
};

/**
 * Load optional .rigscorerc.json from cwd, then homedir.
 * cwd takes precedence. Returns merged config with defaults.
 */
export async function loadConfig(cwd, homedir) {
  const cwdConfig = await readJsonSafe(path.join(cwd, '.rigscorerc.json'));
  if (cwdConfig) return sanitizePaths(mergeConfig(cwdConfig), cwd);

  const homeConfig = await readJsonSafe(path.join(homedir, '.rigscorerc.json'));
  if (homeConfig) return sanitizePaths(mergeConfig(homeConfig), cwd);

  return structuredClone(DEFAULTS);
}

/**
 * Reject any config paths that resolve outside of cwd (path traversal defense).
 */
function sanitizePaths(config, cwd) {
  const prefix = cwd + path.sep;
  for (const key of Object.keys(config.paths)) {
    if (Array.isArray(config.paths[key])) {
      config.paths[key] = config.paths[key].filter((p) => {
        const resolved = path.resolve(cwd, p);
        return resolved === cwd || resolved.startsWith(prefix);
      });
    }
  }
  return config;
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

  return result;
}
