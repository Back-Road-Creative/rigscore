import fs from 'node:fs';
import path from 'node:path';

/**
 * Safe auto-remediation for rigscore findings.
 * Only performs safe, reversible fixes:
 * - Add .env to .gitignore
 * - chmod 600 on .env files
 * - chmod 700 on ~/.ssh
 * - chmod 600 on SSH private keys
 *
 * Never modifies governance content.
 */

const FIXABLE_CHECKS = {
  'env-not-gitignored': {
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
  'env-world-readable': {
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
  'ssh-dir-permissions': {
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
  'gitignore-sensitive-patterns': {
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
  'skill-file-world-writable': {
    match: (f) => f.severity === 'warning' && f.title?.includes('world-writable') && f.title?.includes('Skill file'),
    description: 'chmod 644 on world-writable skill files',
    async apply(cwd) {
      if (process.platform === 'win32') return false;
      // Find skill files in known locations
      const skillDirs = ['.claude/commands', '.claude/skills'];
      let fixed = false;
      for (const dir of skillDirs) {
        const dirPath = path.join(cwd, dir);
        let entries;
        try { entries = await fs.promises.readdir(dirPath); } catch { continue; }
        for (const entry of entries) {
          const filePath = path.join(dirPath, entry);
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mode & 0o002) {
              await fs.promises.chmod(filePath, 0o644);
              fixed = true;
            }
          } catch { /* skip */ }
        }
      }
      return fixed;
    },
  },
  'ssh-key-permissions': {
    match: (f) => f.severity === 'warning' && f.title?.includes('SSH') && f.title?.includes('key') && f.title?.includes('permission'),
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
};

/**
 * Analyze scan results and return a list of applicable fixes.
 * Each fix: { id, description, finding }
 */
export function findApplicableFixes(results) {
  const fixes = [];
  for (const checkResult of results) {
    for (const finding of checkResult.findings) {
      for (const [id, fixer] of Object.entries(FIXABLE_CHECKS)) {
        if (fixer.match(finding)) {
          fixes.push({ id, description: fixer.description, finding, checkId: checkResult.id });
        }
      }
    }
  }
  return fixes;
}

/**
 * Apply fixes. Returns { applied: string[], skipped: string[] }.
 */
export async function applyFixes(fixes, cwd, homedir) {
  const applied = [];
  const skipped = [];

  for (const fix of fixes) {
    const fixer = FIXABLE_CHECKS[fix.id];
    if (!fixer) {
      skipped.push(fix.description);
      continue;
    }
    try {
      const success = await fixer.apply(cwd, homedir);
      if (success) {
        applied.push(fix.description);
      } else {
        skipped.push(fix.description + ' (already applied or not applicable)');
      }
    } catch (err) {
      skipped.push(fix.description + ` (error: ${err.message})`);
    }
  }

  return { applied, skipped };
}
