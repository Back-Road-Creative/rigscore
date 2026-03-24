import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { KEY_PATTERNS, AI_CONFIG_FILES } from '../constants.js';
import { readFileSafe, fileExists, statSafe, scanLineForSecrets } from '../utils.js';

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

async function isInGitignore(cwd) {
  const gitignorePath = path.join(cwd, '.gitignore');
  const content = await readFileSafe(gitignorePath);
  if (!content) return false;
  const lines = content.split('\n').map((l) => l.trim());

  // Check for negation lines that would un-ignore actual .env files
  // Skip safe negations like !.env.example, !.env.sample, !.env.template
  const hasDangerousNegation = lines.some(
    (l) => l.startsWith('!') && (l.includes('.env') || l.includes('env')) && !SAFE_NEGATION_RE.test(l),
  );
  if (hasDangerousNegation) return false;

  return lines.some((l) => ENV_GITIGNORE_PATTERNS.includes(l));
}

export default {
  id: 'env-exposure',
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
      const ignored = await isInGitignore(cwd);
      if (!ignored) {
        findings.push({
          severity: 'critical',
          title: '.env file found but NOT in .gitignore',
          detail: 'Your API keys and secrets will be committed to version control.',
          remediation: 'Add .env to .gitignore immediately.',
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
                severity: 'warning',
                title: `${envFile} is world-readable`,
                detail: `${envFile} has mode ${mode.toString(8)}. Secrets files should not be world-readable.`,
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
            severity: 'warning',
            title: `Real secret found in ${tmpl}`,
            detail: `Template file ${tmpl} contains what appears to be a real secret, not a placeholder.`,
            remediation: `Replace the real secret in ${tmpl} with a placeholder like "your_key_here".`,
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
          severity: 'critical',
          title: `GCP service account key in ${configFile}`,
          detail: `File contains both "type": "service_account" and "private_key" — this is a GCP credential file.`,
          remediation: 'Remove the service account key file from the project. Use workload identity or environment-based auth.',
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
              worstFinding = {
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
