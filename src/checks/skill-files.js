import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe } from '../utils.js';

// Skill file paths = governance files minus CLAUDE.md (handled by claude-md check)
const SKILL_FILE_PATHS = GOVERNANCE_FILES.filter((f) => f !== 'CLAUDE.md');

const SKILL_DIRS = [
  '.claude/commands',
  '.claude/skills',
];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /you\s+are\s+now/i,
  /disregard\s+(all\s+)?previous/i,
  /override\s+(all\s+)?instructions/i,
  /forget\s+(all\s+)?(previous|prior)/i,
  /your\s+new\s+system\s+prompt/i,
  /act\s+as\s+if\s+you\s+(?:are|were|have|had|can)/i,
  /pretend\s+you\s+are/i,
  /from\s+now\s+on\s+you/i,
];

const SHELL_EXEC_PATTERNS = [
  /\brun\s+`[^`]*`/i,
  /\bexecute\s+(the\s+)?(shell|bash|command)/i,
  /\bcurl\s+http/i,
  /\bwget\s+http/i,
];

const URL_PATTERN = /https?:\/\/[^\s"')\]]+/g;
// Anchored base64 pattern — requires whitespace boundary to reduce false positives
const BASE64_PATTERN = /(?:^|\s)[A-Za-z0-9+/]{50,}={0,2}(?:\s|$)/m;

const DEFENSIVE_WORDS = /\b(defend|prevent|block|guard|detect|refuse|flag|stop|reject|deny|halt|intercept|catch|disallow|prohibit|warn|alert|protect|mitigate|counter|resist)\b/i;

function normalizeText(text) {
  return text
    .normalize('NFKC')
    // Strip zero-width characters
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    // Strip markdown formatting chars
    .replace(/[*_`~]/g, '');
}

export default {
  id: 'skill-files',
  name: 'Skill file safety',
  category: 'supply-chain',
  weight: 8,

  async run(context) {
    const { cwd, config } = context;
    const findings = [];
    const filesToScan = [];

    // Collect individual skill files
    for (const relPath of SKILL_FILE_PATHS) {
      const fullPath = path.join(cwd, relPath);
      const content = await readFileSafe(fullPath);
      if (content) {
        filesToScan.push({ path: relPath, fullPath, content });
      }
    }

    // Add config-specified skill files
    if (config?.paths?.skillFiles) {
      for (const p of config.paths.skillFiles) {
        const content = await readFileSafe(p);
        if (content) {
          filesToScan.push({ path: p, fullPath: p, content });
        }
      }
    }

    // Collect files from skill directories
    for (const dir of SKILL_DIRS) {
      const dirPath = path.join(cwd, dir);
      try {
        const entries = await fs.promises.readdir(dirPath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const fullPath = path.join(dirPath, entry);
          const content = await readFileSafe(fullPath);
          if (content) {
            filesToScan.push({ path: path.join(dir, entry), fullPath, content });
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }

    if (filesToScan.length === 0) {
      findings.push({
        severity: 'info',
        title: 'No skill files found',
        detail: 'No AI agent instruction files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    for (const file of filesToScan) {
      const lines = file.content.split('\n');

      // Check injection patterns — line by line with defensive word downgrade
      let injectionFound = false;
      for (const line of lines) {
        const normalizedLine = normalizeText(line);
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(normalizedLine)) {
            const isDefensive = DEFENSIVE_WORDS.test(normalizedLine);
            findings.push({
              severity: isDefensive ? 'info' : 'critical',
              title: isDefensive
                ? `Defensive injection reference in ${file.path}`
                : `Injection pattern found in ${file.path}`,
              detail: isDefensive
                ? 'File references injection patterns in a defensive context.'
                : 'File contains instruction override patterns that could hijack AI agent behavior.',
              remediation: isDefensive
                ? 'No action needed — this appears to be a defensive rule.'
                : 'Remove instruction override patterns. If this is a legitimate rule, rephrase it.',
            });
            injectionFound = true;
            break;
          }
        }
        if (injectionFound) break; // one finding per file for injection
      }

      // Multi-line injection detection: 2-line sliding windows
      if (!injectionFound) {
        for (let i = 0; i < lines.length - 1; i++) {
          const twoLines = normalizeText(lines[i] + ' ' + lines[i + 1]);
          for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(twoLines)) {
              const isDefensive = DEFENSIVE_WORDS.test(twoLines);
              findings.push({
                severity: isDefensive ? 'info' : 'critical',
                title: isDefensive
                  ? `Defensive injection reference in ${file.path}`
                  : `Injection pattern found in ${file.path}`,
                detail: isDefensive
                  ? 'File references injection patterns in a defensive context.'
                  : 'File contains instruction override patterns that could hijack AI agent behavior.',
                remediation: isDefensive
                  ? 'No action needed — this appears to be a defensive rule.'
                  : 'Remove instruction override patterns. If this is a legitimate rule, rephrase it.',
              });
              injectionFound = true;
              break;
            }
          }
          if (injectionFound) break;
        }
      }

      // Check shell execution patterns
      for (const pattern of SHELL_EXEC_PATTERNS) {
        if (pattern.test(file.content)) {
          findings.push({
            severity: 'warning',
            title: `Shell execution instructions in ${file.path}`,
            detail: 'File contains instructions to execute shell commands.',
            remediation: 'Review shell execution instructions carefully for security.',
          });
          break;
        }
      }

      // Check external URLs — only WARNING for HTTP (non-TLS)
      const urls = file.content.match(URL_PATTERN);
      if (urls && urls.length > 0) {
        const httpUrls = urls.filter((u) => u.startsWith('http://'));
        const httpsUrls = urls.filter((u) => u.startsWith('https://'));
        if (httpUrls.length > 0) {
          findings.push({
            severity: 'warning',
            title: `Non-TLS URLs found in ${file.path}`,
            detail: `${httpUrls.length} HTTP URL(s) found. Non-TLS URLs could be intercepted.`,
            remediation: 'Use HTTPS for all external URLs.',
          });
        }
        if (httpsUrls.length > 0) {
          findings.push({
            severity: 'info',
            title: `HTTPS URLs found in ${file.path}`,
            detail: `${httpsUrls.length} HTTPS URL(s) found.`,
            remediation: 'Verify all URLs are legitimate and necessary.',
          });
        }
      }

      // Check base64 content
      if (BASE64_PATTERN.test(file.content)) {
        findings.push({
          severity: 'warning',
          title: `Possible encoded content in ${file.path}`,
          detail: 'File contains what appears to be base64-encoded content.',
          remediation: 'Decode and review the content. Remove if not needed.',
        });
      }

      // Check file permissions (Linux only)
      if (process.platform !== 'win32') {
        const fileStat = await statSafe(file.fullPath);
        if (fileStat) {
          const mode = fileStat.mode & 0o777;
          // World-writable check: "others" write bit
          if (mode & 0o002) {
            findings.push({
              severity: 'warning',
              title: `Skill file ${file.path} is world-writable`,
              detail: `${file.path} has mode ${mode.toString(8)}. World-writable skill files can be tampered with.`,
              remediation: `Run: chmod 644 ${file.path}`,
            });
          }
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'All skill files appear clean',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
