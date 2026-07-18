import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, readJsonSafe, collectGovernanceDirFiles } from '../utils.js';
import { homeScopeEnabled } from '../lib/home-scope.js';

/**
 * Coerce a user-supplied regex spec (string, RegExp, or {source, flags})
 * into a RegExp. Returns null if the spec is unusable.
 */
function toRegex(spec) {
  if (!spec) return null;
  if (spec instanceof RegExp) return spec;
  if (typeof spec === 'string') {
    try { return new RegExp(spec, 'i'); } catch { return null; }
  }
  if (typeof spec === 'object' && typeof spec.source === 'string') {
    try { return new RegExp(spec.source, spec.flags || 'i'); } catch { return null; }
  }
  return null;
}

/**
 * Normalise a config-provided constraint entry into a runnable constraint.
 * Returns null for malformed entries (missing required regex fields).
 *
 * Shape (see DEFAULTS in src/config.js): each entry is
 *   {
 *     id, governancePattern, awarenessPatterns: [...], appliesTo,
 *     finding: { severity, title, detail, remediation }
 *   }
 * where pattern fields may be RegExp, string, or {source, flags}.
 */
function normaliseConstraint(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const governancePattern = toRegex(entry.governancePattern);
  const appliesTo = toRegex(entry.appliesTo);
  const awarenessPatterns = Array.isArray(entry.awarenessPatterns)
    ? entry.awarenessPatterns.map(toRegex).filter(Boolean)
    : [];
  if (!governancePattern || !appliesTo || awarenessPatterns.length === 0) return null;
  const finding = entry.finding && typeof entry.finding === 'object' ? entry.finding : null;
  if (!finding || typeof finding.title !== 'string') return null;
  return {
    id: entry.id || 'unnamed-constraint',
    governancePattern,
    appliesTo,
    awarenessPatterns,
    finding: {
      severity: finding.severity || 'warning',
      title: finding.title,
      detail: finding.detail || '',
      remediation: finding.remediation || '',
    },
  };
}

/**
 * Check for hook↔settings contradictions.
 * Detect cases where settings.json allow list permits something
 * that a PreToolUse hook blocks.
 *
 * Conflict patterns are opt-in via config.skillCoherence.hookSettingsConflicts.
 * Each entry: { hookPattern, settingsPattern, title, detail, remediation }
 * (patterns may be RegExp, string, or {source, flags}).
 */
function checkHookSettingsConflicts(hookContent, settingsData, conflictPatterns = []) {
  const findings = [];
  if (!hookContent || !settingsData) return findings;
  if (!Array.isArray(conflictPatterns) || conflictPatterns.length === 0) return findings;

  const allows = settingsData.allow || [];
  const localAllows = settingsData.localAllow || [];
  const allAllows = [...allows, ...localAllows];

  for (const conflict of conflictPatterns) {
    const hookPattern = toRegex(conflict.hookPattern);
    const settingsPattern = toRegex(conflict.settingsPattern);
    if (!hookPattern || !settingsPattern) continue;

    const hookBlocks = hookPattern.test(hookContent);
    const settingsAllows = allAllows.some(a => settingsPattern.test(a));

    if (hookBlocks && settingsAllows) {
      findings.push({
        findingId: conflict.findingId || 'skill-coherence/hook-settings-allow-conflict',
        severity: conflict.severity || 'warning',
        title: conflict.title || 'Hook/settings allow-list conflict',
        detail: conflict.detail || 'PreToolUse hook blocks a command that settings allow-list permits.',
        remediation: conflict.remediation || 'Resolve the conflict by updating the hook or settings.',
      });
    }
  }

  return findings;
}

/**
 * Check for settings deny↔allow contradictions.
 */
function checkSettingsConflicts(settingsData) {
  const findings = [];
  if (!settingsData) return findings;

  const allows = [...(settingsData.allow || []), ...(settingsData.localAllow || [])];
  const denies = settingsData.deny || [];

  // Find cases where the same command pattern appears in both allow and deny
  for (const allow of allows) {
    // Extract the command pattern from Bash(pattern:*)
    const allowMatch = allow.match(/^Bash\(([^:)]+)/);
    if (!allowMatch) continue;
    const allowCmd = allowMatch[1].toLowerCase();

    for (const deny of denies) {
      const denyMatch = deny.match(/^Bash\(([^:)]+)/);
      if (!denyMatch) continue;
      const denyCmd = denyMatch[1].toLowerCase();

      // Check if allow is a more specific version of deny (or exact match)
      if (allowCmd === denyCmd || allowCmd.startsWith(denyCmd + ' ')) {
        findings.push({
          findingId: 'skill-coherence/settings-allow-deny-conflict',
          severity: 'info',
          title: `Settings allow/deny conflict: ${allowCmd}`,
          detail: `"${allow}" in allow list overlaps with "${deny}" in deny list. Resolution depends on specificity and which settings file has precedence.`,
          remediation: 'Review whether the allow entry should override the deny. If intentional, document why. If not, remove the conflicting entry.',
        });
      }
    }
  }

  return findings;
}

