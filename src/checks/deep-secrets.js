import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { scanLineForSecrets, walkDirSafe } from '../utils.js';

// Directories skipped wholesale during deep scanning. Expanded beyond the
// historical set so the removal of the blanket `startsWith('.')` guard below
// doesn't recurse into machine-generated dotfolders like `.cache/` or `.idea/`.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__',
  'venv', '.venv', 'coverage', '.next', '.nuxt', 'out',
  '.cache', '.idea', '.vscode', '.vs', '.gradle', '.mvn',
  '.turbo', '.parcel-cache', '.yarn', '.pnpm-store', '.tox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.ipynb_checkpoints',
  '.svelte-kit', '.astro', '.angular', '.terraform', '.serverless',
]);

const INCLUDE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rb', '.java',
  '.yaml', '.yml', '.json', '.toml', '.sh',
]);

// .env.* files are included (e.g. .env.production, .env.local)
// Skip test/spec files — they legitimately contain example secrets for pattern testing
const TEST_FILE_RE = /\.(test|spec)\./;

function shouldIncludeByName(filename) {
  if (TEST_FILE_RE.test(filename)) return false;
  const ext = path.extname(filename);
  if (INCLUDE_EXTENSIONS.has(ext)) return true;
  if (filename.startsWith('.env.')) return true;
  return false;
}

// Per-file size cap (A5) — skip reading pathological huge files to keep
// deep-scan bounded. Override via config.limits.maxFileBytes.
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

// Stable provider labels keyed by a leading-literal substring of each
// KEY_PATTERN regex source. Echoing raw regex source into a finding body
// leaks pattern shape into SARIF / CI logs (and the body drifts whenever
// a pattern is tightened); the label fixes both issues. Unknown patterns
// fall back to a generic "credential" label.
const PATTERN_LABEL_RULES = [
  ['sk-ant-', 'Anthropic API key'],
  ['AKIA', 'AWS access key'], ['ASIA', 'AWS STS temporary credentials'],
  ['ghp_', 'GitHub personal access token'], ['gho_', 'GitHub OAuth token'],
  ['xoxb-', 'Slack bot token'], ['xoxp-', 'Slack user token'], ['xox[aers]-', 'Slack token'],
  ['sk-(?:proj', 'OpenAI API key'], ['glpat-', 'GitLab personal access token'],
  ['sk_live_', 'Stripe secret key (live)'], ['sk_test_', 'Stripe secret key (test)'],
  ['rk_live_', 'Stripe restricted key'], ['pk_live_', 'Stripe publishable key'],
  ['SG\\.', 'SendGrid API key'], ['SK[0-9a-f]', 'Twilio API key'],
  ['AIzaSy', 'Firebase / Google API key'], ['dop_v1_', 'DigitalOcean token'],
  ['key-[a-f0-9]', 'Mailgun API key'], ['npm_', 'npm access token'],
  ['pypi-', 'PyPI API token'], ['hf_', 'Hugging Face token'],
  ['mongodb\\+srv', 'MongoDB connection string'], ['vercel_', 'Vercel token'],
  ['sbp_', 'Supabase service role key'], ['eyJhbGciOiJI', 'Supabase JWT'],
  ['cf_', 'Cloudflare API token'], ['railway_', 'Railway token'],
  ['pscale_tkn_', 'PlanetScale token'], ['neon_', 'Neon API key'],
  ['lin_api_', 'Linear API key'], ['r8_', 'Replicate API token'],
  ['tvly-', 'Tavily API key'], ['whsec_', 'Webhook signing secret'],
  ['AGE-SECRET-KEY-1', 'AGE encryption key'], ['dd[a-z]', 'Datadog API key'],
  ['op:\\/\\/', '1Password CLI reference'], ['hvs\\.', 'HashiCorp Vault token'],
  ['AKCp', 'JFrog Artifactory token'], ['"auth"', 'Docker registry auth token'],
];

export function labelForPattern(pattern) {
  const src = pattern?.source || '';
  for (const [needle, label] of PATTERN_LABEL_RULES) {
    if (src.includes(needle)) return label;
  }
  return 'credential';
}

