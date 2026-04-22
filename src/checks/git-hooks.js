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
    if (/^(exit\s+0|true|:|echo\b|printf\b|sleep\b|date\b|ls\b|cat\s+\/dev\/null|test\s+-[fd]\b|whoami\b|pwd\b|hostname\b|uname\b|id\b)/.test(trimmed)) return false;
    return true;
  });
  return meaningful.length === 0;
}

/**
 * Check if a hook has substantive content — recognized patterns that
 * indicate the hook does real work (linting, secret scanning, testing, etc.)
 */
function hasSubstance(content) {
  const substantivePatterns = [
    /\bgrep\b/,
    /\blint/i,
    /\bsecret/i,
    /\bscan/i,
    /\btest\b/,
    /\bpytest\b/,
    /\bvitest\b/,
    /\bjest\b/,
    /\bpre-commit\b/,
    /\bexit\s+1/,
    /\bif\b.*\bthen\b/,
    /\bgitleaks\b/,
    /\btrufflehog\b/,
    /\bdetect-secrets\b/,
    /\bshellcheck\b/,
    /\beslint\b/,
    /\bprettier\b/,
    /\brubocop\b/,
    /\bflake8\b/,
    /\bmypy\b/,
    /\bruff\b/,
  ];
  return substantivePatterns.some((p) => p.test(content));
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
      findingId: 'git-hooks/hook-empty',
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
          findingId: 'git-hooks/hook-not-executable',
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
      findingId: 'git-hooks/hook-noop',
      severity: 'warning',
      title: `${hookName} hook is a no-op`,
      detail: `${hookPath} exists but contains only trivial commands (exit 0, echo, etc.). It provides no protection.`,
      remediation: `Add meaningful checks to your ${hookName} hook.`,
    });
    return findings;
  }

  // Hook has content and passes no-op filter, but check for substance
  if (!hasSubstance(content)) {
    findings.push({
      findingId: 'git-hooks/hook-lacks-substance',
      severity: 'info',
      title: `${hookName} hook may lack substance`,
      detail: `${hookPath} has content but no recognized linting, scanning, or testing patterns were detected.`,
      remediation: `Verify the ${hookName} hook performs meaningful checks.`,
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

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    const hasGitDir = await fileExists(path.join(cwd, '.git'));
    if (!hasGitDir) {
      findings.push({
        findingId: 'git-hooks/not-a-git-repo',
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
        findingId: 'git-hooks/no-hooks-installed',
        severity: 'warning',
        title: 'No pre-commit hooks installed',
        detail: 'Without commit hooks, secrets and governance file changes can be committed unchecked.',
        remediation: 'Install pre-commit hooks with Husky or lefthook to enforce checks before commits.',
      });
    }

    // Check if any hooks contain secret scanning patterns
    if (hasHooks) {
      const secretScanPatterns = [/\bgitleaks\b/, /\btrufflehog\b/, /\bdetect-secrets\b/];
      let hasSecretScanning = false;

      // Check native hooks
      for (const hookPath of [preCommit, prePush]) {
        const content = await readFileSafe(hookPath);
        if (content && secretScanPatterns.some(p => p.test(content))) {
          hasSecretScanning = true;
          break;
        }
      }

      // Check husky hooks
      if (!hasSecretScanning) {
        const huskyPreCommit = path.join(cwd, '.husky', 'pre-commit');
        const huskyContent = await readFileSafe(huskyPreCommit);
        if (huskyContent && secretScanPatterns.some(p => p.test(huskyContent))) {
          hasSecretScanning = true;
        }
      }

      if (!hasSecretScanning) {
        findings.push({
          findingId: 'git-hooks/no-secret-scanning',
          severity: 'warning',
          title: 'Pre-commit hooks lack secret scanning',
          detail: 'No gitleaks, trufflehog, or detect-secrets integration detected in hooks.',
          remediation: 'Add a secret scanning step to your pre-commit hooks (e.g., gitleaks, trufflehog, detect-secrets).',
        });
      }
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
