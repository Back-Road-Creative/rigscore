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

    const { files, loopDetected } = await walkDirSafe(cwd, {
      maxFiles,
      maxDepth,
      skipDirs: SKIP_DIRS,
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

    if (files.length >= maxFiles) {
      findings.push({
        findingId: 'deep-secrets/file-cap-reached',
        severity: 'info',
        title: `Deep scan capped at ${maxFiles} files`,
        detail: `Reached file limit. Configure deepScan.maxFiles in .rigscorerc.json to increase.`,
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

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const result = scanLineForSecrets(line, trimmed);
        if (result.matched) {
          secretCount++;
          findings.push({
            findingId: result.severity === 'critical' ? 'deep-secrets/hardcoded-secret' : 'deep-secrets/possible-secret-comment',
            severity: result.severity,
            title: result.severity === 'critical'
              ? `Hardcoded secret in ${relPath}:${i + 1}`
              : `Possible secret (comment/example) in ${relPath}:${i + 1}`,
            detail: `Pattern: ${result.pattern.source.slice(0, 30)}...`,
            remediation: 'Move secrets to environment variables or a secrets manager.',
          });
          break; // one finding per file is enough
        }
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

    if (secretCount === 0) {
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
