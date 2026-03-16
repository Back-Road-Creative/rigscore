import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { fileExists, readJsonSafe, readFileSafe, statSafe } from '../utils.js';

/**
 * Detect no-op hooks: after stripping shebang, comments, blank lines,
 * and trivial no-op statements, if nothing remains, the hook does nothing.
 */
function isNoOpHook(content) {
  const lines = content.split('\n');
  const meaningful = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false; // comments (including shebang)
    // Trivial no-op commands
    if (/^(exit\s+0|true|:|echo\b|printf\b)/.test(trimmed)) return false;
    return true;
  });
  return meaningful.length === 0;
}

/**
 * Validate a native git hook: check it exists, has content, is executable,
 * and is not a no-op.
 * Returns an array of findings for this hook.
 */
async function validateNativeHook(hookPath, hookName) {
  const findings = [];
  if (!await fileExists(hookPath)) return findings;

  const content = await readFileSafe(hookPath);

  // Empty hook — exists but does nothing
  if (!content || content.trim().length === 0) {
    findings.push({
      severity: 'warning',
      title: `${hookName} hook is empty`,
      detail: `${hookPath} exists but contains no logic. An empty hook provides no protection.`,
      remediation: `Add meaningful checks to your ${hookName} hook.`,
    });
    return findings;
  }

  // Non-executable on POSIX
  if (process.platform !== 'win32') {
    const stat = await statSafe(hookPath);
    if (stat) {
      const mode = stat.mode & 0o777;
      const isExecutable = (mode & 0o111) !== 0;
      if (!isExecutable) {
        findings.push({
          severity: 'info',
          title: `${hookName} hook is not executable`,
          detail: `${hookPath} has mode ${mode.toString(8)} — git will not run it.`,
          remediation: `Run: chmod +x ${hookPath}`,
        });
        return findings;
      }
    }
  }

  // No-op hook — has content but does nothing meaningful
  if (isNoOpHook(content)) {
    findings.push({
      severity: 'warning',
      title: `${hookName} hook is a no-op`,
      detail: `${hookPath} exists but contains only trivial commands (exit 0, echo, etc.). It provides no protection.`,
      remediation: `Add meaningful checks to your ${hookName} hook.`,
    });
    return findings;
  }

  // Valid hook
  findings.push({
    severity: 'pass',
    title: `${hookName} hook installed`,
  });
  return findings;
}

export default {
  id: 'git-hooks',
  name: 'Git hooks',
  category: 'process',
  weight: 10,

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    const hasGitDir = await fileExists(path.join(cwd, '.git'));
    if (!hasGitDir) {
      findings.push({
        severity: 'info',
        title: 'Not a git repository',
        detail: 'No .git directory found. Git hooks check skipped.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    let hasHooks = false;

    // Check native git hooks (with content + executable validation)
    const preCommit = path.join(cwd, '.git', 'hooks', 'pre-commit');
    const prePush = path.join(cwd, '.git', 'hooks', 'pre-push');

    const preCommitFindings = await validateNativeHook(preCommit, 'Pre-commit');
    findings.push(...preCommitFindings);
    if (preCommitFindings.some((f) => f.severity === 'pass')) hasHooks = true;

    const prePushFindings = await validateNativeHook(prePush, 'Pre-push');
    findings.push(...prePushFindings);
    if (prePushFindings.some((f) => f.severity === 'pass')) hasHooks = true;

    // Check husky
    const huskyDir = path.join(cwd, '.husky');
    if (await fileExists(huskyDir)) {
      hasHooks = true;
      findings.push({
        severity: 'pass',
        title: 'Husky hook manager installed',
      });
    }

    // Check lefthook
    const lefthookYml = path.join(cwd, 'lefthook.yml');
    const lefthookYaml = path.join(cwd, 'lefthook.yaml');
    if (await fileExists(lefthookYml) || await fileExists(lefthookYaml)) {
      hasHooks = true;
      findings.push({
        severity: 'pass',
        title: 'Lefthook hook manager configured',
      });
    }

    // Check package.json for husky/lint-staged
    const pkg = await readJsonSafe(path.join(cwd, 'package.json'));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.husky || deps['lint-staged']) {
        hasHooks = true;
        // Don't duplicate if husky dir already found
        if (!await fileExists(huskyDir)) {
          findings.push({
            severity: 'pass',
            title: 'Husky/lint-staged in package.json dependencies',
          });
        }
      }
    }

    // Check Claude Code hooks in settings
    const claudeSettingsPaths = [
      path.join(homedir, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.json'),
    ];
    for (const settingsPath of claudeSettingsPaths) {
      const settings = await readJsonSafe(settingsPath);
      if (settings?.hooks) {
        hasHooks = true;
        findings.push({
          severity: 'pass',
          title: 'Claude Code hooks configured',
          detail: `Hooks found in ${path.relative(cwd, settingsPath) || settingsPath}.`,
        });
        break;
      }
    }

    // Check pushurl guards in .git/config
    const gitConfig = await readFileSafe(path.join(cwd, '.git', 'config'));
    if (gitConfig && /pushurl\s*=\s*no_push/i.test(gitConfig)) {
      hasHooks = true;
      findings.push({
        severity: 'pass',
        title: 'Push URL guard detected in .git/config',
      });
    }

    // Check external hook directories from config
    if (config?.paths?.hookDirs) {
      for (const hookDir of config.paths.hookDirs) {
        if (await fileExists(hookDir)) {
          hasHooks = true;
          findings.push({
            severity: 'pass',
            title: `External hook directory found: ${hookDir}`,
          });
        }
      }
    }

    if (!hasHooks) {
      findings.push({
        severity: 'warning',
        title: 'No pre-commit hooks installed',
        detail: 'Without commit hooks, secrets and governance file changes can be committed unchecked.',
        remediation: 'Install pre-commit hooks with Husky or lefthook to enforce checks before commits.',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
