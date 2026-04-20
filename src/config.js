import path from 'node:path';
import { readJsonSafe } from './utils.js';
import { WEIGHTS } from './constants.js';

const DEFAULTS = {
  paths: {
    claudeMd: [],
    dockerCompose: [],
    mcpConfig: [],
    hookDirs: [],
    hookFiles: [],
    skillFiles: [],
    governanceDirs: [],
    immutableDirs: [],
    hooksDir: null,
    gitWrapper: null,
    safetyGates: null,
  },
  network: {
    safeHosts: ['127.0.0.1', 'localhost', '::1'],
  },
  sites: [],
  profile: null,
  weights: {},
  checks: { disabled: [] },
  suppress: [],
  coherence: {
    allowGovernanceContradictions: [],
  },
  skillCoherence: {
    constraints: [],
    hookSettingsConflicts: [],
  },
  workflowMaturity: {
    stageDirs: ['stages', 'phases'],
  },
  mcpConfig: {
    // Default-on INFO finding per repo-level MCP server in .mcp.json that
    // reports runtime tool-hash pin status (see `rigscore mcp-hash` subcommand).
    // Set to false to suppress the INFO findings in normal scans.
    surfaceRuntimeHashStatus: true,
  },
  instructionEffectiveness: {
    // Glob patterns for legitimate cross-repo file references. Refs matching
    // any pattern are NOT flagged as dead even if the file can't be resolved
    // from the current cwd. Supports `*` (segment) and `**` (any) globs.
    // Example: ["_active/**", "lib-skill-utils/**", "_foundation/**"]
    crossRepoRefs: [],
  },
  skillFiles: {
    // Allowlist entries for patterns that would otherwise flag (e.g. `sudo` in
    // an operator skill). Each entry: { skill, pattern, reason }.
    //   skill   — directory name under `.claude/skills/` to match
    //   pattern — pattern id: "sudo", "curl", "wget", "shell-exec", ...
    //   reason  — human-readable justification (surfaced in suppressed output)
    allowlist: [],
  },
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
  // `home` — single-user dev boxes (e.g. ~/ as the project). Governance,
  // skill files, CLAUDE.md, and MCP config dominate; infra/docker/windows
  // checks are turned off so coverage-scaling doesn't punish home users for
  // N/A infrastructure surfaces that don't apply to a personal home dir.
  home: {
    'mcp-config': 20,
    'skill-files': 20,
    'claude-md': 20,
    'coherence': 15,
    'claude-settings': 10,
    'deep-secrets': 5,
    'env-exposure': 5,
    'credential-storage': 5,
    'docker-security': 0,
    'infrastructure-security': 0,
    'unicode-steganography': 0,
    'git-hooks': 0,
    'permissions-hygiene': 0,
    'windows-security': 0,
    'network-exposure': 0,
    'site-security': 0,
    'instruction-effectiveness': 0,
    'skill-coherence': 0,
    'workflow-maturity': 0,
    'documentation': 0,
  },
  // `monorepo` — default weights, but hints callers toward recursive=true
  // and a higher depth tolerance. Weights identical to default; the
  // difference is behavioral (see resolveProfileHints).
  monorepo: { ...WEIGHTS },
};

/**
 * Non-weight profile defaults (recursive mode, depth). Applied as hints
 * when the CLI doesn't override them explicitly.
 */
export const PROFILE_HINTS = {
  monorepo: { recursive: true, depth: 3 },
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
        console.warn(`rigscore: ignoring non-numeric weight for "${key}": ${value}`);
        continue;
      }
      if (value < 0) {
        console.warn(`rigscore: clamping negative weight for "${key}" to 0`);
        resolved[key] = 0;
        continue;
      }
      if (value > 100) {
        console.warn(`rigscore: clamping weight for "${key}" from ${value} to 100`);
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
      const userValue = userConfig.paths[key];
      if (Array.isArray(result.paths[key]) && Array.isArray(userValue)) {
        // Concatenate and deduplicate arrays instead of replacing
        result.paths[key] = [...new Set([...result.paths[key], ...userValue])];
      } else if (result.paths[key] === null && typeof userValue === 'string') {
        // Scalar path overrides
        result.paths[key] = userValue;
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

  if (userConfig.coherence && typeof userConfig.coherence === 'object') {
    if (Array.isArray(userConfig.coherence.allowGovernanceContradictions)) {
      result.coherence.allowGovernanceContradictions = userConfig.coherence.allowGovernanceContradictions;
    }
  }

  if (userConfig.skillCoherence && typeof userConfig.skillCoherence === 'object') {
    if (Array.isArray(userConfig.skillCoherence.constraints)) {
      result.skillCoherence.constraints = userConfig.skillCoherence.constraints;
    }
    if (Array.isArray(userConfig.skillCoherence.hookSettingsConflicts)) {
      result.skillCoherence.hookSettingsConflicts = userConfig.skillCoherence.hookSettingsConflicts;
    }
  }

  if (userConfig.workflowMaturity && typeof userConfig.workflowMaturity === 'object') {
    if (Array.isArray(userConfig.workflowMaturity.stageDirs)) {
      result.workflowMaturity.stageDirs = userConfig.workflowMaturity.stageDirs;
    }
  }

  if (userConfig.mcpConfig && typeof userConfig.mcpConfig === 'object') {
    if (typeof userConfig.mcpConfig.surfaceRuntimeHashStatus === 'boolean') {
      result.mcpConfig.surfaceRuntimeHashStatus = userConfig.mcpConfig.surfaceRuntimeHashStatus;
    }
  }

  if (userConfig.instructionEffectiveness && typeof userConfig.instructionEffectiveness === 'object') {
    if (Array.isArray(userConfig.instructionEffectiveness.crossRepoRefs)) {
      result.instructionEffectiveness.crossRepoRefs = userConfig.instructionEffectiveness.crossRepoRefs;
    }
  }

  if (userConfig.skillFiles && typeof userConfig.skillFiles === 'object') {
    if (Array.isArray(userConfig.skillFiles.allowlist)) {
      result.skillFiles.allowlist = userConfig.skillFiles.allowlist;
    }
  }

  return result;
}