/**
 * Discover skill files and read their content.
 */
async function discoverSkills(cwd, homedir, includeHome) {
  const skills = [];
  const skillDirs = [
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.claude', 'commands'),
  ];

  // Home skill/command dirs belong to the operator's profile — gated behind
  // --include-home-skills so they don't feed a project's coherence findings.
  if (includeHome) {
    skillDirs.push(
      path.join(homedir, '.claude', 'skills'),
      path.join(homedir, '.claude', 'commands'),
    );
  }

  for (const dir of skillDirs) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillPath = path.join(dir, entry.name, 'SKILL.md');
        const content = await readFileSafe(skillPath);
        if (content) {
          skills.push({
            name: entry.name,
            path: skillPath,
            content,
            relPath: dir.startsWith(cwd)
              ? path.relative(cwd, skillPath)
              : skillPath.replace(homedir, '~'),
          });
        }
      }
    } catch { /* directory doesn't exist */ }
  }

  return skills;
}

/**
 * Read hook script content for analysis.
 *
 * Hook paths are opt-in via config.paths.hookFiles.
 * When no paths are configured, no hook content is read — callers should
 * then skip the hook/settings conflict check entirely.
 */
async function readHookContent(hookFilePaths = []) {
  if (!Array.isArray(hookFilePaths) || hookFilePaths.length === 0) return null;

  for (const p of hookFilePaths) {
    if (typeof p !== 'string' || !p) continue;
    const content = await readFileSafe(p);
    if (content) return content;
  }
  return null;
}

/**
 * Read settings allow/deny lists from settings files.
 */
async function readSettingsPermissions(cwd, homedir, includeHome) {
  const result = { allow: [], deny: [], localAllow: [], localDeny: [] };

  // Project settings
  const projSettings = await readJsonSafe(path.join(cwd, '.claude', 'settings.json'));
  if (projSettings?.permissions) {
    result.allow.push(...(projSettings.permissions.allow || []));
    result.deny.push(...(projSettings.permissions.deny || []));
  }

  // User + local-override settings live in $HOME — the operator's, not the
  // project's. Gated behind --include-home-skills so an operator's own allow/deny
  // conflict does not surface as a finding on every project scan.
  if (includeHome) {
    const userSettings = await readJsonSafe(path.join(homedir, '.claude', 'settings.json'));
    if (userSettings?.permissions) {
      result.allow.push(...(userSettings.permissions.allow || []));
      result.deny.push(...(userSettings.permissions.deny || []));
    }

    const localSettings = await readJsonSafe(path.join(homedir, '.claude', 'settings.local.json'));
    if (localSettings?.permissions) {
      result.localAllow.push(...(localSettings.permissions.allow || []));
      result.localDeny.push(...(localSettings.permissions.deny || []));
    }
  }

  return result;
}

