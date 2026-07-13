import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calculateCheckScore } from '../scoring.js';
import { KEY_PATTERNS, AI_CONFIG_FILES } from '../constants.js';
import { readFileSafe, fileExists, statSafe, scanLineForSecrets } from '../utils.js';

const execFileAsync = promisify(execFile);

const CONFIG_FILES = AI_CONFIG_FILES;

const ENV_GITIGNORE_PATTERNS = [
  '.env',
  '.env*',
  '*.env',
  '**/.env',
  '.env.*',
  '.env.local',
  '.env.*.local',
];

// Negation patterns that are safe — they un-ignore example/template files, not real .env
const SAFE_NEGATION_RE = /^!\.env\.(example|sample|template)$/;

// A dangerous negation is a `!` line that un-ignores a real `.env`-family file:
// `!.env`, `!.env.local`, or a path-prefixed `!config/.env`. `.env` must be an
// anchored path token (start of the basename), NOT a bare substring — otherwise
// unrelated lines like `!venv/keep.txt`, `!environment/`, or `!.eslintrc.env-notes`
// would spuriously flag an already-ignored `.env` as exposed.
const DANGEROUS_NEGATION_RE = /^!(?:.*\/)?\.env(?:\..+)?$/;

/**
 * Run `git check-ignore --quiet --no-index <file>` to ask git itself whether
 * a path matches gitignore rules. `--no-index` is required: without it, git
 * reports tracked files as "not ignored" even when `.gitignore` would match
 * them, which is the wrong semantic for a hygiene scanner (a `.env` checked
 * in by mistake is exactly what we want to flag, or recognize as gitignored
 * when the rule is in place).
 *
 * Git's exit codes:
 *   0   = path is ignored
 *   1   = path is NOT ignored
 *   128 = not a git repo (or other fatal error)
 * Returns 'ignored' | 'not-ignored' | 'unknown'. 'unknown' lets callers fall
 * back to the legacy exact-string match when git itself is unavailable.
 */
async function gitCheckIgnore(cwd, file) {
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', '--no-index', file], {
      cwd,
      timeout: 5000,
    });
    return 'ignored';
  } catch (err) {
    // execFile rejects with an Error carrying a numeric `code` for the exit
    // status. 1 = not ignored (definitive). 128 (or anything else, including
    // ENOENT when git is missing) = fall back to the legacy parser.
    if (err && err.code === 1) return 'not-ignored';
    return 'unknown';
  }
}

// Legacy fallback: parse .gitignore in `cwd` and look for an exact-string
// match against a known set of `.env` patterns. Used when git is unavailable
// or `cwd` is not inside a working tree.
function legacyGitignoreContains(content) {
  const lines = content.split('\n').map((l) => l.trim());
  return lines.some((l) => ENV_GITIGNORE_PATTERNS.includes(l));
}

async function isInGitignore(cwd, envFile = '.env') {
  // Dangerous-negation guard runs first against the local .gitignore. Even if
  // git considers the file ignored, a stray `!.env` line in the same
  // .gitignore is a configuration smell we still surface as not-ignored.
  const gitignorePath = path.join(cwd, '.gitignore');
  const content = await readFileSafe(gitignorePath);
  if (content) {
    const lines = content.split('\n').map((l) => l.trim());
    const hasDangerousNegation = lines.some(
      (l) => DANGEROUS_NEGATION_RE.test(l) && !SAFE_NEGATION_RE.test(l),
    );
    if (hasDangerousNegation) return false;
  }

  // Preferred path: ask git. Handles monorepo path-prefixed entries
  // (`apps/backend/.env`), `**/.env`, parent-dir `.gitignore` chains, and any
  // other gitignore syntax we'd otherwise need to re-implement.
  const verdict = await gitCheckIgnore(cwd, envFile);
  if (verdict === 'ignored') return true;
  if (verdict === 'not-ignored') return false;

  // Fallback: no git repo here. Keep the legacy exact-string check so
  // non-git working trees (CI tarball, `npx` against an unpacked release)
  // still get a useful answer.
  if (!content) return false;
  return legacyGitignoreContains(content);
}

