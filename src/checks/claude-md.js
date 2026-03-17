import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { readFileSafe, readFileWithError } from '../utils.js';

const QUALITY_CHECKS = [
  {
    name: 'forbidden actions',
    pattern: /\b(never|forbidden|must not|do not|prohibited)\b/i,
    points: 4,
  },
  {
    name: 'approval gates',
    pattern: /\b(approv(al|e)|human.in.the.loop|confirm|permission)\b/i,
    points: 4,
  },
  {
    name: 'path restrictions',
    pattern: /\b(restrict|allowed?.?(path|dir)|boundar|working.?dir)/i,
    points: 3,
  },
  {
    name: 'network restrictions',
    pattern: /\b(no external|network|api.?access|external.?(call|request|fetch))/i,
    points: 3,
  },
  {
    name: 'anti-injection',
    pattern: /\b(ignore previous|prompt.?injection|instruction.?override|injection)\b/i,
    points: 3,
  },
];

const LENGTH_THRESHOLD = 50;

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /you\s+are\s+now/i,
  /disregard\s+(all\s+)?previous/i,
  /override\s+(all\s+)?instructions/i,
  /forget\s+(all\s+)?(previous|prior)/i,
  /your\s+new\s+system\s+prompt/i,
  /act\s+as\s+if/i,
  /pretend\s+you\s+are/i,
  /from\s+now\s+on\s+you/i,
];

const DEFENSIVE_WORDS = /\b(defend|prevent|block|guard|detect|refuse|flag|stop|reject|deny|halt|intercept|catch|disallow|prohibit|warn|alert|protect|mitigate|counter|resist)\b/i;