export default {
  id: 'deep-secrets',
  enforcementGrade: 'pattern',
  name: 'Deep source secrets',
  category: 'secrets',

  async run(context) {
    const { cwd, deep, config } = context;
    const findings = [];

    // Only run when --deep flag is set
    if (!deep) {
      return { score: NOT_APPLICABLE_SCORE, findings: [] };
    }

    const maxFiles = config?.deepScan?.maxFiles || 1000;
    const maxDepth = config?.limits?.maxWalkDepth || 50;
    const maxFileBytes = config?.limits?.maxFileBytes || DEFAULT_MAX_FILE_BYTES;

    // Project-configured excludes (e.g. vendored themes, generated output,
    // nested repos) stack on top of the hardcoded SKIP_DIRS so monorepos can
    // scope the deep scan to first-party source via .rigscorerc.json.
    const extraSkip = config?.deepScan?.excludeDirs || [];
    const skipDirs = extraSkip.length ? new Set([...SKIP_DIRS, ...extraSkip]) : SKIP_DIRS;

    const { files, loopDetected, truncated } = await walkDirSafe(cwd, {
      maxFiles,
      maxDepth,
      skipDirs,
      // C5: allow walking into dotfolders like `config/.env.production`'s
      // parent or `.github/`. The expanded SKIP_DIRS (.cache, .idea, .venv,
      // .next, etc.) is the authoritative allowlist for dangerous dotdirs.
      skipHidden: false,
      shouldInclude: (_full, dirent) => shouldIncludeByName(dirent.name),
    });

    if (loopDetected) {
      findings.push({
        findingId: 'deep-secrets/symlink-loop-skipped',
        severity: 'info',
        title: 'Deep scan skipped one or more symlink loops',
        detail: 'A symlink cycle was detected and safely skipped during traversal.',
      });
    }

    if (files.length === 0) {
      findings.push({
        findingId: 'deep-secrets/no-source-files',
        severity: 'info',
        title: 'No source files found for deep scanning',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    // WARNING, not info: files past the cap were never read, so a secret in any of
    // them is invisible. At `info` this did not dent the score, and a tree holding a
    // live key scored 98 — "I stopped looking" rendered as "clean".
    if (truncated) {
      findings.push({
        findingId: 'deep-secrets/file-cap-reached',
        severity: 'warning',
        title: `Deep scan capped at ${maxFiles} files`,
        detail: `Reached the file limit and stopped walking — files beyond the cap were NOT scanned, so this result cannot be read as "no secrets". Configure deepScan.maxFiles in .rigscorerc.json to increase.`,
        remediation: 'Raise `deepScan.maxFiles` in `.rigscorerc.json`, or narrow the scan root via `deepScan.excludeDirs` so the whole tree fits under the cap.',
      });
    }

    let secretCount = 0;
    let oversizeCount = 0;

    for (const filePath of files) {
      // A5: skip pathologically large files up front.
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) {
        oversizeCount++;
        continue;
      }

      let content;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const relPath = path.relative(cwd, filePath);

      // GCP service account dual-field detection
      if (filePath.endsWith('.json') &&
          content.includes('"type"') && content.includes('service_account') &&
          content.includes('"private_key"')) {
        secretCount++;
        findings.push({
          findingId: 'deep-secrets/gcp-service-account-key',
          severity: 'critical',
          title: `GCP service account key in ${relPath}`,
          detail: 'File contains both "type": "service_account" and "private_key".',
          remediation: 'Remove the service account key file. Use workload identity or environment-based auth.',
        });
        continue; // skip line-by-line scan for this file
      }

      // Cap output at one finding per file, but DO NOT stop at the first
      // match if it's only an INFO (comment/example) — a real CRITICAL on a
      // later line must be allowed to escalate. Without this, a leading
      // `// Old key: sk-...` line would mask a real hardcoded secret a few
      // lines below and silently downgrade the finding to info.
      let bestInfo = null;
      let criticalFinding = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const result = scanLineForSecrets(line, trimmed);
        if (!result.matched) continue;

        // Use a stable provider label rather than leaking the raw regex
        // source — both because the regex pattern can itself encode hints
        // about a secret's structure (and ends up in SARIF / CI logs) and
        // because a truncated slice changes whenever a pattern is tightened,
        // making finding bodies unstable across rigscore upgrades.
        const providerLabel = labelForPattern(result.pattern);
        if (result.severity === 'critical') {
          criticalFinding = {
            findingId: 'deep-secrets/hardcoded-secret',
            severity: 'critical',
            title: `Hardcoded secret in ${relPath}:${i + 1}`,
            detail: `Detected provider: ${providerLabel}`,
            remediation: 'Move secrets to environment variables or a secrets manager.',
          };
          break; // real secret found — no need to keep scanning this file
        }
        // INFO match: remember the first one but keep scanning in case a
        // CRITICAL appears later in the same file.
        if (!bestInfo) {
          bestInfo = {
            findingId: 'deep-secrets/possible-secret-comment',
            severity: 'info',
            title: `Possible secret (comment/example) in ${relPath}:${i + 1}`,
            detail: `Detected provider: ${providerLabel}`,
            remediation: 'Move secrets to environment variables or a secrets manager.',
          };
        }
      }

      const fileFinding = criticalFinding || bestInfo;
      if (fileFinding) {
        secretCount++;
        findings.push(fileFinding);
      }
    }

    if (oversizeCount > 0) {
      findings.push({
        findingId: 'deep-secrets/oversize-skipped',
        severity: 'info',
        title: `Deep scan skipped ${oversizeCount} file(s) over ${maxFileBytes} bytes`,
        detail: 'Large files were skipped for performance. Override via config.limits.maxFileBytes.',
      });
    }

    // Only a scan that actually reached every candidate file may call itself
    // clean. A truncated walk already carries the warning above; adding "clean"
    // next to it would be the exact contradiction this fix exists to remove.
    if (secretCount === 0 && !truncated) {
      findings.push({
        severity: 'pass',
        title: `Deep scan clean — ${files.length} files checked`,
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
