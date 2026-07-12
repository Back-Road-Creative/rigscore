import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { fileExists, readFileSafe, readJsonSafe, execSafe, statSafe } from '../utils.js';

// Required git hooks in the global hooks directory
const REQUIRED_HOOKS = ['pre-commit', 'pre-push', 'commit-msg'];

// Conventional system locations for a shell safety guard. Derived from the
// paths this check already documents (`/etc/profile.d/safety-*.sh`), not a
// new filesystem convention.
const DEFAULT_SAFETY_GATE_PATHS = [
  '/etc/profile.d/safety-gates.sh',
  '/etc/profile.d/safety-guard.sh',
];

// A git safety wrapper is a shell script; the real git is a compiled binary.
// Cap the read so we never slurp a multi-MB ELF just to look at its shebang.
const MAX_WRAPPER_BYTES = 256 * 1024;

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
 * A hooks dir is only worth scanning when it actually manages hooks: git ships
 * `.git/hooks` full of `*.sample` files in every repo, and scanning that would
 * emit "required hook missing" on every project.
 */
async function managesHooks(dir) {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.some((e) => !e.endsWith('.sample'));
  } catch {
    return false;
  }
}

/**
 * The first `git` on PATH, but only if it is a script (`#!` shebang) — the
 * real git is a compiled binary, so a script shadowing it IS the wrapper.
 * No wrapper installed → null → that surface is simply not scanned.
 */
async function detectGitWrapper(env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'git');
    if (!(await fileExists(candidate))) continue;
    const stat = await statSafe(candidate);
    // First git on PATH wins (that's what a shell would run), wrapper or not.
    if (!stat || !stat.isFile() || stat.size > MAX_WRAPPER_BYTES) return null;
    const content = await readFileSafe(candidate);
    return content && content.startsWith('#!') ? candidate : null;
  }
  return null;
}

/**
 * Detect the conventional locations of the artifacts this check inspects, so
 * it runs out of the box instead of lying dormant behind `.rigscorerc.json`.
 * Defaults table + rationale: docs/checks/infrastructure-security.md.
 *
 * `immutableDirs` has NO default on purpose: `chattr +i` is an operator claim
 * about a specific directory, so defaulting one would manufacture a warning on
 * every project. Detection is anchored to a git project (no repo at `cwd` → no
 * git-hooks/wrapper surface), and every detected path is verified to exist, so
 * a missing optional artifact can never become a false-positive finding.
 */
async function detectDefaultPaths(cwd, env) {
  const detected = { hooksDir: null, gitWrapper: null, safetyGates: null };
  if (!cwd || !(await fileExists(path.join(cwd, '.git')))) return detected;

  const raw = await execSafe('git', ['-C', cwd, 'rev-parse', '--git-path', 'hooks']);
  const hooksDir = raw && raw.trim() ? path.resolve(cwd, raw.trim()) : null;
  if (hooksDir && (await fileExists(hooksDir)) && (await managesHooks(hooksDir))) {
    detected.hooksDir = hooksDir;
  }

  detected.gitWrapper = await detectGitWrapper(env);

  for (const candidate of DEFAULT_SAFETY_GATE_PATHS) {
    if (await fileExists(candidate)) {
      detected.safetyGates = candidate;
      break;
    }
  }
  return detected;
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
  enforcementGrade: 'mechanical',
  name: 'Infrastructure security',
  category: 'process',

  async run(context) {
    const { cwd, homedir, config } = context;

    // Only applicable on Linux. Name the platform so this skip is
    // distinguishable from the "nothing to scan" skip below.
    if (process.platform !== 'linux') {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{
          severity: 'skipped',
          title: `Infrastructure security check is Linux-only (platform: ${process.platform})`,
        }],
      };
    }

    const declaredHooksDir = config?.paths?.hooksDir || null;
    const declaredGitWrapper = config?.paths?.gitWrapper || null;
    const declaredSafetyGates = config?.paths?.safetyGates || null;
    const immutableDirs = config?.paths?.immutableDirs || [];

    // Declared `.rigscorerc.json` paths are authoritative; defaults only fill
    // the gaps — a detected default never stomps a declared value.
    const detected = await detectDefaultPaths(cwd, process.env);
    const hooksDir = declaredHooksDir || detected.hooksDir;
    const gitWrapper = declaredGitWrapper || detected.gitWrapper;
    const safetyGates = declaredSafetyGates || detected.safetyGates;
    const pathSources = {
      hooksDir: declaredHooksDir ? 'config' : (detected.hooksDir ? 'default' : null),
      gitWrapper: declaredGitWrapper ? 'config' : (detected.gitWrapper ? 'default' : null),
      safetyGates: declaredSafetyGates ? 'config' : (detected.safetyGates ? 'default' : null),
      immutableDirs: immutableDirs.length > 0 ? 'config' : null,
    };

    // Nothing declared, nothing at the default locations → nothing to look at.
    // Still N/A, but the message says we looked rather than "configure paths".
    const anyInfra = !!(hooksDir || gitWrapper || safetyGates || immutableDirs.length > 0);
    if (!anyInfra) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{
          severity: 'skipped',
          title: 'Infrastructure security: nothing found at the default locations (no managed git hooks dir, git wrapper, or shell safety guard) — opt-in via .rigscorerc.json paths.hooksDir/gitWrapper/safetyGates/immutableDirs',
          detail: `Searched: git hooks path for ${cwd}, the first \`git\` on PATH, ${DEFAULT_SAFETY_GATE_PATHS.join(', ')}.`,
        }],
        data: {},
      };
    }

    // Root-ownership is a claim about a *managed* control, so it is asserted
    // only for declared paths: a repo-local hooks dir is user-owned by design
    // (git writes to it), so a uid-0 finding there is a guaranteed false
    // positive. "Artifact missing" likewise can only fire for a declared path.
    const hooksDirDeclared = !!declaredHooksDir;
    const gitWrapperDeclared = !!declaredGitWrapper;

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
        const hooksDirRootOwned = hooksDirDeclared ? await isRootOwned(hooksDir) : true;
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
              // A CRITICAL zeroes the whole check. Only a declared hooks dir
              // is an operator claim strong enough to warrant that; a detected
              // one reports the same gap as a WARNING.
              severity: hooksDirDeclared ? 'critical' : 'warning',
              title: `Required git hook missing: ${hook}`,
              detail: `${hookPath} not found`,
              remediation: `Create ${hookPath} as root-owned executable script.`,
              context: { hook, hookPath, source: pathSources.hooksDir },
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
        const wrapperRootOwned = gitWrapperDeclared ? await isRootOwned(gitWrapper) : true;
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
        safetyGates,
        pathSources,
        immutableDirsChecked: dirsToCheck.length,
        denyListEntries: denyList ? denyList.length : 0,
        sandboxGateRegistered,
      },
    };
  },
};
