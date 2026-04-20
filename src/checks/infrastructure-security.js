import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { fileExists, readFileSafe, readJsonSafe, execSafe, statSafe } from '../utils.js';

// Required git hooks in the global hooks directory
const REQUIRED_HOOKS = ['pre-commit', 'pre-push', 'commit-msg'];

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

    const hooksDir = config?.paths?.hooksDir || null;
    const gitWrapper = config?.paths?.gitWrapper || null;
    const safetyGates = config?.paths?.safetyGates || null;
    const immutableDirs = config?.paths?.immutableDirs || [];

    // Opt-in gate: without any infrastructure paths configured, return N/A.
    // This keeps the "universal infrastructure guidance" framing without
    // punishing default installs that don't replicate an enterprise stack.
    const anyInfraConfigured = !!(hooksDir || gitWrapper || safetyGates || immutableDirs.length > 0);
    if (!anyInfraConfigured) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{
          severity: 'skipped',
          title: 'Infrastructure security check is opt-in; configure .rigscorerc.json paths.hooksDir/gitWrapper/safetyGates/immutableDirs to enable.',
        }],
        data: {},
      };
    }

    const findings = [];

    // ── 1. Global git hooks directory (only when configured) ───────────
    if (hooksDir) {
      const hooksDirExists = await fileExists(hooksDir);
      if (!hooksDirExists) {
        findings.push({
          findingId: 'infrastructure-security/hooks-dir-missing',
          severity: 'critical',
          title: 'Global git hooks directory missing',
          detail: `Expected root-owned hooks at ${hooksDir}`,
          remediation: `Create ${hooksDir} owned by root with pre-commit, pre-push, and commit-msg hooks.`,
          context: { hooksDir },
        });
      } else {
        const hooksDirRootOwned = await isRootOwned(hooksDir);
        if (!hooksDirRootOwned) {
          findings.push({
            findingId: 'infrastructure-security/hooks-dir-not-root-owned',
            severity: 'critical',
            title: 'Global git hooks directory not root-owned',
            detail: `${hooksDir} should be owned by root to prevent tampering`,
            remediation: `sudo chown root:root ${hooksDir}`,
            context: { hooksDir },
          });
        }

        // Check each required hook
        for (const hook of REQUIRED_HOOKS) {
          const hookPath = path.join(hooksDir, hook);
          const exists = await fileExists(hookPath);
          if (!exists) {
            findings.push({
              findingId: 'infrastructure-security/required-hook-missing',
              severity: 'critical',
              title: `Required git hook missing: ${hook}`,
              detail: `${hookPath} not found`,
              remediation: `Create ${hookPath} as root-owned executable script.`,
              context: { hook, hookPath },
            });
          } else {
            const executable = await isExecutable(hookPath);
            if (!executable) {
              findings.push({
                findingId: 'infrastructure-security/hook-not-executable',
                severity: 'warning',
                title: `Git hook not executable: ${hook}`,
                remediation: `sudo chmod 755 ${hookPath}`,
                context: { hook, hookPath },
              });
            } else {
              findings.push({ severity: 'pass', title: `Git hook present and executable: ${hook}` });
            }
          }
        }
      }
    }

    // ── 2. Git wrapper (only when configured) ──────────────────────────
    if (gitWrapper) {
      const wrapperExists = await fileExists(gitWrapper);
      if (!wrapperExists) {
        findings.push({
          findingId: 'infrastructure-security/git-wrapper-missing',
          severity: 'critical',
          title: 'Git safety wrapper missing',
          detail: `Expected root-owned git wrapper at ${gitWrapper}`,
          remediation: 'Install a git wrapper that strips --no-verify and blocks force push to main/master.',
          context: { gitWrapper },
        });
      } else {
        const wrapperRootOwned = await isRootOwned(gitWrapper);
        if (!wrapperRootOwned) {
          findings.push({
            findingId: 'infrastructure-security/git-wrapper-not-root-owned',
            severity: 'warning',
            title: 'Git wrapper not root-owned',
            detail: `${gitWrapper} should be root-owned to prevent tampering`,
            context: { gitWrapper },
          });
        }

        const content = await readFileSafe(gitWrapper);
        if (content && content.includes('no-verify')) {
          findings.push({ severity: 'pass', title: 'Git wrapper strips --no-verify' });
        } else {
          findings.push({
            findingId: 'infrastructure-security/git-wrapper-no-verify-bypass',
            severity: 'warning',
            title: 'Git wrapper does not strip --no-verify',
            detail: 'The wrapper should remove --no-verify flags to prevent hook bypass.',
            context: { gitWrapper },
          });
        }
      }
    }

    // ── 3. Shell safety guard (only when configured) ───────────────────
    if (safetyGates) {
      const safetyGatesExists = await fileExists(safetyGates);
      if (safetyGatesExists) {
        findings.push({ severity: 'pass', title: 'Shell safety guard present' });
      } else {
        findings.push({
          findingId: 'infrastructure-security/safety-gates-missing',
          severity: 'info',
          title: 'Shell safety guard missing',
          detail: `No ${safetyGates} found. This blocks dangerous patterns like chmod 777.`,
          remediation: `Create ${safetyGates} with command wrappers for dangerous operations.`,
          context: { safetyGates },
        });
      }
    }

    // ── 4. Immutable directories (explicit list only) ──────────────────
    const dirsToCheck = [...immutableDirs];

    for (const dir of dirsToCheck) {
      const output = await execSafe('lsattr', ['-d', dir]);
      if (output === null) {
        findings.push({
          findingId: 'infrastructure-security/cannot-check-immutability',
          severity: 'info',
          title: `Cannot check immutability: ${path.basename(dir)}`,
          detail: 'lsattr not available or directory not found.',
          context: { dir },
        });
      } else if (hasImmutableFlag(output)) {
        findings.push({ severity: 'pass', title: `Immutable flag set: ${path.basename(dir)}` });
      } else {
        findings.push({
          findingId: 'infrastructure-security/immutable-flag-not-set',
          severity: 'warning',
          title: `Immutable flag not set: ${path.basename(dir)}`,
          detail: `${dir} should have chattr +i to prevent unauthorized modification.`,
          remediation: `sudo chattr -R +i ${dir}`,
          context: { dir },
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
        findingId: 'infrastructure-security/no-deny-list',
        severity: 'warning',
        title: 'No deny list found in settings.json',
        detail: 'AI tool settings should include a deny list for dangerous commands.',
      });
    } else {
      const denyStr = denyList.join(' ');
      const missing = REQUIRED_DENY_PATTERNS.filter(p => !denyStr.includes(p));
      if (missing.length > 0) {
        findings.push({
          findingId: 'infrastructure-security/deny-list-missing-patterns',
          severity: 'warning',
          title: `Deny list missing ${missing.length} required pattern(s)`,
          detail: `Missing: ${missing.join(', ')}`,
          remediation: 'Add the missing patterns to permissions.deny in settings.json.',
          context: { missing },
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
        findingId: 'infrastructure-security/sandbox-gate-not-registered',
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
