import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { AI_CONFIG_FILES } from '../constants.js';
import { statSafe } from '../utils.js';

const SENSITIVE_PATTERNS = ['*.pem', '*.key', '*credentials*'];

// Use the centralized config files list for ownership checks
const GOVERNANCE_FILES = AI_CONFIG_FILES;

// Naive glob matching — only handles `*foo*`, `*.ext`, and exact match.
// Current patterns (*.pem, *.key, *credentials*) all work with this logic.
// If the pattern list expands to need ** or ? globs, switch to `minimatch`.
function matchesGlob(filename, pattern) {
  if (pattern.startsWith('*') && pattern.endsWith('*')) {
    return filename.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith('*')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern;
}

export const fixes = [
  {
    id: 'ssh-dir-permissions',
    findingIds: ['permissions-hygiene/ssh-dir-permissions'],
    match: (f) => f.severity === 'warning' && f.title?.includes('.ssh') && f.title?.includes('permission'),
    description: 'chmod 700 on ~/.ssh',
    async apply(_cwd, homedir) {
      if (process.platform === 'win32') return false;
      const sshDir = path.join(homedir, '.ssh');
      try {
        await fs.promises.chmod(sshDir, 0o700);
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    id: 'ssh-key-permissions',
    findingIds: ['permissions-hygiene/ssh-key-permissions'],
    match: (f) => f.severity === 'critical' && f.title?.includes('SSH') && f.title?.includes('key') && f.title?.includes('permission'),
    description: 'chmod 600 on SSH private keys',
    async apply(_cwd, homedir) {
      if (process.platform === 'win32') return false;
      const sshDir = path.join(homedir, '.ssh');
      let fixed = false;
      try {
        const entries = await fs.promises.readdir(sshDir);
        for (const entry of entries) {
          if (entry.startsWith('id_') && !entry.endsWith('.pub')) {
            const keyPath = path.join(sshDir, entry);
            try {
              const stat = await fs.promises.stat(keyPath);
              if (stat.mode & 0o077) {
                await fs.promises.chmod(keyPath, 0o600);
                fixed = true;
              }
            } catch {
              // skip
            }
          }
        }
      } catch {
        // ssh dir doesn't exist
      }
      return fixed;
    },
  },
  {
    id: 'gitignore-sensitive-patterns',
    findingIds: ['permissions-hygiene/sensitive-file-world-readable'],
    match: (f) => f.severity === 'warning' && f.title?.includes('world-readable') && (f.title?.includes('.pem') || f.title?.includes('.key')),
    description: 'Add *.pem, *.key to .gitignore',
    async apply(cwd) {
      const gitignorePath = path.join(cwd, '.gitignore');
      let content = '';
      try {
        content = await fs.promises.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist yet
      }
      const lines = content.split('\n').map(l => l.trim());
      const toAdd = [];
      if (!lines.includes('*.pem')) toAdd.push('*.pem');
      if (!lines.includes('*.key')) toAdd.push('*.key');
      if (toAdd.length === 0) return false;
      const newline = content && !content.endsWith('\n') ? '\n' : '';
      await fs.promises.writeFile(gitignorePath, content + newline + toAdd.join('\n') + '\n');
      return true;
    },
  },
];

export default {
  id: 'permissions-hygiene',
  name: 'Permissions hygiene',
  category: 'process',

  async run(context) {
    const { cwd, homedir } = context;
    const findings = [];
    const isPosix = process.platform !== 'win32';

    if (!isPosix) {
      // Explicitly report that permission checks were skipped
      findings.push({
        severity: 'skipped',
        title: 'File permission checks skipped on Windows',
        detail: 'POSIX file permission checks (SSH keys, sensitive files, governance ownership) are not available on Windows. Consider using icacls to verify permissions manually.',
      });
    }

    if (isPosix) {
      // 1. SSH key permissions
      const sshDir = path.join(homedir, '.ssh');
      const sshStat = await statSafe(sshDir);
      if (sshStat) {
        const sshMode = sshStat.mode & 0o777;
        if (sshMode !== 0o700) {
          findings.push({
            findingId: 'permissions-hygiene/ssh-dir-permissions',
            severity: 'warning',
            title: '~/.ssh directory permissions too open',
            detail: `~/.ssh has mode ${sshMode.toString(8)}, expected 700.`,
            evidence: `~/.ssh mode ${sshMode.toString(8)}`,
            remediation: 'Run: chmod 700 ~/.ssh',
          });
        }

        // Check individual key files
        try {
          const sshEntries = await fs.promises.readdir(sshDir);
          for (const entry of sshEntries) {
            if (!entry.startsWith('id_') || entry.endsWith('.pub')) continue;
            const keyPath = path.join(sshDir, entry);
            const keyStat = await statSafe(keyPath);
            if (!keyStat || !keyStat.isFile()) continue;
            const keyMode = keyStat.mode & 0o777;
            if (keyMode !== 0o600) {
              findings.push({
                findingId: 'permissions-hygiene/ssh-key-permissions',
                severity: 'critical',
                title: `SSH private key ${entry} permissions too open`,
                detail: `${entry} has mode ${keyMode.toString(8)}, expected 600.`,
                evidence: `~/.ssh/${entry} mode ${keyMode.toString(8)}`,
                remediation: `Run: chmod 600 ~/.ssh/${entry}`,
              });
            }
          }
        } catch {
          // Can't read .ssh dir — not our problem
        }
      }

      // 2. Sensitive files in cwd that are world-readable
      try {
        const entries = await fs.promises.readdir(cwd);
        for (const entry of entries) {
          const isSensitive = SENSITIVE_PATTERNS.some((p) => matchesGlob(entry, p));
          if (!isSensitive) continue;
          const filePath = path.join(cwd, entry);
          const fileStat = await statSafe(filePath);
          if (!fileStat || !fileStat.isFile()) continue;
          const mode = fileStat.mode & 0o777;
          // World-readable means the "others" read bit is set
          if (mode & 0o004) {
            findings.push({
              findingId: 'permissions-hygiene/sensitive-file-world-readable',
              severity: 'warning',
              title: `Sensitive file ${entry} is world-readable`,
              detail: `${entry} has mode ${mode.toString(8)}. Sensitive files should not be world-readable.`,
              evidence: `${entry} mode ${mode.toString(8)}`,
              remediation: `Run: chmod 600 ${entry}`,
            });
          }
        }
      } catch {
        // Can't read cwd — skip
      }

      // 2b. Sensitive files in subdirectories (depth 2) — .pem/.key only
      try {
        const entries = await fs.promises.readdir(cwd, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
          const subDir = path.join(cwd, entry.name);
          let subEntries;
          try { subEntries = await fs.promises.readdir(subDir); } catch { continue; }
          for (const subEntry of subEntries) {
            if (!subEntry.endsWith('.pem') && !subEntry.endsWith('.key')) continue;
            const filePath = path.join(subDir, subEntry);
            const fileStat = await statSafe(filePath);
            if (!fileStat || !fileStat.isFile()) continue;
            const mode = fileStat.mode & 0o777;
            if (mode & 0o004) {
              findings.push({
                findingId: 'permissions-hygiene/sensitive-file-world-readable',
                severity: 'warning',
                title: `Sensitive file ${entry.name}/${subEntry} is world-readable`,
                detail: `${entry.name}/${subEntry} has mode ${mode.toString(8)}. Sensitive files should not be world-readable.`,
                evidence: `${entry.name}/${subEntry} mode ${mode.toString(8)}`,
                remediation: `Run: chmod 600 ${entry.name}/${subEntry}`,
              });
            }
          }
        }
      } catch {
        // Can't read cwd — skip
      }

      // 3. Governance file ownership consistency
      const uids = new Set();
      for (const relPath of GOVERNANCE_FILES) {
        const fullPath = path.join(cwd, relPath);
        const fileStat = await statSafe(fullPath);
        if (fileStat) {
          uids.add(fileStat.uid);
        }
      }
      if (uids.size > 1) {
        findings.push({
          severity: 'warning',
          title: 'Governance files have mixed file ownership',
          detail: `Found ${uids.size} different UIDs across governance files. This may indicate unauthorized modifications.`,
          remediation: 'Ensure all governance files are owned by the same user.',
        });
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'File permissions look secure',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
