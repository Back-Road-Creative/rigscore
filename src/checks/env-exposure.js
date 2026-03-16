import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { readFileSafe, fileExists, statSafe } from '../utils.js';

const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/,         // Anthropic
  /AKIA[0-9A-Z]{16}/,                   // AWS access key
  /ghp_[a-zA-Z0-9]{36}/,               // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/,               // GitHub OAuth
  /xoxb-[a-zA-Z0-9-]+/,               // Slack bot token
  /xoxp-[a-zA-Z0-9-]+/,               // Slack user token
  /sk-[a-zA-Z0-9]{20,}/,               // OpenAI-style
  /glpat-[a-zA-Z0-9_-]{20,}/,          // GitLab PAT
];

const CONFIG_FILES = [
  'CLAUDE.md',
  '.claude/settings.json',
  '.mcp.json',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.continuerules',
  '.aider.conf.yml',
  'copilot-instructions.md',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'config.js',
  'config.ts',
  'config.json',
];

const ENV_GITIGNORE_PATTERNS = [
  '.env',
  '.env*',
  '*.env',
  '**/.env',
  '.env.*',
  '.env.local',
  '.env.*.local',
];

async function isInGitignore(cwd) {
  const gitignorePath = path.join(cwd, '.gitignore');
  const content = await readFileSafe(gitignorePath);
  if (!content) return false;
  const lines = content.split('\n').map((l) => l.trim());

  // Check for negation lines that would un-ignore .env
  const hasNegation = lines.some((l) => l.startsWith('!') && (l.includes('.env') || l.includes('env')));
  if (hasNegation) return false;

  return lines.some((l) => ENV_GITIGNORE_PATTERNS.includes(l));
}

export default {
  id: 'env-exposure',
  name: 'Secret exposure',
  category: 'secrets',
  weight: 20,

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
    const COMMENT_PREFIXES = ['#', '//', '<!--'];
    let hardcodedFound = false;
    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(cwd, configFile);
      const content = await readFileSafe(filePath);
      if (!content) continue;

      const fileLines = content.split('\n');
      let foundInFile = false;
      for (const line of fileLines) {
        const trimmed = line.trim();
        const isComment = COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));

        for (const pattern of KEY_PATTERNS) {
          if (pattern.test(line)) {
            hardcodedFound = true;
            foundInFile = true;
            findings.push({
              severity: isComment ? 'info' : 'critical',
              title: isComment
                ? `API key pattern in comment in ${configFile}`
                : `Hardcoded API key found in ${configFile}`,
              detail: isComment
                ? `A secret pattern was found in a comment in ${configFile}. Verify it is not a real key.`
                : `A secret matching pattern ${pattern.source.slice(0, 20)}... was found in ${configFile}.`,
              remediation: 'Move secrets to .env and reference via environment variables.',
            });
            break;
          }
        }
        if (foundInFile) break; // one finding per file
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
