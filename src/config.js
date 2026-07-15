import path from 'node:path';
import { readJsonStrict, ConfigParseError } from './utils.js';
import { WEIGHTS } from './constants.js';

const DEFAULTS = {
  paths: {
    claudeMd: [],
    dockerCompose: [],
    mcpConfig: [],
    // `tools/list` snapshot JSON files (the same shape piped into `rigscore
    // mcp-hash`) that the opt-in --semantic judge reads tool descriptions from.
    mcpToolsSnapshot: [],
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
  deepScan: {
    maxFiles: null,
    excludeDirs: [],
  },
  limits: {
    maxFileBytes: null,
    maxWalkDepth: null,
  },
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
  memoryHygiene: {
    // Byte budget for the auto-loaded agent-memory bundle. 40,000 ≈ 10k tokens
    // ≈ 5% of a 200k-token window (docs/checks/memory-hygiene.md). Raise it for
    // a repo that deliberately carries a large always-on memory set; lower it to
    // hold a tighter line. Must be a positive integer — anything else is ignored.
    budgetBytes: 40_000,
  },
  specGoals: {
    // Day gap at which a goal file reads as trailing the specs, and an unfinished
    // spec reads as abandoned rather than mid-flight (docs/checks/spec-goals.md).
    // 90 ≈ one planning quarter. Shorten it for a fast-moving repo that wants the
    // nudge sooner; lengthen it for a long-cycle project that would find 90 noisy.
    // Must be a positive integer — anything else is ignored.
    driftWindowDays: 90,
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
 * Load .rigscorerc.json from ~/ and project root and merge them.
 *
 * Precedence (low → high): DEFAULTS → ~/.rigscorerc.json → project
 * .rigscorerc.json. Arrays concatenate (deduplicated); scalars and
 * objects from the higher-precedence file override the lower one. This
 * lets users keep personal suppressions / safeHosts in ~/.rigscorerc.json
 * and have them additive with project-specific rules.
 *
 * A config file (home or project) may declare an `extends` key to inherit from
 * a shared baseline — see applyConfigWithExtends for the resolution rules.
 */
export async function loadConfig(cwd, homedir) {
  // Strict parse — a malformed .rigscorerc.json surfaces a ConfigParseError
  // (propagated to the CLI, which exits 2 with a friendly message) instead
  // of silently falling back to defaults and confusing the user.
  const homePath = homedir ? path.join(homedir, '.rigscorerc.json') : null;
  const cwdPath = path.join(cwd, '.rigscorerc.json');
  const homeConfig = homePath ? await readJsonStrict(homePath) : null;
  const cwdConfig = await readJsonStrict(cwdPath);

  let merged = structuredClone(DEFAULTS);
  // Seed `visited` with the declaring file's own absolute path so a base that
  // extends back to it is caught as a cycle. Home and project are resolved
  // independently — each may declare its own `extends`.
  if (homeConfig) {
    merged = await applyConfigWithExtends(homeConfig, merged, homedir, new Set([homePath]));
  }
  if (cwdConfig) {
    merged = await applyConfigWithExtends(cwdConfig, merged, cwd, new Set([cwdPath]));
  }
  return merged;
}

/**
 * Resolve a config's `extends` chain, then merge the config's own keys on top.
 *
 * `extends` lets a .rigscorerc.json inherit from one or more shared baselines so
 * a single hardened config is reusable across many repos. Semantics:
 *   - Value is a string OR an array of strings, each a LOCAL path (a relative
 *     path resolves against `baseDir` — the directory of the file that declared
 *     it; an absolute path is allowed).
 *   - An extended base is LOWER precedence than the file that extends it, and
 *     within an array LATER entries override EARLIER ones (ESLint convention).
 *     Layering is thus: incoming `merged` → each target (recursively, in array
 *     order) → this file's own keys.
 *   - Recursive: a target may itself declare `extends`; it is resolved
 *     depth-first before its own keys apply.
 *   - `visited` holds ABSOLUTE paths on the current ancestor chain; re-entering
 *     one throws a ConfigParseError naming the cycle. Each target gets an
 *     independent copy, so a diamond (two bases sharing one grandparent) is NOT
 *     a cycle.
 *   - No egress: a value starting with `http://` or `https://` is REJECTED,
 *     never fetched — rigscore makes no external calls by default. Node-module
 *     resolution ("some-pkg/base") is out of scope; such a value simply fails
 *     the local-path lookup as "extends target not found".
 *   - `extends` is meta and is stripped before mergeConfig (whose signature is
 *     unchanged) ever sees it.
 */
async function applyConfigWithExtends(config, merged, baseDir, visited) {
  const ext = config.extends;
  if (ext !== undefined) {
    const targets = Array.isArray(ext) ? ext : [ext];
    for (const target of targets) {
      if (typeof target !== 'string') {
        throw new ConfigParseError({
          filePath: baseDir,
          parseMessage: `extends entries must be strings, got ${typeof target}`,
        });
      }
      if (/^https?:\/\//i.test(target)) {
        throw new ConfigParseError({
          filePath: target,
          parseMessage: 'extends must be a local path, not a URL — rigscore never fetches remote config',
        });
      }
      const targetPath = path.resolve(baseDir, target);
      if (visited.has(targetPath)) {
        throw new ConfigParseError({
          filePath: targetPath,
          parseMessage: `extends cycle detected: ${[...visited, targetPath].join(' -> ')}`,
        });
      }
      const targetConfig = await readJsonStrict(targetPath);
      if (targetConfig === null) {
        throw new ConfigParseError({
          filePath: targetPath,
          parseMessage: `extends target not found: ${target}`,
        });
      }
      merged = await applyConfigWithExtends(
        targetConfig,
        merged,
        path.dirname(targetPath),
        new Set([...visited, targetPath]),
      );
    }
  }
  // Strip the meta `extends` key before the additive merge runs.
  const { extends: _extends, ...own } = config;
  return mergeConfig(own, merged);
}

function mergeConfig(userConfig, baseline) {
  const result = baseline ? structuredClone(baseline) : structuredClone(DEFAULTS);

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
      // Concat & dedupe so home-level disables stay in effect in projects
      result.checks.disabled = [
        ...new Set([...(result.checks.disabled || []), ...userConfig.checks.disabled]),
      ];
    }
  }

  if (Array.isArray(userConfig.suppress)) {
    // Concat & dedupe — personal suppressions stack with project suppressions
    result.suppress = [...new Set([...(result.suppress || []), ...userConfig.suppress])];
  }

  if (Array.isArray(userConfig.sites)) {
    result.sites = [...new Set([...result.sites, ...userConfig.sites])];
  }

  if (userConfig.coherence && typeof userConfig.coherence === 'object') {
    if (Array.isArray(userConfig.coherence.allowGovernanceContradictions)) {
      result.coherence.allowGovernanceContradictions = [
        ...new Set([
          ...(result.coherence.allowGovernanceContradictions || []),
          ...userConfig.coherence.allowGovernanceContradictions,
        ]),
      ];
    }
  }

  if (userConfig.skillCoherence && typeof userConfig.skillCoherence === 'object') {
    if (Array.isArray(userConfig.skillCoherence.constraints)) {
      result.skillCoherence.constraints = [
        ...new Set([
          ...(result.skillCoherence.constraints || []),
          ...userConfig.skillCoherence.constraints,
        ]),
      ];
    }
    if (Array.isArray(userConfig.skillCoherence.hookSettingsConflicts)) {
      result.skillCoherence.hookSettingsConflicts = [
        ...new Set([
          ...(result.skillCoherence.hookSettingsConflicts || []),
          ...userConfig.skillCoherence.hookSettingsConflicts,
        ]),
      ];
    }
  }

  if (userConfig.workflowMaturity && typeof userConfig.workflowMaturity === 'object') {
    if (Array.isArray(userConfig.workflowMaturity.stageDirs)) {
      result.workflowMaturity.stageDirs = [
        ...new Set([
          ...(result.workflowMaturity.stageDirs || []),
          ...userConfig.workflowMaturity.stageDirs,
        ]),
      ];
    }
  }

  if (userConfig.mcpConfig && typeof userConfig.mcpConfig === 'object') {
    if (typeof userConfig.mcpConfig.surfaceRuntimeHashStatus === 'boolean') {
      result.mcpConfig.surfaceRuntimeHashStatus = userConfig.mcpConfig.surfaceRuntimeHashStatus;
    }
  }

  if (userConfig.instructionEffectiveness && typeof userConfig.instructionEffectiveness === 'object') {
    if (Array.isArray(userConfig.instructionEffectiveness.crossRepoRefs)) {
      // Concatenate-and-dedupe so a project .rigscorerc.json composes with
      // ~/.rigscorerc.json instead of clobbering it. The loadConfig header
      // documents this policy ("Arrays concatenate (deduplicated)") — this
      // branch previously replaced, which broke users running multiple
      // projects under one home config.
      result.instructionEffectiveness.crossRepoRefs = [
        ...new Set([
          ...(result.instructionEffectiveness.crossRepoRefs || []),
          ...userConfig.instructionEffectiveness.crossRepoRefs,
        ]),
      ];
    }
  }

  if (userConfig.memoryHygiene && typeof userConfig.memoryHygiene === 'object') {
    // Scalar override (project beats home). A non-integer or non-positive value
    // is dropped rather than throwing — the check falls back to its default.
    const budget = userConfig.memoryHygiene.budgetBytes;
    if (Number.isInteger(budget) && budget > 0) {
      result.memoryHygiene.budgetBytes = budget;
    }
  }

  if (userConfig.specGoals && typeof userConfig.specGoals === 'object') {
    // Scalar override (project beats home), same policy as memoryHygiene above:
    // a non-integer or non-positive window is dropped rather than throwing, and
    // the check falls back to its 90-day default.
    const window = userConfig.specGoals.driftWindowDays;
    if (Number.isInteger(window) && window > 0) {
      result.specGoals.driftWindowDays = window;
    }
  }

  if (userConfig.skillFiles && typeof userConfig.skillFiles === 'object') {
    if (Array.isArray(userConfig.skillFiles.allowlist)) {
      // Allowlist entries are objects, not strings — dedupe by a composite
      // (skill + pattern) key so identical entries in home + project don't
      // double-count but distinct project-specific entries are appended.
      const seen = new Set(
        (result.skillFiles.allowlist || []).map((e) => `${e.skill}::${e.pattern}`),
      );
      const merged = [...(result.skillFiles.allowlist || [])];
      for (const entry of userConfig.skillFiles.allowlist) {
        const key = `${entry.skill}::${entry.pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
      result.skillFiles.allowlist = merged;
    }
  }

  if (userConfig.deepScan && typeof userConfig.deepScan === 'object') {
    if (Number.isInteger(userConfig.deepScan.maxFiles)) {
      result.deepScan.maxFiles = userConfig.deepScan.maxFiles;
    }
    if (Array.isArray(userConfig.deepScan.excludeDirs)) {
      // Concat & dedupe — personal excludes stack with project excludes
      result.deepScan.excludeDirs = [
        ...new Set([...(result.deepScan.excludeDirs || []), ...userConfig.deepScan.excludeDirs]),
      ];
    }
  }

  if (userConfig.limits && typeof userConfig.limits === 'object') {
    if (Number.isInteger(userConfig.limits.maxFileBytes)) {
      result.limits.maxFileBytes = userConfig.limits.maxFileBytes;
    }
    if (Number.isInteger(userConfig.limits.maxWalkDepth)) {
      result.limits.maxWalkDepth = userConfig.limits.maxWalkDepth;
    }
  }

  return result;
}