function normalizeText(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .replace(/[*_`~]/g, '');
}

const NEGATION_RE = /\b(never|not|no|don't|doesn't|isn't|without|lack|none|nothing)\b/i;

/**
 * Check whether a regex match at `matchIndex` inside `content` is negated
 * by a preceding negation word within a 50-character lookback window.
 */
function isNegatedMatch(content, matchIndex) {
  const start = Math.max(0, matchIndex - 50);
  const window = content.slice(start, matchIndex);
  return NEGATION_RE.test(window);
}

// All known AI client governance files (checked in cwd)
const GOVERNANCE_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.continuerules',
  'copilot-instructions.md',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  '.aider.conf.yml',
];

export default {
  id: 'claude-md',
  name: 'CLAUDE.md governance',
  category: 'governance',
  weight: 20,

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    // Collect all candidate paths — CLAUDE.md + all known AI client governance files
    const candidatePaths = [
      // CLAUDE.md locations (project, homedir .claude, homedir root)
      path.join(cwd, 'CLAUDE.md'),
      path.join(homedir, '.claude', 'CLAUDE.md'),
      path.join(homedir, 'CLAUDE.md'),
      // All other AI client governance files in cwd
      ...GOVERNANCE_FILES.filter((f) => f !== 'CLAUDE.md').map((f) => path.join(cwd, f)),
    ];

    // Add config-specified paths
    if (config?.paths?.claudeMd) {
      for (const p of config.paths.claudeMd) {
        candidatePaths.push(p);
      }
    }

    // Read all files, collect contents
    const contents = [];
    for (const p of candidatePaths) {
      const { content, error } = await readFileWithError(p);
      if (content) {
        contents.push(content);
      } else if (error) {
        findings.push({
          severity: 'warning',
          title: 'Governance file exists but is unreadable',
          detail: `${p} exists but could not be read (${error}). Check file permissions.`,
          remediation: `Run: chmod 644 ${p}`,
        });
      }
    }

    if (contents.length === 0) {
      findings.push({
        severity: 'critical',
        title: 'No governance file found',
        detail: 'No CLAUDE.md, .cursorrules, .windsurfrules, .continuerules, AGENTS.md, or other AI governance file found. AI agents operate without explicit boundaries.',
        remediation: 'Create a governance file (CLAUDE.md, .cursorrules, etc.) with execution boundaries, forbidden actions, and approval gates.',
      });
      return { score: calculateCheckScore(findings), findings };
    }

    // Union content for quality checks
    const combined = contents.join('\n');
    const longestContent = contents.reduce((a, b) => (a.length > b.length ? a : b));
    const lines = longestContent.split('\n');

    if (contents.length > 1) {
      findings.push({
        severity: 'pass',
        title: 'Multiple governance layers detected',
      });
    }

    // Check content length (based on longest file)
    if (lines.length < LENGTH_THRESHOLD) {
      findings.push({
        severity: 'warning',
        title: 'Governance file is short (under 50 lines)',
        detail: 'A short governance file may not provide sufficient boundaries for AI agent behavior.',
        remediation: 'Add forbidden actions, approval gates, path restrictions, and anti-injection rules.',
      });
    }

    // Check quality patterns against combined content (with negation detection)
    for (const check of QUALITY_CHECKS) {
      // Create a global copy of the pattern so we can iterate all matches
      const globalPattern = new RegExp(check.pattern.source, check.pattern.flags.includes('g') ? check.pattern.flags : check.pattern.flags + 'g');
      let match;
      let hasGenuineMatch = false;
      let hasNegatedMatch = false;

      while ((match = globalPattern.exec(combined)) !== null) {
        if (isNegatedMatch(combined, match.index)) {
          hasNegatedMatch = true;
        } else {
          hasGenuineMatch = true;
          break;
        }
      }

      if (!hasGenuineMatch) {
        if (hasNegatedMatch) {
          findings.push({
            severity: 'warning',
            title: `Governance explicitly contradicts: ${check.name}`,
            detail: `Your governance file(s) mention ${check.name} only in a negated context (e.g. "no ${check.name}"). This weakens the governance posture.`,
            remediation: `Rewrite the ${check.name} section to set positive boundaries instead of negating them.`,
          });
        } else {
          findings.push({
            severity: 'warning',
            title: `Governance file missing: ${check.name}`,
            detail: `No ${check.name} rules detected in your governance file(s).`,
            remediation: `Add ${check.name} instructions to your governance file.`,
          });
        }
      }
    }

    // Multi-line injection detection: 2-line sliding window across all governance content
    const combinedLines = combined.split('\n');
    let injectionFound = false;
    for (let i = 0; i < combinedLines.length - 1; i++) {
      const twoLines = normalizeText(combinedLines[i] + ' ' + combinedLines[i + 1]);
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(twoLines)) {
          const isDefensive = DEFENSIVE_WORDS.test(twoLines);
          findings.push({
            severity: isDefensive ? 'info' : 'warning',
            title: isDefensive
              ? 'Defensive injection reference in governance file'
              : 'Injection pattern detected in governance file',
            detail: isDefensive
              ? 'Governance file references injection patterns in a defensive context.'
              : 'Governance file contains instruction override patterns that could indicate tampering.',
            remediation: isDefensive
              ? 'No action needed — this appears to be a defensive rule.'
              : 'Review and remove suspicious instruction override patterns from governance file.',
          });
          injectionFound = true;
          break;
        }
      }
      if (injectionFound) break;
    }
    // Also check single lines
    if (!injectionFound) {
      for (const line of combinedLines) {
        const normalizedLine = normalizeText(line);
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(normalizedLine)) {
            const isDefensive = DEFENSIVE_WORDS.test(normalizedLine);
            findings.push({
              severity: isDefensive ? 'info' : 'warning',
              title: isDefensive
                ? 'Defensive injection reference in governance file'
                : 'Injection pattern detected in governance file',
              detail: isDefensive
                ? 'Governance file references injection patterns in a defensive context.'
                : 'Governance file contains instruction override patterns that could indicate tampering.',
              remediation: isDefensive
                ? 'No action needed — this appears to be a defensive rule.'
                : 'Review and remove suspicious instruction override patterns from governance file.',
            });
            injectionFound = true;
            break;
          }
        }
        if (injectionFound) break;
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Governance file contains comprehensive rules',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
