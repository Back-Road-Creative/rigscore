import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { fileExists, readFileSafe, readJsonSafe, execSafe, statSafe } from '../utils.js';

// Required git hooks in the global hooks directory
const REQUIRED_HOOKS = ['pre-commit', 'pre-push', 'commit-msg'];

// Default infrastructure paths (overridable via config)
const DEFAULT_HOOKS_DIR = '/opt/git-hooks';
const DEFAULT_GIT_WRAPPER = '/usr/local/bin/git';
const DEFAULT_SAFETY_GATES = '/etc/profile.d/safety-gates.sh';

// Required deny-list entries in settings.json
const REQUIRED_DENY_PATTERNS = [
  'git push --force',
  'git reset --hard',
  'rm -rf',
  'git push origin main',
  'git push origin master',
];

/**
 * Check if a file is owned by root (uid 0).
 */
async function isRootOwned(filePath) {
  const stat = await statSafe(filePath);
  return stat ? stat.uid === 0 : false;
}

/**
 * Check if a file is executable (owner execute bit).
 */
async function isExecutable(filePath) {
  const stat = await statSafe(filePath);
  // eslint-disable-next-line no-bitwise
  return stat ? (stat.mode & 0o100) !== 0 : false;
}

/**
 * Parse lsattr output for the immutable flag.
 * lsattr -d output looks like: "----i---------e------- /path/to/dir"
 */
function hasImmutableFlag(lsattrOutput) {
  if (!lsattrOutput) return false;
  // The flags are in the first field, before the path
  const flags = lsattrOutput.split(/\s+/)[0] || '';
  return flags.includes('i');
}

