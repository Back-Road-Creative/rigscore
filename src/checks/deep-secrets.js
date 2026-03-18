import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { scanLineForSecrets } from '../utils.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__',
  'venv', '.venv', 'coverage', '.next', '.nuxt', 'out',
]);

const INCLUDE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rb', '.java',
  '.yaml', '.yml', '.json', '.toml', '.sh',
]);

// .env.* files are included (e.g. .env.production, .env.local)
function shouldInclude(filename) {
  const ext = path.extname(filename);
  if (INCLUDE_EXTENSIONS.has(ext)) return true;
  if (filename.startsWith('.env.')) return true;
  return false;
}

async function walkFiles(dir, maxFiles) {
  const files = [];

  async function walk(current) {
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(current, entry.name));
      } else if (entry.isFile() && shouldInclude(entry.name)) {
        files.push(path.join(current, entry.name));
      }
    }
  }

  await walk(dir);
  return files;
}

export default {
  id: 'deep-secrets',
  name: 'Deep source secrets',
  category: 'secrets',
  weight: 12,

  async run(context) {
    const { cwd, deep, config } = context;
    const findings = [];

    // Only run when --deep flag is set
    if (!deep) {
      return { score: NOT_APPLICABLE_SCORE, findings: [] };
    }

    const maxFiles = config?.deepScan?.maxFiles || 1000;
    const files = await walkFiles(cwd, maxFiles);

    if (files.length === 0) {
      findings.push({
        severity: 'info',
        title: 'No source files found for deep scanning',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    if (files.length >= maxFiles) {
      findings.push({
        severity: 'info',
        title: `Deep scan capped at ${maxFiles} files`,
        detail: `Reached file limit. Configure deepScan.maxFiles in .rigscorerc.json to increase.`,
      });
    }

    let secretCount = 0;

    for (const filePath of files) {
      let content;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const relPath = path.relative(cwd, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const result = scanLineForSecrets(line, trimmed);
        if (result.matched) {
          secretCount++;
          findings.push({
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
