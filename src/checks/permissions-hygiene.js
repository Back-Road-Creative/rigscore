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
            severity: 'warning',
            title: '~/.ssh directory permissions too open',
            detail: `~/.ssh has mode ${sshMode.toString(8)}, expected 700.`,
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
                severity: 'critical',
                title: `SSH private key ${entry} permissions too open`,
                detail: `${entry} has mode ${keyMode.toString(8)}, expected 600.`,
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
              severity: 'warning',
              title: `Sensitive file ${entry} is world-readable`,
              detail: `${entry} has mode ${mode.toString(8)}. Sensitive files should not be world-readable.`,
              remediation: `Run: chmod 600 ${entry}`,
            });
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