export const fixes = [
  {
    id: 'env-not-gitignored',
    findingIds: ['env-exposure/env-not-gitignored'],
    match: (f) => f.severity === 'critical' && f.title?.includes('.env') && f.title?.includes('.gitignore'),
    description: 'Add .env to .gitignore',
    async apply(cwd) {
      const gitignorePath = path.join(cwd, '.gitignore');
      let content = '';
      try {
        content = await fs.promises.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist yet
      }
      if (!content.split('\n').map(l => l.trim()).includes('.env')) {
        const newline = content && !content.endsWith('\n') ? '\n' : '';
        await fs.promises.writeFile(gitignorePath, content + newline + '.env\n');
        return true;
      }
      return false;
    },
  },
  {
    id: 'env-world-readable',
    findingIds: ['env-exposure/env-world-readable'],
    match: (f) => f.severity === 'warning' && f.title?.includes('world-readable') && f.title?.includes('.env'),
    description: 'chmod 600 on .env files',
    async apply(cwd) {
      if (process.platform === 'win32') return false;
      const entries = await fs.promises.readdir(cwd).catch(() => []);
      let fixed = false;
      for (const entry of entries) {
        if (entry === '.env' || entry.startsWith('.env.')) {
          const filePath = path.join(cwd, entry);
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mode & 0o004) {
              await fs.promises.chmod(filePath, 0o600);
              fixed = true;
            }
          } catch {
            // skip
          }
        }
      }
      return fixed;
    },
  },
];