export default {
  id: 'infrastructure-security',
  name: 'Infrastructure security',
  category: 'process',

  async run(context) {
    const { cwd, homedir, config } = context;

    // Only applicable on Linux
    if (process.platform !== 'linux') {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'skipped', title: 'Infrastructure security check is Linux-only' }],
      };
    }

    const findings = [];
    const hooksDir = config?.paths?.hooksDir || DEFAULT_HOOKS_DIR;
    const gitWrapper = config?.paths?.gitWrapper || DEFAULT_GIT_WRAPPER;
    const safetyGates = config?.paths?.safetyGates || DEFAULT_SAFETY_GATES;

    // ── 1. Global git hooks directory ───────────────────────────────────
    const hooksDirExists = await fileExists(hooksDir);
    if (!hooksDirExists) {
      findings.push({
        severity: 'critical',
        title: 'Global git hooks directory missing',
        detail: `Expected root-owned hooks at ${hooksDir}`,
        remediation: 'Create /opt/git-hooks/ owned by root with pre-commit, pre-push, and commit-msg hooks.',
      });
    } else {
      const hooksDirRootOwned = await isRootOwned(hooksDir);
      if (!hooksDirRootOwned) {
        findings.push({
          severity: 'critical',
          title: 'Global git hooks directory not root-owned',
          detail: `${hooksDir} should be owned by root to prevent tampering`,
          remediation: `sudo chown root:root ${hooksDir}`,
        });
      }

      // Check each required hook
      for (const hook of REQUIRED_HOOKS) {
        const hookPath = path.join(hooksDir, hook);
        const exists = await fileExists(hookPath);
        if (!exists) {
          findings.push({
            severity: 'critical',
            title: `Required git hook missing: ${hook}`,
            detail: `${hookPath} not found`,
            remediation: `Create ${hookPath} as root-owned executable script.`,
          });
        } else {
          const executable = await isExecutable(hookPath);
          if (!executable) {
            findings.push({
              severity: 'warning',
              title: `Git hook not executable: ${hook}`,
              remediation: `sudo chmod 755 ${hookPath}`,
            });
          } else {
            findings.push({ severity: 'pass', title: `Git hook present and executable: ${hook}` });
          }
        }
      }
    }

    // ── 2. Git wrapper ──────────────────────────────────────────────────
    const wrapperExists = await fileExists(gitWrapper);
    if (!wrapperExists) {
      findings.push({
        severity: 'critical',
        title: 'Git safety wrapper missing',
        detail: `Expected root-owned git wrapper at ${gitWrapper}`,
        remediation: 'Install a git wrapper that strips --no-verify and blocks force push to main/master.',
      });
    } else {
      const wrapperRootOwned = await isRootOwned(gitWrapper);
      if (!wrapperRootOwned) {
        findings.push({
          severity: 'warning',
          title: 'Git wrapper not root-owned',
          detail: `${gitWrapper} should be root-owned to prevent tampering`,
        });
      }

      const content = await readFileSafe(gitWrapper);
      if (content && content.includes('no-verify')) {
        findings.push({ severity: 'pass', title: 'Git wrapper strips --no-verify' });
      } else {
        findings.push({
          severity: 'warning',
          title: 'Git wrapper does not strip --no-verify',
          detail: 'The wrapper should remove --no-verify flags to prevent hook bypass.',
        });
      }
    }

    // ── 3. Shell safety guard ───────────────────────────────────────────
    const safetyGatesExists = await fileExists(safetyGates);
    if (safetyGatesExists) {
      findings.push({ severity: 'pass', title: 'Shell safety guard present' });
    } else {
      findings.push({
        severity: 'info',
        title: 'Shell safety guard missing',
        detail: `No ${safetyGates} found. This blocks dangerous patterns like chmod 777.`,
        remediation: `Create ${safetyGates} with command wrappers for dangerous operations.`,
      });
    }

    // ── 4. Immutable directories ────────────────────────────────────────
    const immutableDirs = config?.paths?.immutableDirs || [];

    // Auto-detect workspace governance/foundation dirs
    const autoDetectDirs = ['_governance', '_foundation'];
    const dirsToCheck = [...immutableDirs];

    for (const dirName of autoDetectDirs) {
      // Walk up from cwd to find workspace root
      let current = cwd;
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(current, dirName);
        if (await fileExists(candidate)) {
          if (!dirsToCheck.includes(candidate)) {
            dirsToCheck.push(candidate);
          }
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    for (const dir of dirsToCheck) {
      const output = await execSafe('lsattr', ['-d', dir]);
      if (output === null) {
        findings.push({
          severity: 'info',
          title: `Cannot check immutability: ${path.basename(dir)}`,
          detail: 'lsattr not available or directory not found.',
        });
      } else if (hasImmutableFlag(output)) {
        findings.push({ severity: 'pass', title: `Immutable flag set: ${path.basename(dir)}` });
      } else {
        findings.push({
          severity: 'warning',
          title: `Immutable flag not set: ${path.basename(dir)}`,
          detail: `${dir} should have chattr +i to prevent unauthorized modification.`,
          remediation: `sudo chattr -R +i ${dir}`,
        });
      }
    }

    // ── 5. Settings.json deny list ──────────────────────────────────────
    const settingsPaths = [
      path.join(homedir, '.claude', 'settings.json'),
      path.join(homedir, '.claude', 'settings.local.json'),
      path.join(cwd, '.claude', 'settings.json'),
    ];

    let denyList = null;
    for (const p of settingsPaths) {
      const settings = await readJsonSafe(p);
      if (settings?.permissions?.deny) {
        denyList = settings.permissions.deny;
        break;
      }
    }

    if (denyList === null) {
      findings.push({
        severity: 'warning',
        title: 'No deny list found in settings.json',
        detail: 'AI tool settings should include a deny list for dangerous commands.',
      });
    } else {
      const denyStr = denyList.join(' ');
      const missing = REQUIRED_DENY_PATTERNS.filter(p => !denyStr.includes(p));
      if (missing.length > 0) {
        findings.push({
          severity: 'warning',
          title: `Deny list missing ${missing.length} required pattern(s)`,
          detail: `Missing: ${missing.join(', ')}`,
          remediation: 'Add the missing patterns to permissions.deny in settings.json.',
        });
      } else {
        findings.push({ severity: 'pass', title: 'Deny list contains all required patterns' });
      }
    }

    // ── 6. Sandbox gate registration ────────────────────────────────────
    let sandboxGateRegistered = false;
    for (const p of settingsPaths) {
      const settings = await readJsonSafe(p);
      if (settings?.hooks) {
        const hooksJson = JSON.stringify(settings.hooks);
        if (hooksJson.includes('sandbox-gate')) {
          sandboxGateRegistered = true;
          break;
        }
      }
    }

    if (sandboxGateRegistered) {
      findings.push({ severity: 'pass', title: 'Sandbox gate registered in hooks' });
    } else {
      findings.push({
        severity: 'warning',
        title: 'Sandbox gate not registered',
        detail: 'sandbox-gate.py should be registered as a PreToolUse hook for Write/Edit/Bash protection.',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        hooksDir,
        gitWrapper,
        immutableDirsChecked: dirsToCheck.length,
        denyListEntries: denyList ? denyList.length : 0,
        sandboxGateRegistered,
      },
    };
  },
};
