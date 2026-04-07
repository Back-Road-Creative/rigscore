import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, readJsonSafe } from '../utils.js';

/**
 * Shared constraints that skills should be aware of.
 * Each entry defines: what governance claims, what keyword(s) indicate awareness,
 * which skill categories need this, and the finding to emit if missing.
 */
const CONSTRAINT_CHECKS = [
  {
    id: 'merge-workflow',
    governancePattern: /\b(gh-merge-approved|brc-merge-approved|no direct merge)\b/i,
    awarenessPatterns: [/gh-merge-approved/i, /brc-merge-approved/i, /merge.*manual/i, /hand.?off.*merge/i],
    appliesTo: /\b(ship|commit|push|deploy|pr create|git push)\b/i,
    finding: {
      severity: 'warning',
      title: 'Skill unaware of merge workflow restrictions',
      detail: 'Governance requires merges via gh-merge-approved/brc-merge-approved (manual hand-off), but this skill handles git/shipping operations without mentioning the constraint.',
      remediation: 'Add merge workflow awareness: "Merge is manual via gh-merge-approved. Print PR URL and merge command for the user."',
    },
  },
  {
    id: 'layer-restrictions',
    governancePattern: /\b(_governance\/|_foundation\/|session.local.*consent|explicit.*approval)\b/i,
    awarenessPatterns: [/_governance\//i, /_foundation\//i, /session.local/i, /layer.*restrict/i, /require.*approval/i, /freely writable/i],
    appliesTo: /\b(write|edit|create|modify|scaffold|build|fix|remediat)\b/i,
    finding: {
      severity: 'warning',
      title: 'Skill unaware of layer write restrictions',
      detail: 'Governance restricts writes to _governance/ and _foundation/ (require explicit session-local approval), but this skill performs write operations without mentioning layer restrictions.',
      remediation: 'Add layer awareness: "_governance/ and _foundation/ require explicit session-local human approval before modification."',
    },
  },
  {
    id: 'wip-protection',
    governancePattern: /\b(WIP|untracked.*no backup|read.*before.*overwrite)\b/i,
    awarenessPatterns: [/WIP/i, /read.*before.*modif/i, /read.*existing.*files/i, /untracked.*no backup/i],
    appliesTo: /\b(write|edit|create|scaffold|build|overwrite)\b/i,
    finding: {
      severity: 'info',
      title: 'Skill does not mention WIP protection',
      detail: 'Governance requires reading existing files before overwriting in _active/svc-* (untracked files have no backup), but this skill performs write operations without mentioning the precaution.',
      remediation: 'Add WIP protection note: "Before overwriting files in _active/svc-*, read them first — untracked files have no backup."',
    },
  },
  {
    id: 'branch-protection',
    governancePattern: /\b(no.*force.*push|never.*push.*main|feature.*branch|protected.*branch)\b/i,
    awarenessPatterns: [/force.*push/i, /feature.*branch/i, /never.*push.*main/i, /protected.*branch/i, /branch.*first/i],
    appliesTo: /\b(push|commit|ship|deploy|git push)\b/i,
    finding: {
      severity: 'info',
      title: 'Skill does not mention branch protection',
      detail: 'Governance prohibits direct push to main/master and force push, but this skill handles git operations without mentioning branch protection.',
      remediation: 'Add branch protection note: "Always create a feature branch. No force push. No direct push to main/master."',
    },
  },
];

/**
 * Check for hook↔settings contradictions.
 * Detect cases where settings.json allow list permits something
 * that a PreToolUse hook blocks.
 */
function checkHookSettingsConflicts(hookContent, settingsData) {
  const findings = [];
  if (!hookContent || !settingsData) return findings;

  const allows = settingsData.allow || [];
  const localAllows = settingsData.localAllow || [];
  const allAllows = [...allows, ...localAllows];

  // Known conflict patterns: hook blocks X but settings allows X
  const CONFLICT_PATTERNS = [
    {
      hookPattern: /sops-get/,
      settingsPattern: /sops-get/i,
      title: 'Hook blocks sops-get but settings allows it',
      detail: 'PreToolUse hook hard-blocks all sops-get commands, but settings allow-list permits specific sops-get invocations. The hook always wins, making the allow entry dead code.',
      remediation: 'Remove sops-get from the PreToolUse hook ALWAYS_BLOCK list, or remove the dead allow entry from settings.',
    },
    {
      hookPattern: /gh-merge-approved/,
      settingsPattern: /gh-merge-approved/i,
      title: 'Hook blocks gh-merge-approved but settings allows it',
      detail: 'PreToolUse hook hard-blocks gh-merge-approved (intentionally keeping merges manual), but settings allow-list has a matching entry. The allow entry is dead code.',
      remediation: 'Remove the dead gh-merge-approved allow entry from settings, since the hook intentionally blocks it.',
    },
  ];

  for (const conflict of CONFLICT_PATTERNS) {
    const hookBlocks = conflict.hookPattern.test(hookContent);
    const settingsAllows = allAllows.some(a => conflict.settingsPattern.test(a));

    if (hookBlocks && settingsAllows) {
      findings.push({
        severity: 'warning',
        ...conflict,
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
async function discoverSkills(cwd, homedir) {
  const skills = [];
  const skillDirs = [
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.claude', 'commands'),
  ];

  if (homedir && homedir !== cwd) {
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
 */
async function readHookContent(homedir) {
  // Check common hook locations
  const hookPaths = [
    path.join(homedir, '.openclaw', 'hooks', 'sandbox-gate.py'),
    path.join(homedir, '.claude', 'hooks', 'sandbox-gate.py'),
  ];

  for (const p of hookPaths) {
    const content = await readFileSafe(p);
    if (content) return content;
  }
  return null;
}

/**
 * Read settings allow/deny lists from settings files.
 */
async function readSettingsPermissions(cwd, homedir) {
  const result = { allow: [], deny: [], localAllow: [], localDeny: [] };

  // Project settings
  const projSettings = await readJsonSafe(path.join(cwd, '.claude', 'settings.json'));
  if (projSettings?.permissions) {
    result.allow.push(...(projSettings.permissions.allow || []));
    result.deny.push(...(projSettings.permissions.deny || []));
  }

  // User settings
  const userSettings = await readJsonSafe(path.join(homedir, '.claude', 'settings.json'));
  if (userSettings?.permissions) {
    result.allow.push(...(userSettings.permissions.allow || []));
    result.deny.push(...(userSettings.permissions.deny || []));
  }

  // Local overrides
  const localSettings = await readJsonSafe(path.join(homedir, '.claude', 'settings.local.json'));
  if (localSettings?.permissions) {
    result.localAllow.push(...(localSettings.permissions.allow || []));
    result.localDeny.push(...(localSettings.permissions.deny || []));
  }

  return result;
}

export default {
  id: 'skill-coherence',
  name: 'Skill ↔ governance coherence',
  category: 'governance',
  pass: 2,

  async run(context) {
    const { cwd, homedir, priorResults } = context;
    const findings = [];

    // Get governance text from claude-md check
    const claudeMdResult = priorResults?.find(r => r.id === 'claude-md');
    const governanceText = claudeMdResult?.data?.governanceText || '';

    // Also read _governance/ files directly for richer context
    let extendedGovernance = governanceText;
    const govDir = path.join(cwd, '_governance');
    try {
      const entries = await fs.promises.readdir(govDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const content = await readFileSafe(path.join(govDir, entry));
        if (content) extendedGovernance += '\n' + content;
      }
    } catch { /* no _governance dir */ }

    // Discover skills
    const skills = await discoverSkills(cwd, homedir);

    if (skills.length === 0 && !governanceText) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };
    }

    // --- Check 1: Skill ↔ Governance constraint awareness ---
    if (skills.length > 0 && extendedGovernance) {
      for (const constraint of CONSTRAINT_CHECKS) {
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
              title: `${constraint.finding.title}: ${skill.name}`,
              detail: `${constraint.finding.detail} (skill: ${skill.relPath})`,
            });
          }
        }
      }
    }

    // --- Check 2: Hook ↔ Settings contradictions ---
    const hookContent = await readHookContent(homedir);
    const settingsData = await readSettingsPermissions(cwd, homedir);

    if (hookContent && settingsData) {
      findings.push(...checkHookSettingsConflicts(hookContent, settingsData));
    }

    // --- Check 3: Settings allow ↔ deny conflicts ---
    if (settingsData) {
      findings.push(...checkSettingsConflicts(settingsData));
    }

    // If no issues found
    if (findings.length === 0) {
      if (skills.length === 0) {
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
        constraintsCovered: CONSTRAINT_CHECKS.filter(c =>
          c.governancePattern.test(extendedGovernance),
        ).length,
        hookAnalyzed: !!hookContent,
        settingsConflictsChecked: !!(settingsData.allow.length || settingsData.deny.length),
      },
    };
  },
};