export default {
  id: 'env-exposure',
  enforcementGrade: 'mechanical',
  name: 'Secret exposure',
  category: 'secrets',

  async run(context) {
    const { cwd } = context;
    const findings = [];
    const isPosix = process.platform !== 'win32';

    // Check for .env files
    const envFiles = [];
    const entries = await fs.promises.readdir(cwd).catch(() => []);
    for (const entry of entries) {
      if (entry === '.env' || (entry.startsWith('.env.') && !entry.endsWith('.example'))) {
        envFiles.push(entry);
      }
    }

    if (envFiles.length > 0) {
      // Ask git about every discovered env file and collect the offenders
      // by name. The previous code only tracked a boolean and emitted a
      // generic ".env file found" message even when the real offender was
      // .env.production or .env.local, leaving the user to guess which
      // file to add to .gitignore.
      const unignored = [];
      for (const envFile of envFiles) {
        if (!(await isInGitignore(cwd, envFile))) {
          unignored.push(envFile);
        }
      }
      if (unignored.length > 0) {
        const fileList = unignored.join(', ');
        findings.push({
          findingId: 'env-exposure/env-not-gitignored',
          severity: 'critical',
          title: `${fileList} found but NOT in .gitignore`,
          detail: 'Your API keys and secrets will be committed to version control.',
          evidence: `unignored: ${fileList}`,
          remediation: `Add ${unignored.length === 1 ? unignored[0] : 'these files'} to .gitignore immediately.`,
          learnMore: 'https://headlessmode.com/tools/rigscore/#env-security',
        });
      } else {
        findings.push({
          severity: 'pass',
          title: '.env file properly gitignored',
        });
      }

      // Check .env file permissions
      if (isPosix) {
        for (const envFile of envFiles) {
          const envStat = await statSafe(path.join(cwd, envFile));
          if (envStat) {
            const mode = envStat.mode & 0o777;
            // World-readable check: "others" read bit
            if (mode & 0o004) {
              findings.push({
                findingId: 'env-exposure/env-world-readable',
                severity: 'warning',
                title: `${envFile} is world-readable`,
                detail: `${envFile} has mode ${mode.toString(8)}. Secrets files should not be world-readable.`,
                evidence: `${envFile} mode ${mode.toString(8)}`,
                remediation: `Run: chmod 600 ${envFile}`,
              });
            }
          }
        }
      } else {
        findings.push({
          severity: 'skipped',
          title: '.env file permission checks skipped on Windows',
          detail: 'POSIX file permission checks are not available on Windows. Consider using icacls to verify .env file permissions manually.',
        });
      }
    }

    // Scan .env.example/.env.sample/.env.template for real secrets
    const templateSuffixes = ['.env.example', '.env.sample', '.env.template'];
    for (const tmpl of templateSuffixes) {
      const tmplPath = path.join(cwd, tmpl);
      const tmplContent = await readFileSafe(tmplPath);
      if (!tmplContent) continue;

      const lines = tmplContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const result = scanLineForSecrets(line, trimmed);
        if (result.matched && result.severity === 'critical') {
          findings.push({
            findingId: 'env-exposure/real-secret-in-template',
            severity: 'warning',
            title: `Real secret found in ${tmpl}`,
            detail: `Template file ${tmpl} contains what appears to be a real secret, not a placeholder.`,
            remediation: `Replace the real secret in ${tmpl} with a placeholder like "your_key_here".`,
            context: { file: tmpl },
          });
          break; // one finding per template file
        }
      }
    }

    // Detect GCP service account files (dual-field: "type":"service_account" + "private_key")
    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(cwd, configFile);
      const content = await readFileSafe(filePath);
      if (!content) continue;
      if (content.includes('"type"') && content.includes('service_account') && content.includes('"private_key"')) {
        findings.push({
          findingId: 'env-exposure/gcp-service-account-key',
          severity: 'critical',
          title: `GCP service account key in ${configFile}`,
          detail: `File contains both "type": "service_account" and "private_key" — this is a GCP credential file.`,
          remediation: 'Remove the service account key file from the project. Use workload identity or environment-based auth.',
          context: { file: configFile },
        });
      }
    }

    // Detect SOPS
    const sopsConfig = await fileExists(path.join(cwd, '.sops.yaml'));
    if (sopsConfig) {
      findings.push({
        severity: 'pass',
        title: 'Secrets managed by SOPS',
        detail: '.sops.yaml found — secrets are encrypted at rest.',
      });
    }

    // Scan config files for hardcoded keys — line by line to skip comments
    // Track worst finding per file (CRITICAL > INFO) so a comment match
    // doesn't shadow a real hardcoded key later in the same file.
    const COMMENT_PREFIXES = ['#', '//', '<!--'];
    const SEVERITY_RANK = { critical: 2, info: 1 };
    let hardcodedFound = false;
    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(cwd, configFile);
      const content = await readFileSafe(filePath);
      if (!content) continue;

      const fileLines = content.split('\n');
      let worstFinding = null;
      let worstRank = 0;
      for (const line of fileLines) {
        const trimmed = line.trim();
        const isComment = COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));

        for (const pattern of KEY_PATTERNS) {
          if (pattern.test(line)) {
            hardcodedFound = true;
            const isExample = /\b(example|placeholder|demo|sample|template|your_?key|xxx|changeme|replace_?me)\b/i.test(line);
            const severity = isComment || isExample ? 'info' : 'critical';
            const rank = SEVERITY_RANK[severity] || 0;
            if (rank > worstRank) {
              worstRank = rank;
              const findingId = isComment
                ? 'env-exposure/api-key-in-comment'
                : isExample
                  ? 'env-exposure/api-key-example-placeholder'
                  : 'env-exposure/hardcoded-api-key';
              worstFinding = {
                findingId,
                severity,
                title: isComment
                  ? `API key pattern in comment in ${configFile}`
                  : isExample
                    ? `Example/placeholder API key in ${configFile}`
                    : `Hardcoded API key found in ${configFile}`,
                detail: isComment
                  ? `A secret pattern was found in a comment in ${configFile}. Verify it is not a real key.`
                  : isExample
                    ? `A secret pattern resembling a placeholder was found in ${configFile}. Verify it is not a real key.`
                    : `A secret matching pattern ${pattern.source.slice(0, 20)}... was found in ${configFile}.`,
                remediation: 'Move secrets to .env and reference via environment variables.',
                context: { file: configFile },
              };
            }
            break; // one pattern match per line is enough
          }
        }
      }
      if (worstFinding) {
        findings.push(worstFinding);
      }
    }

    // Scan shell history for leaked secrets
    const historyFiles = ['.bash_history', '.zsh_history'];
    for (const histFile of historyFiles) {
      if (!context.homedir) continue;
      const histPath = path.join(context.homedir, histFile);
      const histContent = await readFileSafe(histPath);
      if (!histContent) continue;

      const histLines = histContent.split('\n');
      const recentLines = histLines.slice(-500);
      let secretsInHistory = 0;

      for (const line of recentLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const result = scanLineForSecrets(line, trimmed);
        if (result.matched && result.severity === 'critical') {
          secretsInHistory++;
          if (secretsInHistory >= 3) break;
        }
      }

      if (secretsInHistory > 0) {
        findings.push({
          findingId: 'env-exposure/shell-history-secrets',
          severity: 'warning',
          title: `Secrets found in ${histFile}`,
          detail: `Found ${secretsInHistory} potential secret(s) in shell history (~/${histFile}). These can be exposed via terminal shoulder-surfing or history file theft.`,
          remediation: `Clear secrets from history: edit ~/${histFile} or run history -c. Consider using a secrets manager.`,
          context: { file: histFile, count: secretsInHistory },
        });
      }
    }

    if (envFiles.length === 0 && !hardcodedFound && !sopsConfig) {
      findings.push({
        severity: 'pass',
        title: 'No exposed secrets detected',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
