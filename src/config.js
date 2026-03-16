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

  return result;
}