export default {
  id: 'skill-coherence',
  enforcementGrade: 'keyword',
  name: 'Skill ↔ governance coherence',
  category: 'governance',
  pass: 2,

  async run(context) {
    const { cwd, homedir, priorResults, config } = context;
    const findings = [];

    // Resolve configured constraints, hook paths, and conflict patterns.
    // All of these default to empty — a fresh install fires no author-specific
    // pairings. Users opt in via .rigscorerc.json.
    const configuredConstraints = (config?.skillCoherence?.constraints || [])
      .map(normaliseConstraint)
      .filter(Boolean);
    const hookFilePaths = Array.isArray(config?.paths?.hookFiles)
      ? config.paths.hookFiles
      : [];
    const hookConflictPatterns = Array.isArray(config?.skillCoherence?.hookSettingsConflicts)
      ? config.skillCoherence.hookSettingsConflicts
      : [];

    // Get governance text from claude-md check
    const claudeMdResult = priorResults?.find(r => r.id === 'governance-docs');
    const governanceText = claudeMdResult?.data?.governanceText || '';

    // Assemble the extended governance text from two additive sources, deduped
    // by absolute path so a file returned by both is read only once.
    let extendedGovernance = governanceText;
    const seenGovFiles = new Set();

    // (1) Built-in directory-form rule sets (.cursor/rules/*.mdc, .windsurf/rules,
    // .clinerules dir, .github/instructions/*.instructions.md) are governance too,
    // scanned by DEFAULT via the shared helper — so a repo governed ONLY by
    // directory-form rules still feeds this constraint-awareness check. Precedent:
    // claude-md, unicode-steganography, and instruction-effectiveness use the same
    // helper (per-directory extension matching lives there, not here).
    for (const { full } of await collectGovernanceDirFiles(cwd)) {
      const abs = path.resolve(full);
      if (seenGovFiles.has(abs)) continue;
      seenGovFiles.add(abs);
      const content = await readFileSafe(full);
      if (content) extendedGovernance += '\n' + content;
    }

    // (2) User-configured extra governance directories (additive, not a
    // replacement). Path list is user-configurable via config.paths.governanceDirs;
    // default empty: no extra reading.
    const extraGovDirs = Array.isArray(config?.paths?.governanceDirs)
      ? config.paths.governanceDirs
      : [];
    for (const govDir of extraGovDirs) {
      try {
        const entries = await fs.promises.readdir(govDir);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;
          const full = path.join(govDir, entry);
          const abs = path.resolve(full);
          if (seenGovFiles.has(abs)) continue;
          seenGovFiles.add(abs);
          const content = await readFileSafe(full);
          if (content) extendedGovernance += '\n' + content;
        }
      } catch { /* missing or not readable */ }
    }

    // Discover skills
    const includeHome = homeScopeEnabled(context);
    const skills = await discoverSkills(cwd, homedir, includeHome);

    // --- Check 1: Skill ↔ Governance constraint awareness ---
    if (configuredConstraints.length > 0 && skills.length > 0 && extendedGovernance) {
      for (const constraint of configuredConstraints) {
        // Does governance claim this constraint?
        if (!constraint.governancePattern.test(extendedGovernance)) continue;

        // Check each skill
        for (const skill of skills) {
          // Does this skill perform operations that need this constraint?
          if (!constraint.appliesTo.test(skill.content)) continue;

          // Does the skill mention the constraint?
          const isAware = constraint.awarenessPatterns.some(p => p.test(skill.content));
          if (!isAware) {
            findings.push({
              ...constraint.finding,
              findingId: constraint.finding.findingId || `skill-coherence/constraint-unaware-${constraint.id}`,
              title: `${constraint.finding.title}: ${skill.name}`,
              detail: `${constraint.finding.detail} (skill: ${skill.relPath})`,
            });
          }
        }
      }
    }

    // --- Check 2: Hook ↔ Settings contradictions ---
    const hookContent = await readHookContent(hookFilePaths);
    const settingsData = await readSettingsPermissions(cwd, homedir, includeHome);

    if (hookContent && settingsData) {
      findings.push(...checkHookSettingsConflicts(hookContent, settingsData, hookConflictPatterns));
    }

    // --- Check 3: Settings allow ↔ deny conflicts ---
    let settingsConflictsFound = 0;
    if (settingsData) {
      const conflicts = checkSettingsConflicts(settingsData);
      settingsConflictsFound = conflicts.length;
      findings.push(...conflicts);
    }

    // N/A gate: when constraint awareness and hook-conflict features are
    // unconfigured AND there are no settings-level allow/deny conflicts,
    // the check has nothing universal to report. Return N/A so a default
    // install produces no findings here.
    const constraintsConfigured = configuredConstraints.length > 0;
    const hookFeatureActive = hookFilePaths.length > 0 && hookConflictPatterns.length > 0;
    const hasAnythingToReport = constraintsConfigured || hookFeatureActive || settingsConflictsFound > 0;

    if (findings.length === 0 && !hasAnythingToReport) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };
    }

    // If no issues found but we did exercise a feature, emit a pass
    if (findings.length === 0) {
      if (skills.length === 0 && !constraintsConfigured && !hookFeatureActive) {
        return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };
      }
      findings.push({
        severity: 'pass',
        title: 'Skills are coherent with governance constraints',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        skillsAnalyzed: skills.length,
        constraintsCovered: configuredConstraints.filter(c =>
          c.governancePattern.test(extendedGovernance),
        ).length,
        hookAnalyzed: !!hookContent,
        settingsConflictsChecked: !!(settingsData.allow.length || settingsData.deny.length),
      },
    };
  },
};
